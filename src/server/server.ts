import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { context, reddit, redis } from '@devvit/web/server';
import type {
  OnCommentReportRequest,
  OnCommentSubmitRequest,
  OnPostReportRequest,
  OnPostSubmitRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { SENSITIVITY, getDetector } from './core/sharedDetector.ts';
import type { Event } from './core/types.ts';

const FIRES_KEY = 'fmap:fires';
const BUCKETS_KEY = 'fmap:buckets';
const SNOOZED_KEY = 'fmap:snoozed';
const BUCKET_TTL_MS = 24 * 60 * 60 * 1000;
const SNOOZE_MS = 15 * 60 * 1000;

async function readSnoozedIds(nowMs: number): Promise<Set<string>> {
  await redis.zRemRangeByScore(SNOOZED_KEY, 0, nowMs);
  const r = await redis.zRange(SNOOZED_KEY, 0, -1);
  return new Set(r.map((x) => x.member));
}

async function trackBucket(bk: string): Promise<void> {
  await redis.zAdd(BUCKETS_KEY, { score: Date.now(), member: bk });
}

async function readBuckets(nowMs: number): Promise<string[]> {
  await redis.zRemRangeByScore(BUCKETS_KEY, 0, nowMs - BUCKET_TTL_MS);
  const r = await redis.zRange(BUCKETS_KEY, 0, -1);
  return r.map((x) => x.member);
}

async function ingest(ev: Event): Promise<void> {
  const det = getDetector();
  await det.ingest(ev);
  if (ev.kind === 'post' || ev.kind === 'comment') {
    await trackBucket(`user:${ev.authorId}`);
  }
  if (ev.kind === 'report' && ev.targetId) {
    await trackBucket(`target:${ev.targetId}`);
  }
}

async function onPostSubmit(req: IncomingMessage): Promise<TriggerResponse> {
  const e = await readJSON<OnPostSubmitRequest>(req);
  const authorId = e.author?.id ?? e.post?.authorId ?? 'unknown';
  const text = `${e.post?.title ?? ''}\n\n${e.post?.selftext ?? ''}`.trim();
  await ingest({
    kind: 'post',
    ts: Date.now(),
    authorId,
    text,
    url: e.post?.permalink,
    subreddit: e.subreddit?.name ?? context.subredditName ?? '',
  });
  return {};
}

async function onCommentSubmit(req: IncomingMessage): Promise<TriggerResponse> {
  const e = await readJSON<OnCommentSubmitRequest>(req);
  const authorId = e.author?.id ?? e.comment?.author ?? 'unknown';
  await ingest({
    kind: 'comment',
    ts: Date.now(),
    authorId,
    text: e.comment?.body ?? '',
    url: e.comment?.permalink,
    subreddit: e.subreddit?.name ?? context.subredditName ?? '',
  });
  return {};
}

// PostReport / CommentReport don't expose reporter identity, so we only
// track per-target bursts (not coordinated-reporter clusters).
async function ingestReport(
  targetId: string | undefined,
  subreddit: string,
): Promise<TriggerResponse> {
  if (targetId) {
    await ingest({
      kind: 'report',
      ts: Date.now(),
      authorId: 'unknown',
      targetId,
      subreddit,
    });
  }
  return {};
}

async function onPostReport(req: IncomingMessage): Promise<TriggerResponse> {
  const e = await readJSON<OnPostReportRequest>(req);
  return ingestReport(e.post?.id, e.subreddit?.name ?? context.subredditName ?? '');
}

async function onCommentReport(req: IncomingMessage): Promise<TriggerResponse> {
  const e = await readJSON<OnCommentReportRequest>(req);
  return ingestReport(e.comment?.id, e.subreddit?.name ?? context.subredditName ?? '');
}

async function onSchedulerTick(): Promise<TriggerResponse> {
  const det = getDetector();
  const now = Date.now();
  const buckets = await readBuckets(now);
  await det.tickBaseline(now, buckets);
  const fires = await det.scan(now);
  // Only overwrite the published fires list when we have something to show.
  // Why: baseline absorbs the spike within a minute, so a subsequent tick would
  // wipe valid fires with []. Keep last non-empty result until the next real hit.
  if (fires.length > 0) {
    await redis.set(FIRES_KEY, JSON.stringify(fires.slice(0, 50)));
  }
  console.log(`[fmap] tick: buckets=${buckets.length} fires=${fires.length} kinds=${fires.map((f) => f.kind).join(',')}`);
  return {};
}

async function onAppInstall(): Promise<{ showToast?: { text: string } }> {
  await reddit.submitCustomPost({ title: 'FirefighterMap — Live Fires' });
  return { showToast: { text: 'FirefighterMap installed.' } };
}

async function onMenuOpenDashboard(): Promise<{
  showToast?: { text: string; appearance?: 'success' };
  navigateTo?: string;
}> {
  const post = await reddit.submitCustomPost({ title: 'FirefighterMap — Live Fires' });
  return {
    showToast: { text: 'Dashboard post created.', appearance: 'success' },
    navigateTo: post.url,
  };
}

async function onApiFires(): Promise<{
  fires: unknown[];
  sub: string;
  sensitivity: string;
  generatedAt: string;
  activity: number[];
}> {
  const now = Date.now();
  const raw = await redis.get(FIRES_KEY);
  const activity = await getDetector().globalActivity(now, 60);
  const parsed = raw ? (JSON.parse(raw) as Array<{ id: string }>) : [];
  const snoozed = await readSnoozedIds(now);
  const visible = parsed.filter((f) => !snoozed.has(f.id));
  console.log(`[fmap] /api/fires: FIRES_KEY=${raw ? raw.length + 'B' : 'null'} fires=${parsed.length} visible=${visible.length} snoozed=${snoozed.size} activity_total=${activity.reduce((a: number, b: number) => a + b, 0)}`);
  return {
    fires: visible,
    sub: context.subredditName ?? 'unknown',
    sensitivity: SENSITIVITY.name,
    generatedAt: new Date().toISOString(),
    activity,
  };
}

async function onApiSnooze(req: IncomingMessage): Promise<{ ok: boolean; snoozedUntil: number }> {
  const body = await readJSON<{ id?: string }>(req);
  const id = body.id?.trim();
  if (!id) throw new Error('missing fire id');
  const until = Date.now() + SNOOZE_MS;
  await redis.zAdd(SNOOZED_KEY, { score: until, member: id });
  console.log(`[fmap] snooze: id=${id} until=${new Date(until).toISOString()}`);
  return { ok: true, snoozedUntil: until };
}

type StoredFire = {
  id: string;
  kind: string;
  severity: string;
  score: number;
  zscore: number;
  observed: number;
  baseline: number;
  subjects: string[];
  explanation: string;
};

const KIND_LABELS: Record<string, string> = {
  user_burst: 'User burst',
  target_report_burst: 'Report burst',
  topic_spike: 'Topic spike',
  near_duplicate_wave: 'Near-duplicate wave',
  coordinated_reporters: 'Coordinated reporters',
};

function buildModmailBody(fire: StoredFire, sub: string): { subject: string; body: string } {
  const kindLabel = KIND_LABELS[fire.kind] ?? fire.kind;
  const subjectChips = fire.subjects.slice(0, 8).map((s) => `\`${s}\``).join(', ');
  const more = fire.subjects.length > 8 ? ` (+${fire.subjects.length - 8} more)` : '';
  const subject = `[FirefighterMap] ${kindLabel} — ${fire.severity.toUpperCase()} (z=${fire.zscore.toFixed(1)})`;
  const body = [
    `**FirefighterMap detected a ${fire.severity}-severity ${kindLabel.toLowerCase()} in r/${sub}.**`,
    '',
    fire.explanation,
    '',
    '**Evidence**',
    `- Subjects: ${subjectChips}${more}`,
    `- Observed: ${fire.observed}`,
    `- Baseline: ${fire.baseline.toFixed(1)} (z-score ${fire.zscore.toFixed(2)})`,
    `- Composite score: ${fire.score.toFixed(1)}`,
    `- Detected at: ${new Date().toISOString()}`,
    '',
    '_Sent from FirefighterMap. Statistical detection, no automated action taken._',
  ].join('\n');
  return { subject, body };
}

async function onApiModmail(req: IncomingMessage): Promise<{ ok: boolean; conversationId?: string }> {
  const body = await readJSON<{ id?: string }>(req);
  const id = body.id?.trim();
  if (!id) throw new Error('missing fire id');
  const raw = await redis.get(FIRES_KEY);
  const fires = raw ? (JSON.parse(raw) as StoredFire[]) : [];
  const fire = fires.find((f) => f.id === id);
  if (!fire) throw new Error(`fire not found: ${id}`);
  const sub = context.subredditName ?? 'unknown';
  const subredditId = context.subredditId;
  if (!subredditId) throw new Error('missing subredditId in context');
  const { subject, body: bodyMarkdown } = buildModmailBody(fire, sub);
  const conversationId = await reddit.modMail.createModNotification({
    subject,
    bodyMarkdown,
    subredditId: subredditId as `t5_${string}`,
  });
  console.log(`[fmap] modmail: fire=${id} kind=${fire.kind} conversationId=${conversationId}`);
  return { ok: true, conversationId };
}

async function onMenuForceScan(): Promise<{
  showToast?: { text: string; appearance?: 'success' };
}> {
  console.log('[fmap] force-scan: invoked');
  await onSchedulerTick();
  const raw = await redis.get(FIRES_KEY);
  const fires = raw ? JSON.parse(raw) : [];
  console.log(`[fmap] force-scan: done, ${fires.length} fires in redis`);
  return { showToast: { text: `Scan complete. ${fires.length} fires detected.`, appearance: 'success' } };
}

async function onMenuSeedDemo(): Promise<{
  showToast?: { text: string; appearance?: 'success' };
}> {
  console.log('[fmap] seed-demo: invoked');
  const sub = context.subredditName ?? 'firefightermap_t';
  const now = Date.now();
  const det = getDetector();
  const events: Event[] = [];
  // user_burst: one user, 12 comments spread over 8 minutes
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: 'comment',
      ts: now - (8 - (i * 8) / 12) * 60_000,
      authorId: 'demo_burst_user',
      text: `quick reaction ${i}`,
      subreddit: sub,
    });
  }
  // near_duplicate_wave: 8 distinct users posting near-identical promo text
  const promo = 'Check out this amazing crypto opportunity. Limited time offer, DM for details!';
  for (let i = 0; i < 8; i++) {
    events.push({
      kind: 'post',
      ts: now - (6 - i * 0.6) * 60_000,
      authorId: `demo_promo_${i}`,
      text: `${promo} ${i % 2 === 0 ? 'Act fast' : 'Hurry now'}`,
      subreddit: sub,
    });
  }
  // background chatter: 20 random comments to make the global chart pretty
  for (let i = 0; i < 20; i++) {
    events.push({
      kind: 'comment',
      ts: now - Math.random() * 60 * 60_000,
      authorId: `demo_chat_${i % 7}`,
      text: `normal discussion ${i}`,
      subreddit: sub,
    });
  }
  for (const ev of events) await ingest(ev);
  // Cold-start workaround: pre-warm baselines with 30 samples of "0 events/min"
  // so the burst registers as a spike instead of polluting its own baseline.
  det.seedBaseline('user:demo_burst_user', 30, 0);
  for (let i = 0; i < 8; i++) det.seedBaseline(`user:demo_promo_${i}`, 30, 0);
  const globalCheck = await redis.zRange('fmap:win:global:all', 0, -1);
  console.log(`[fmap] seed-demo: ingested ${events.length} events, redis sliding-window now has ${globalCheck.length} entries`);
  await onSchedulerTick();
  return { showToast: { text: `Seeded ${events.length} demo events.`, appearance: 'success' } };
}

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await route(req, rsp);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON(500, { error: msg }, rsp);
  }
}

async function route(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  const raw = req.url ?? '/';
  // Devvit webview appends ?webbit_token=...&context=... to every request — strip
  // the query string before routing so the switch matches the pathname.
  const qi = raw.indexOf('?');
  const url = qi === -1 ? raw : raw.slice(0, qi);
  switch (url) {
    case '/internal/on-app-install':
      return writeJSON(200, await onAppInstall(), rsp);
    case '/internal/trigger/post-submit':
      return writeJSON(200, await onPostSubmit(req), rsp);
    case '/internal/trigger/comment-submit':
      return writeJSON(200, await onCommentSubmit(req), rsp);
    case '/internal/trigger/post-report':
      return writeJSON(200, await onPostReport(req), rsp);
    case '/internal/trigger/comment-report':
      return writeJSON(200, await onCommentReport(req), rsp);
    case '/internal/scheduler/tick':
      return writeJSON(200, await onSchedulerTick(), rsp);
    case '/internal/menu/open-dashboard':
      return writeJSON(200, await onMenuOpenDashboard(), rsp);
    case '/internal/menu/seed-demo':
      return writeJSON(200, await onMenuSeedDemo(), rsp);
    case '/internal/menu/force-scan':
      return writeJSON(200, await onMenuForceScan(), rsp);
    case '/api/fires':
      return writeJSON(200, await onApiFires(), rsp);
    case '/api/snooze':
      return writeJSON(200, await onApiSnooze(req), rsp);
    case '/api/modmail':
      return writeJSON(200, await onApiModmail(req), rsp);
    default:
      return writeJSON(404, { error: `not found: ${url}` }, rsp);
  }
}

function writeJSON(status: number, body: unknown, rsp: ServerResponse): void {
  const s = JSON.stringify(body);
  rsp.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
  });
  rsp.end(s);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on('data', (c) => chunks.push(c));
  await once(req, 'end');
  const text = Buffer.concat(chunks).toString();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

import type { KV } from './kv.ts';
import { SlidingWindow } from './window.ts';
import { RollingStats, zscore } from './zscore.ts';
import { jaccardEstimate, minhashSignature } from './minhash.ts';
import type { Event, Fire, FireKind, Sensitivity, Severity } from './types.ts';

const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_MINUTES = WINDOW_MS / 60_000;
const TIMELINE_MINUTES = 15;
const GLOBAL_BUCKET = 'global:all';
const BASELINE_MAX_MS = 24 * 60 * 60 * 1000;

export const BUCKET = {
  user: 'user:',
  target: 'target:',
  reporter: 'reporter:',
} as const;

interface UnionFind<T> {
  find(x: T): T;
  union(a: T, b: T): void;
}

function makeUnionFind<T>(): UnionFind<T> {
  const parent = new Map<T, T>();
  const find = (x: T): T => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    },
  };
}

function severity(z: number, s: Sensitivity): Severity {
  if (z >= s.zHigh) return 'high';
  if (z >= s.zMedium) return 'medium';
  return 'low';
}

function severityWeight(sev: Severity): number {
  return sev === 'high' ? 3 : sev === 'medium' ? 2 : 1;
}

// Stable id derived from semantic fire identity. Snooze relies on this:
// the same logical fire scanned across consecutive ticks must keep the same id.
// Per-kind logic so that firstSeenMs (which slides every tick for scanAxis
// fires) is never used as an id component.
function fireId(f: Fire): string {
  if (f.kind === 'near_duplicate_wave') {
    return `${f.kind}:${[...f.sampleEventIds].sort().join(',')}`;
  }
  return `${f.kind}:${[...f.subjects].sort().join(',')}`;
}

export class FireDetector {
  private win: SlidingWindow;
  private baselines = new Map<string, RollingStats>();
  private recentSigs: Array<{ id: string; sig: number[]; ts: number; text: string }> = [];
  private sensitivity: Sensitivity;

  constructor(kv: KV, sensitivity: Sensitivity) {
    this.sensitivity = sensitivity;
    this.win = new SlidingWindow(kv, BASELINE_MAX_MS);
  }

  private baseline(bucket: string): RollingStats {
    let r = this.baselines.get(bucket);
    if (!r) {
      r = new RollingStats();
      this.baselines.set(bucket, r);
    }
    return r;
  }

  async globalActivity(nowMs: number, minutes: number): Promise<number[]> {
    return this.win.countsByMinute(GLOBAL_BUCKET, nowMs, minutes);
  }

  // Demo/cold-start helper: pre-warm a bucket's baseline so a fresh process
  // doesn't treat the very first spike event as part of the baseline.
  seedBaseline(bucket: string, samples: number, valuePerSample: number): void {
    const stats = this.baseline(bucket);
    for (let i = 0; i < samples; i++) stats.push(valuePerSample);
  }

  async ingest(ev: Event): Promise<void> {
    const writes: Array<Promise<void>> = [
      this.win.record(GLOBAL_BUCKET, ev.ts, `${ev.kind}:${ev.ts}:${ev.authorId}`),
    ];
    if (ev.kind === 'post' || ev.kind === 'comment') {
      const bk = `${BUCKET.user}${ev.authorId}`;
      this.baseline(bk);
      writes.push(this.win.record(bk, ev.ts, `${ev.kind}:${ev.ts}`));
    }
    if (ev.kind === 'report') {
      if (ev.targetId) {
        const bk = `${BUCKET.target}${ev.targetId}`;
        this.baseline(bk);
        writes.push(this.win.record(bk, ev.ts, `r:${ev.reporterId}:${ev.ts}`));
      }
      if (ev.reporterId) {
        const bk = `${BUCKET.reporter}${ev.reporterId}`;
        this.baseline(bk);
        writes.push(this.win.record(bk, ev.ts, `t:${ev.targetId}:${ev.ts}`));
      }
    }
    if (ev.text && (ev.kind === 'post' || ev.kind === 'comment')) {
      const sig = minhashSignature(ev.text);
      this.recentSigs.push({ id: `${ev.kind}:${ev.ts}:${ev.authorId}`, sig, ts: ev.ts, text: ev.text });
    }
    await Promise.all(writes);
  }

  // Samples 1-min counts into rolling stats and trims old window entries.
  // Scheduler calls this every minute, so trim cost stays off the ingest path.
  async tickBaseline(nowMs: number, bucketKeys: string[]): Promise<void> {
    const oneMin = 60 * 1000;
    const allBuckets = [GLOBAL_BUCKET, ...bucketKeys];
    const [counts] = await Promise.all([
      Promise.all(bucketKeys.map((bk) => this.win.countInWindow(bk, nowMs, oneMin))),
      Promise.all(allBuckets.map((bk) => this.win.trim(bk, nowMs))),
    ]);
    bucketKeys.forEach((bk, i) => this.baseline(bk).push(counts[i]!));
  }

  async scan(nowMs: number): Promise<Fire[]> {
    const fires: Fire[] = [
      ...(await this.scanAxis('user_burst', BUCKET.user, nowMs)),
      ...(await this.scanAxis('target_report_burst', BUCKET.target, nowMs)),
      ...(await this.scanReporterCoordination(nowMs)),
      ...this.scanNearDuplicates(nowMs),
    ];
    return fires
      .sort((a, b) => b.score - a.score)
      .map((f) => ({ ...f, id: fireId(f) }));
  }

  private async scanAxis(
    kind: 'user_burst' | 'target_report_burst',
    prefix: string,
    nowMs: number,
  ): Promise<Fire[]> {
    const buckets = [...this.baselines.keys()].filter((k) => k.startsWith(prefix));
    const counts = await Promise.all(
      buckets.map((bk) => this.win.countInWindow(bk, nowMs, WINDOW_MS)),
    );
    const fires: Fire[] = [];
    const hits: Array<{ bk: string; observed: number; z: number; subjectId: string; sev: Severity; baseline: number }> = [];
    for (let i = 0; i < buckets.length; i++) {
      const bk = buckets[i]!;
      const observed = counts[i]!;
      const stats = this.baseline(bk).snapshot();
      const floor = this.sensitivity.minCountFloor[kind];
      const z = zscore(observed, stats.mean * WINDOW_MINUTES, stats.std * Math.sqrt(WINDOW_MINUTES), floor);
      if (!z.exceededFloor || z.z < this.sensitivity.zMedium) continue;
      hits.push({ bk, observed, z: z.z, baseline: z.baseline, subjectId: bk.slice(prefix.length), sev: severity(z.z, this.sensitivity) });
    }
    const timelines = await Promise.all(
      hits.map((h) => this.win.countsByMinute(h.bk, nowMs, TIMELINE_MINUTES)),
    );
    hits.forEach((h, i) => {
      fires.push({
        id: '',
        kind,
        severity: h.sev,
        score: h.z * severityWeight(h.sev),
        zscore: h.z,
        observed: h.observed,
        baseline: h.baseline,
        subjects: [h.subjectId],
        sampleEventIds: [],
        firstSeenMs: nowMs - WINDOW_MS,
        lastSeenMs: nowMs,
        explanation: this.explain(kind, h.subjectId, h.observed, h.z),
        timeline: timelines[i]!,
      });
    });
    return fires;
  }

  // Dormant on current Devvit — PostReport/CommentReport don't expose reporter id.
  private async scanReporterCoordination(nowMs: number): Promise<Fire[]> {
    const reporterBuckets = [...this.baselines.keys()].filter((k) => k.startsWith(BUCKET.reporter));
    const memberSets = await Promise.all(
      reporterBuckets.map((bk) => this.win.distinctMembersInWindow(bk, nowMs, WINDOW_MS)),
    );
    const reporterTargets = new Map<string, Set<string>>();
    reporterBuckets.forEach((bk, i) => {
      const reporter = bk.slice(BUCKET.reporter.length);
      const targets = new Set<string>();
      for (const m of memberSets[i]!) {
        const parts = m.split(':');
        if (parts.length >= 2 && parts[0] === 't' && parts[1]) targets.add(parts[1]);
      }
      if (targets.size > 0) reporterTargets.set(reporter, targets);
    });

    const reporters = [...reporterTargets.keys()];
    const floor = this.sensitivity.minCountFloor.coordinated_reporters;
    const uf = makeUnionFind<string>();

    for (let i = 0; i < reporters.length; i++) {
      for (let j = i + 1; j < reporters.length; j++) {
        const a = reporters[i]!;
        const b = reporters[j]!;
        const sa = reporterTargets.get(a)!;
        const sb = reporterTargets.get(b)!;
        let overlap = 0;
        for (const t of sa) if (sb.has(t)) overlap++;
        if (overlap >= floor) uf.union(a, b);
      }
    }

    const clusters = new Map<string, string[]>();
    for (const r of reporters) {
      const root = uf.find(r);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(r);
    }

    const fires: Fire[] = [];
    for (const group of clusters.values()) {
      if (group.length < 2) continue;
      const sets = group.map((r) => reporterTargets.get(r)!);
      const intersection = new Set<string>([...sets[0]!]);
      for (let i = 1; i < sets.length; i++) {
        for (const t of [...intersection]) if (!sets[i]!.has(t)) intersection.delete(t);
      }
      const overlap = intersection.size;
      if (overlap < floor) continue;
      const z = overlap / floor;
      let sev: Severity;
      if (z >= 2 || group.length >= 4) sev = 'high';
      else if (z >= 1.5) sev = 'medium';
      else continue;
      fires.push({
        id: '',
        kind: 'coordinated_reporters',
        severity: sev,
        score: overlap * group.length * severityWeight(sev),
        zscore: z,
        observed: overlap,
        baseline: floor,
        subjects: group,
        sampleEventIds: [...intersection].slice(0, 5),
        firstSeenMs: nowMs - WINDOW_MS,
        lastSeenMs: nowMs,
        explanation: `${group.length} reporters (${group.map((g) => `u/${g}`).join(', ')}) flagged ${overlap} of the same items in 15min`,
        timeline: new Array<number>(TIMELINE_MINUTES).fill(0),
      });
    }
    return fires;
  }

  private scanNearDuplicates(nowMs: number): Fire[] {
    const fresh = this.recentSigs.filter((s) => nowMs - s.ts <= WINDOW_MS);
    this.recentSigs = fresh;
    const uf = makeUnionFind<number>();

    for (let i = 0; i < fresh.length; i++) {
      for (let j = i + 1; j < fresh.length; j++) {
        if (jaccardEstimate(fresh[i]!.sig, fresh[j]!.sig) >= 0.7) uf.union(i, j);
      }
    }

    const clusters = new Map<number, number[]>();
    for (let i = 0; i < fresh.length; i++) {
      const r = uf.find(i);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r)!.push(i);
    }

    const floor = this.sensitivity.minCountFloor.near_duplicate_wave;
    const fires: Fire[] = [];
    for (const indices of clusters.values()) {
      if (indices.length < floor) continue;
      const z = indices.length / floor;
      const sev: Severity = z >= 2.5 ? 'high' : 'medium';
      const items = indices.map((i) => fresh[i]!);
      const sample = items[0]!.text.slice(0, 80);
      const startMs = nowMs - WINDOW_MS;
      const timeline = new Array<number>(TIMELINE_MINUTES).fill(0);
      for (const it of items) {
        const idx = Math.min(TIMELINE_MINUTES - 1, Math.max(0, Math.floor((it.ts - startMs) / 60_000)));
        timeline[idx]!++;
      }
      fires.push({
        id: '',
        kind: 'near_duplicate_wave',
        severity: sev,
        score: indices.length * severityWeight(sev),
        zscore: z,
        observed: indices.length,
        baseline: floor,
        subjects: [`${indices.length} near-duplicate posts`],
        sampleEventIds: items.slice(0, 5).map((i) => i.id),
        firstSeenMs: Math.min(...items.map((i) => i.ts)),
        lastSeenMs: Math.max(...items.map((i) => i.ts)),
        explanation: `${indices.length} near-duplicate posts in 15min — text starts: "${sample}…"`,
        timeline,
      });
    }
    return fires;
  }

  private explain(kind: FireKind, subjectId: string, observed: number, _z: number): string {
    switch (kind) {
      case 'user_burst':
        return `u/${subjectId} posted ${observed} times in the last 15 minutes — far above their normal pace.`;
      case 'target_report_burst':
        return `${subjectId} was reported ${observed} times in the last 15 minutes.`;
      default:
        return `${kind} on ${subjectId} — ${observed} events in 15 min.`;
    }
  }
}

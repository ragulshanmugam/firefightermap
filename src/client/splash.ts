import { navigateTo } from '@devvit/client';

type Severity = 'high' | 'medium' | 'low';

type Fire = {
  id: string;
  kind: string;
  severity: Severity;
  score: number;
  zscore: number;
  observed: number;
  baseline: number;
  subjects: string[];
  explanation: string;
  timeline: number[];
};

type FiresResponse = {
  fires: Fire[];
  sub: string;
  sensitivity: string;
  generatedAt: string;
  activity: number[];
};

const KIND_LABELS: Record<string, string> = {
  user_burst: 'User burst',
  target_report_burst: 'Report burst',
  topic_spike: 'Topic spike',
  near_duplicate_wave: 'Near-duplicate wave',
  coordinated_reporters: 'Coordinated reporters',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function subjectChip(s: string, kind: string): HTMLElement {
  const prefix = kind === 'user_burst' ? 'u/' : '';
  return el('code', { text: `${prefix}${s}` });
}

// Sparkline: 15 minute-bucket counts → smooth area + line.
function sparkline(timeline: number[]): SVGElement {
  const w = 88;
  const h = 28;
  const max = Math.max(1, ...timeline);
  const n = timeline.length;
  const step = n > 1 ? w / (n - 1) : w;
  const pts = timeline.map((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 4) - 2;
    return [x, y] as const;
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const fillPath = `${linePath} L${w},${h} L0,${h} Z`;

  const svg = svgEl('svg', {
    class: 'fire-spark',
    viewBox: `0 0 ${w} ${h}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  });
  svg.append(svgEl('path', { class: 'fire-spark-fill', d: fillPath }));
  svg.append(svgEl('path', { class: 'fire-spark-path', d: linePath, fill: 'none' }));
  return svg;
}

const USER_SUBJECT_KINDS = new Set(['user_burst', 'coordinated_reporters']);

function showToast(message: string): void {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = el('div', { id: 'toastHost', class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const t = el('div', { class: 'toast', role: 'status', text: message });
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }, 2600);
}

function navAction(opts: {
  href: string;
  label: string;
  className: string;
  ariaLabel: string;
}): HTMLAnchorElement {
  // Devvit webview sandbox blocks window.open and target=_blank. Use the
  // host bridge via @devvit/client's navigateTo, which postMessages the host
  // to navigate outside the iframe. <a href> is preserved so right-click →
  // "Open in new tab" still works as a fallback.
  const a = el('a', {
    class: opts.className,
    href: opts.href,
    rel: 'noopener noreferrer',
    'aria-label': opts.ariaLabel,
    text: opts.label,
  });
  a.addEventListener('click', (e) => {
    e.preventDefault();
    try {
      navigateTo(opts.href);
    } catch (err) {
      console.error('navigateTo failed', err);
      showToast('Could not open link');
    }
  });
  return a;
}

async function modmailFire(id: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch(`/api/modmail${window.location.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Sent to mod team');
    btn.textContent = 'Sent ✓';
  } catch (e) {
    console.error('modmail failed', e);
    btn.disabled = false;
    btn.textContent = 'Send to modmail';
    showToast('Modmail send failed');
  }
}

async function snoozeFire(id: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Snoozing…';
  try {
    const res = await fetch(`/api/snooze${window.location.search}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { snoozedUntil?: number };
    const until = data.snoozedUntil
      ? new Date(data.snoozedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
    showToast(until ? `Snoozed — reappears ~${until}` : 'Snoozed for 15 min');
    await refresh();
  } catch (e) {
    console.error('snooze failed', e);
    btn.disabled = false;
    btn.textContent = 'Snooze 15m';
    showToast('Snooze failed');
  }
}

function buildActions(f: Fire, sub: string): HTMLElement {
  const row = el('div', { class: 'fire-actions' });

  row.append(navAction({
    href: `https://www.reddit.com/r/${sub}/about/modqueue`,
    label: 'Open in modqueue',
    className: 'fire-action primary',
    ariaLabel: `Open modqueue for r/${sub}`,
  }));

  if (USER_SUBJECT_KINDS.has(f.kind) && f.subjects.length > 0) {
    const user = f.subjects[0]!;
    row.append(navAction({
      href: `https://www.reddit.com/user/${user}`,
      label: `View u/${user}`,
      className: 'fire-action',
      ariaLabel: `Open profile for u/${user}`,
    }));
  }

  const modmailBtn = el('button', {
    class: 'fire-action',
    type: 'button',
    'aria-label': 'Send to mod team via modmail',
  }, ['Send to modmail']);
  modmailBtn.addEventListener('click', () => {
    void modmailFire(f.id, modmailBtn as HTMLButtonElement);
  });
  row.append(modmailBtn);

  const snoozeBtn = el('button', {
    class: 'fire-action ghost',
    type: 'button',
    'aria-label': 'Snooze for 15 minutes',
  }, ['Snooze 15m']);
  snoozeBtn.addEventListener('click', () => {
    void snoozeFire(f.id, snoozeBtn as HTMLButtonElement);
  });
  row.append(snoozeBtn);

  return row;
}

function renderFire(f: Fire, sub: string): HTMLElement {
  const card = el('article', { class: `fire-card ${f.severity}`, role: 'listitem' });
  card.append(el('div', { class: 'fire-rule' }));

  const body = el('div', { class: 'fire-body' }, [
    el('div', { class: 'fire-meta' }, [
      el('span', { class: `sev-chip ${f.severity}`, text: f.severity }),
      el('span', { class: 'kind-label', text: KIND_LABELS[f.kind] ?? f.kind }),
    ]),
    el('p', { class: 'fire-explanation', text: f.explanation }),
  ]);

  if (f.subjects.length) {
    const subjects = el('div', { class: 'fire-subjects' });
    const shown = f.subjects.slice(0, 6);
    shown.forEach((s, i) => {
      subjects.append(subjectChip(s, f.kind));
      if (i < shown.length - 1) subjects.append(' ');
    });
    if (f.subjects.length > 6) {
      subjects.append(` +${f.subjects.length - 6} more`);
    }
    body.append(subjects);
  }

  if (f.timeline?.length) body.append(sparkline(f.timeline));
  body.append(buildActions(f, sub));
  card.append(body);

  card.append(
    el('div', { class: 'fire-scores' }, [
      el('div', { class: 'score-big', text: f.score.toFixed(1) }),
      el('div', { class: 'score-detail' }, [
        el('span', { class: 'z', text: `z = ${f.zscore.toFixed(2)}` }),
        el('br'),
        `observed ${f.observed} · baseline ${f.baseline.toFixed(1)}`,
      ]),
    ]),
  );
  return card;
}

function renderEmpty(): HTMLElement {
  const svg = svgEl('svg', { class: 'empty-illustration', viewBox: '0 0 88 88', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: '44', cy: '44', r: '40', fill: '#eef1f5' }));
  svg.append(svgEl('circle', { cx: '44', cy: '44', r: '24', fill: 'none', stroke: '#cdd4dd', 'stroke-width': '2', 'stroke-dasharray': '4 4' }));
  svg.append(svgEl('circle', { cx: '44', cy: '44', r: '8', fill: '#34c759' }));

  return el('div', { class: 'empty-state' }, [
    svg as unknown as Node,
    el('p', { class: 'empty-title', text: 'No fires detected' }),
    el('p', { class: 'empty-sub', text: 'Sub is quiet right now. The detector keeps a 15-minute window and refreshes every minute.' }),
  ]);
}

function renderActivityChart(activity: number[]): void {
  const svg = document.getElementById('activityChart')!;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const w = 360;
  const h = 96;
  const max = Math.max(1, ...activity);
  const n = activity.length;
  const gap = 1.5;
  const barW = Math.max(1, w / n - gap);
  const lastIdx = n - 1;
  activity.forEach((v, i) => {
    const barH = (v / max) * (h - 6);
    const x = i * (w / n) + gap / 2;
    const y = h - barH;
    let cls = 'activity-bar';
    if (i >= lastIdx - 4) cls += ' fresh';
    if (v === max && v > 0) cls += ' peak';
    const rect = svgEl('rect', {
      class: cls,
      x: x.toFixed(2),
      y: y.toFixed(2),
      width: barW.toFixed(2),
      height: Math.max(0, barH).toFixed(2),
      rx: '1.5',
    });
    svg.append(rect);
  });
  const total = activity.reduce((a, b) => a + b, 0);
  document.getElementById('activityTotal')!.textContent = `${total} event${total === 1 ? '' : 's'}`;
}

const RING_CIRC: number = 2 * Math.PI * 48;

function renderRing(high: number, medium: number, low: number): void {
  const total = high + medium + low;
  const safe = total === 0 ? 1 : total;
  const segHigh = (high / safe) * RING_CIRC;
  const segMed = (medium / safe) * RING_CIRC;
  const segLow = (low / safe) * RING_CIRC;

  const setSeg = (id: string, len: number, offset: number) => {
    const c = document.getElementById(id) as unknown as SVGCircleElement;
    c.setAttribute('stroke-dasharray', `${len} ${RING_CIRC - len}`);
    c.setAttribute('stroke-dashoffset', `${-offset}`);
  };

  if (total === 0) {
    setSeg('ringHigh', 0, 0);
    setSeg('ringMedium', 0, 0);
    setSeg('ringLow', RING_CIRC, 0);
  } else {
    setSeg('ringHigh', segHigh, 0);
    setSeg('ringMedium', segMed, segHigh);
    setSeg('ringLow', segLow, segHigh + segMed);
  }
  const ringTotal = document.getElementById('ringTotal')!;
  const prev = Number(ringTotal.textContent ?? '0');
  ringTotal.textContent = String(total);
  if (total !== prev) {
    ringTotal.classList.remove('bump');
    void ringTotal.offsetWidth; // force reflow so the class toggle re-triggers the transition
    ringTotal.classList.add('bump');
    setTimeout(() => ringTotal.classList.remove('bump'), 320);
  }
  document.getElementById('legendHigh')!.textContent = String(high);
  document.getElementById('legendMedium')!.textContent = String(medium);
  document.getElementById('legendLow')!.textContent = String(low);
}

function setLive(status: 'live' | 'fire'): void {
  const dot = document.querySelector('.live-dot') as HTMLElement | null;
  const label = document.querySelector('.live-label') as HTMLElement | null;
  if (!dot || !label) return;
  if (status === 'fire') {
    dot.style.background = 'var(--sev-high)';
    dot.style.boxShadow = '0 0 0 0 rgba(255, 69, 58, 0.55)';
    label.textContent = 'Fires active';
  } else {
    dot.style.background = '';
    dot.style.boxShadow = '';
    label.textContent = 'Live';
  }
}

function formatRelative(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function render(data: FiresResponse): void {
  const high = data.fires.filter((f) => f.severity === 'high').length;
  const medium = data.fires.filter((f) => f.severity === 'medium').length;
  const low = data.fires.filter((f) => f.severity === 'low').length;

  const pills = document.getElementById('metaPills')!;
  pills.replaceChildren(
    el('span', { class: 'pill', text: `r/${data.sub}` }),
    el('span', { class: 'pill', text: `Sensitivity · ${data.sensitivity.replace('_', ' ')}` }),
    el('span', { class: 'pill', text: `Scan · ${formatRelative(data.generatedAt)}` }),
  );

  const heroTitle = document.getElementById('heroTitle')!;
  const heroLead = document.getElementById('heroLead')!;
  if (high > 0) {
    heroTitle.textContent = high === 1 ? '1 fire burning hot.' : `${high} fires burning hot.`;
    heroLead.textContent = 'Active patterns demand a mod look. The queue is showing clumps faster than a human can scan.';
    setLive('fire');
  } else if (medium > 0) {
    heroTitle.textContent = 'Smoke, no flame.';
    heroLead.textContent = 'A few patterns above threshold — worth a glance but not urgent.';
    setLive('live');
  } else {
    heroTitle.textContent = 'All quiet.';
    heroLead.textContent = 'Surfacing brigades, raids, and near-duplicate spam waves the moment they form.';
    setLive('live');
  }

  renderActivityChart(data.activity ?? []);
  renderRing(high, medium, low);

  const container = document.getElementById('fires')!;
  container.replaceChildren();
  if (!data.fires.length) {
    container.append(renderEmpty());
    return;
  }
  for (const f of data.fires) container.append(renderFire(f, data.sub));
}

async function refresh(): Promise<void> {
  const btn = document.getElementById('refreshBtn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spinning');
  }
  try {
    const res = await fetch(`/api/fires${window.location.search}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (e) {
    console.error('refresh failed', e);
    showToast('Refresh failed');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }
}

document.getElementById('refreshBtn')?.addEventListener('click', () => void refresh());
void refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 30_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

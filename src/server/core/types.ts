export type EventKind = 'post' | 'comment' | 'report';

export interface Event {
  kind: EventKind;
  ts: number; // unix ms
  authorId: string; // u/abc → "abc"
  targetId?: string; // for reports: the post/comment being reported
  reporterId?: string; // for reports: who filed it
  text?: string; // post title+body or comment body
  url?: string; // permalink for deep-link in dashboard
  subreddit: string;
}

export type FireKind =
  | 'user_burst' // single user spiking across many items
  | 'target_report_burst' // one item getting hit with many reports fast
  | 'coordinated_reporters' // same group of reporters hitting many items (dormant — no reporter id from Devvit)
  | 'near_duplicate_wave'; // near-duplicate text across many posts

export type Severity = 'low' | 'medium' | 'high';

export interface Fire {
  id: string;
  kind: FireKind;
  severity: Severity;
  score: number; // composite ranking score; higher = hotter
  zscore: number;
  observed: number;
  baseline: number;
  subjects: string[]; // user ids, post ids, or topic strings involved
  sampleEventIds: string[]; // for deep-link into modqueue
  firstSeenMs: number;
  lastSeenMs: number;
  explanation: string; // human-readable one-liner
  timeline: number[]; // 15 minute-bucket counts, oldest first
}

export interface Sensitivity {
  name: 'small_sub' | 'medium_sub' | 'large_sub';
  // minimum raw count in the window before a key can fire
  minCountFloor: {
    user_burst: number;
    target_report_burst: number;
    coordinated_reporters: number;
    near_duplicate_wave: number;
  };
  // z-score threshold to escalate to medium / high severity
  zMedium: number;
  zHigh: number;
}

export const PRESETS: Record<Sensitivity['name'], Sensitivity> = {
  small_sub: {
    name: 'small_sub',
    minCountFloor: {
      user_burst: 5,
      target_report_burst: 4,
      coordinated_reporters: 3,
      near_duplicate_wave: 3,
    },
    zMedium: 2.5,
    zHigh: 4.0,
  },
  medium_sub: {
    name: 'medium_sub',
    minCountFloor: {
      user_burst: 10,
      target_report_burst: 6,
      coordinated_reporters: 4,
      near_duplicate_wave: 5,
    },
    zMedium: 3.0,
    zHigh: 5.0,
  },
  large_sub: {
    name: 'large_sub',
    minCountFloor: {
      user_burst: 25,
      target_report_burst: 12,
      coordinated_reporters: 6,
      near_duplicate_wave: 10,
    },
    zMedium: 3.5,
    zHigh: 6.0,
  },
};

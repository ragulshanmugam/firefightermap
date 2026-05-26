import type { KV } from './kv.ts';

const WINDOW_PREFIX = 'fmap:win:';

export class SlidingWindow {
  private kv: KV;
  private maxAgeMs: number;

  constructor(kv: KV, maxAgeMs: number) {
    this.kv = kv;
    this.maxAgeMs = maxAgeMs;
  }

  private key(bucket: string): string {
    return `${WINDOW_PREFIX}${bucket}`;
  }

  async record(bucket: string, nowMs: number, eventId: string): Promise<void> {
    await this.kv.zAdd(this.key(bucket), nowMs, `${nowMs}:${eventId}`);
  }

  // Trim entries older than maxAgeMs. Called from the scheduler tick — keeping
  // it out of record() saves one Redis RTT per ingest on hot trigger paths.
  async trim(bucket: string, nowMs: number): Promise<void> {
    await this.kv.zRemRangeByScore(this.key(bucket), 0, nowMs - this.maxAgeMs);
  }

  async countInWindow(bucket: string, nowMs: number, windowMs: number): Promise<number> {
    return this.kv.zCount(this.key(bucket), nowMs - windowMs, nowMs);
  }

  // Returns N minute-buckets of counts, oldest first, ending at nowMs.
  async countsByMinute(bucket: string, nowMs: number, minutes: number): Promise<number[]> {
    const startMs = nowMs - minutes * 60_000;
    const entries = await this.kv.zRangeByScore(this.key(bucket), startMs, nowMs);
    const out = new Array<number>(minutes).fill(0);
    for (const e of entries) {
      const idx = Math.min(minutes - 1, Math.max(0, Math.floor((e.score - startMs) / 60_000)));
      out[idx]!++;
    }
    return out;
  }

  async distinctMembersInWindow(
    bucket: string,
    nowMs: number,
    windowMs: number,
  ): Promise<Set<string>> {
    const entries = await this.kv.zRangeByScore(
      this.key(bucket),
      nowMs - windowMs,
      nowMs,
    );
    const out = new Set<string>();
    for (const e of entries) {
      const idx = e.member.indexOf(':');
      out.add(idx >= 0 ? e.member.slice(idx + 1) : e.member);
    }
    return out;
  }
}

import type { KV } from '../src/server/core/kv.ts';

type ZEntry = { member: string; score: number };

export class MemoryKV implements KV {
  private z = new Map<string, ZEntry[]>();
  private h = new Map<string, Map<string, number>>();
  private s = new Map<string, string>();

  private getZ(key: string): ZEntry[] {
    let arr = this.z.get(key);
    if (!arr) {
      arr = [];
      this.z.set(key, arr);
    }
    return arr;
  }

  async zAdd(key: string, score: number, member: string): Promise<void> {
    const arr = this.getZ(key);
    arr.push({ member, score });
    arr.sort((a, b) => a.score - b.score);
  }

  async zCount(key: string, min: number, max: number): Promise<number> {
    const arr = this.z.get(key) ?? [];
    let n = 0;
    for (const e of arr) if (e.score >= min && e.score <= max) n++;
    return n;
  }

  async zRangeByScore(
    key: string,
    min: number,
    max: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const arr = this.z.get(key) ?? [];
    return arr.filter((e) => e.score >= min && e.score <= max).map((e) => ({ ...e }));
  }

  async zRemRangeByScore(key: string, min: number, max: number): Promise<number> {
    const arr = this.z.get(key);
    if (!arr) return 0;
    let removed = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i]!;
      if (e.score >= min && e.score <= max) {
        arr.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  async hIncrBy(key: string, field: string, by: number): Promise<number> {
    let m = this.h.get(key);
    if (!m) {
      m = new Map();
      this.h.set(key, m);
    }
    const next = (m.get(field) ?? 0) + by;
    m.set(field, next);
    return next;
  }

  async hGet(key: string, field: string): Promise<number | undefined> {
    return this.h.get(key)?.get(field);
  }

  async hGetAll(key: string): Promise<Record<string, number>> {
    const m = this.h.get(key);
    if (!m) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of m) out[k] = v;
    return out;
  }

  async set(key: string, value: string): Promise<void> {
    this.s.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.s.get(key);
  }

  async expire(): Promise<void> {}
}

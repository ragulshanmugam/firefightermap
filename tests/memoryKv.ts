import type { KV } from '../src/server/core/kv.ts';

type ZEntry = { member: string; score: number };

export class MemoryKV implements KV {
  private z = new Map<string, ZEntry[]>();

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
}

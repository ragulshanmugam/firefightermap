import { describe, expect, it } from 'vitest';
import { MemoryKV } from './memoryKv.ts';
import { SlidingWindow } from '../src/server/core/window.ts';

describe('SlidingWindow', () => {
  it('counts events within the requested window', async () => {
    const kv = new MemoryKV();
    const win = new SlidingWindow(kv, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) await win.record('user:alice', t0 + i * 1000, `e${i}`);
    // Events at t0, +1s, +2s, +3s, +4s.
    // 10s window ending at t0+5s covers [t0-5s, t0+5s] → all 5 events.
    expect(await win.countInWindow('user:alice', t0 + 5000, 10_000)).toBe(5);
    // 2s window ending at t0+5s covers [t0+3s, t0+5s] → events at +3s and +4s.
    expect(await win.countInWindow('user:alice', t0 + 5000, 2000)).toBe(2);
  });

  it('prunes events older than maxAge on each record', async () => {
    const kv = new MemoryKV();
    const win = new SlidingWindow(kv, 10_000);
    await win.record('user:bob', 0, 'old');
    await win.record('user:bob', 100_000, 'new');
    expect(await win.countInWindow('user:bob', 100_000, 200_000)).toBe(1);
  });

  it('returns distinct members from a window', async () => {
    const kv = new MemoryKV();
    const win = new SlidingWindow(kv, 60_000);
    await win.record('reporter:r1', 100, 't:postA:100');
    await win.record('reporter:r1', 200, 't:postB:200');
    await win.record('reporter:r1', 300, 't:postA:300');
    const got = await win.distinctMembersInWindow('reporter:r1', 1000, 1000);
    expect(got).toEqual(new Set(['t:postA:100', 't:postB:200', 't:postA:300']));
  });
});

import { describe, expect, it } from 'vitest';
import { RollingStats, zscore } from '../src/server/core/zscore.ts';

describe('RollingStats', () => {
  it('matches known mean and stddev', () => {
    const r = new RollingStats();
    for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) r.push(x);
    expect(r.average).toBeCloseTo(5, 5);
    expect(r.stddev).toBeCloseTo(2.138, 2);
  });

  it('returns zero stddev for n<2', () => {
    const r = new RollingStats();
    expect(r.stddev).toBe(0);
    r.push(42);
    expect(r.stddev).toBe(0);
  });
});

describe('zscore', () => {
  it('respects the minCountFloor', () => {
    const z = zscore(3, 0.5, 0.5, 5);
    expect(z.exceededFloor).toBe(false);
    const z2 = zscore(7, 0.5, 0.5, 5);
    expect(z2.exceededFloor).toBe(true);
    expect(z2.z).toBeGreaterThan(1);
  });

  it('uses a min stddev of 1 to avoid div-by-zero', () => {
    const z = zscore(10, 0, 0, 1);
    expect(Number.isFinite(z.z)).toBe(true);
    expect(z.z).toBe(10);
  });
});

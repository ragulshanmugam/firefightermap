import { describe, expect, it } from 'vitest';
import { FireDetector } from '../src/server/core/detector.ts';
import { MemoryKV } from './memoryKv.ts';
import { PRESETS } from '../src/server/core/types.ts';
import type { Event } from '../src/server/core/types.ts';

const SUB = 'testsub';

function postFrom(authorId: string, ts: number, text = 'hello world filler text'): Event {
  return { kind: 'post', authorId, ts, text, subreddit: SUB };
}

function report(reporterId: string, targetId: string, ts: number): Event {
  return { kind: 'report', authorId: reporterId, reporterId, targetId, ts, subreddit: SUB };
}

async function buildBaseline(detector: FireDetector, bucketKeys: string[], startMs: number) {
  // Roll 60 minutes of quiet baseline counts so the rolling stats have shape.
  for (let m = 0; m < 60; m++) {
    await detector.tickBaseline(startMs + m * 60_000, bucketKeys);
  }
}

describe('FireDetector', () => {
  it('detects a user_burst Fire when a single user spikes', async () => {
    const kv = new MemoryKV();
    const det = new FireDetector(kv, PRESETS.small_sub);
    const start = 1_700_000_000_000;

    // seed quiet baseline for user:alice
    await det.ingest(postFrom('alice', start - 60 * 60_000));
    await buildBaseline(det, ['user:alice'], start - 60 * 60_000);

    // now alice posts 12 times in 5 minutes — way above the small_sub floor of 5
    const burstAt = start + 60 * 60_000;
    for (let i = 0; i < 12; i++) {
      await det.ingest(postFrom('alice', burstAt + i * 10_000));
    }
    const fires = await det.scan(burstAt + 5 * 60_000);
    const userFire = fires.find((f) => f.kind === 'user_burst');
    expect(userFire).toBeDefined();
    expect(userFire!.subjects).toContain('alice');
    expect(userFire!.observed).toBeGreaterThanOrEqual(12);
    expect(userFire!.severity).not.toBe('low');
  });

  it('detects target_report_burst when one post gets brigaded with reports', async () => {
    const kv = new MemoryKV();
    const det = new FireDetector(kv, PRESETS.small_sub);
    const t0 = 1_700_000_000_000;
    // Quiet baseline first — no events yet.
    await buildBaseline(det, ['target:postX'], t0);
    // Then 8 reporters hammer the same target inside 2 minutes.
    const brigadeAt = t0 + 60 * 60_000;
    for (let i = 0; i < 8; i++) {
      await det.ingest(report(`r${i}`, 'postX', brigadeAt + i * 12_000));
    }
    const fires = await det.scan(brigadeAt + 3 * 60_000);
    const burst = fires.find((f) => f.kind === 'target_report_burst');
    expect(burst).toBeDefined();
    expect(burst!.subjects).toContain('postX');
    expect(burst!.observed).toBeGreaterThanOrEqual(8);
  });

  it('detects coordinated_reporters when two accounts flag the same items', async () => {
    const kv = new MemoryKV();
    const det = new FireDetector(kv, PRESETS.small_sub);
    const t0 = 1_700_000_000_000;
    // r1 and r2 both report posts A, B, C, D inside the window
    const targets = ['postA', 'postB', 'postC', 'postD', 'postE'];
    for (let i = 0; i < targets.length; i++) {
      await det.ingest(report('r1', targets[i]!, t0 + i * 1000));
      await det.ingest(report('r2', targets[i]!, t0 + i * 1000 + 500));
    }
    const fires = await det.scan(t0 + 10_000);
    const coord = fires.find((f) => f.kind === 'coordinated_reporters');
    expect(coord).toBeDefined();
    expect(new Set(coord!.subjects)).toEqual(new Set(['r1', 'r2']));
    expect(coord!.observed).toBeGreaterThanOrEqual(5);
  });

  it('detects a near_duplicate_wave when same spam text reposts across accounts', async () => {
    const kv = new MemoryKV();
    const det = new FireDetector(kv, PRESETS.small_sub);
    const t0 = 1_700_000_000_000;
    const spam =
      'FREE iPhone giveaway! Click this totally-legit link to claim your prize before midnight!';
    const variations = [
      spam,
      spam.replace('!', '!!'),
      'FREE iPhone giveaway. Click this totally-legit link to claim your prize before midnight.',
      'FREE iPhone giveaway! Click this totally-legit link to claim your prize before MIDNIGHT!',
      'FREE iPhone giveaway! Click this totally-legit link and claim your prize before midnight!',
    ];
    for (let i = 0; i < variations.length; i++) {
      await det.ingest(postFrom(`bot${i}`, t0 + i * 30_000, variations[i]));
    }
    const fires = await det.scan(t0 + 5 * 60_000);
    const wave = fires.find((f) => f.kind === 'near_duplicate_wave');
    expect(wave).toBeDefined();
    expect(wave!.observed).toBeGreaterThanOrEqual(3);
  });

  it('seedBaseline pre-warms a cold-start bucket so a polluted-baseline tick still fires', async () => {
    const kv = new MemoryKV();
    const det = new FireDetector(kv, PRESETS.small_sub);
    const now = 1_700_000_000_000;
    // Cold-start path: 12 events arrive without prior baseline samples,
    // mimicking the seed-demo flow (events land in the last 8 min).
    for (let i = 0; i < 12; i++) {
      await det.ingest(postFrom('cold_user', now - (8 - (i * 8) / 12) * 60_000));
    }
    // Bug repro: tickBaseline runs against the spike-polluted window before scan.
    await det.tickBaseline(now, ['user:cold_user']);
    const beforeWarm = await det.scan(now);
    expect(beforeWarm.find((f) => f.kind === 'user_burst' && f.subjects.includes('cold_user'))).toBeUndefined();
    // Fix: 30 pre-warm samples of "0 events/min" dominate the single polluted sample.
    det.seedBaseline('user:cold_user', 30, 0);
    await det.tickBaseline(now, ['user:cold_user']);
    const afterWarm = await det.scan(now);
    const fire = afterWarm.find((f) => f.kind === 'user_burst' && f.subjects.includes('cold_user'));
    expect(fire).toBeDefined();
    expect(fire!.observed).toBeGreaterThanOrEqual(12);
  });

  it('does NOT fire on baseline-level activity', async () => {
    const kv = new MemoryKV();
    const det = new FireDetector(kv, PRESETS.medium_sub);
    const t0 = 1_700_000_000_000;
    // Normal activity: alice posts once every 5 minutes for an hour
    for (let i = 0; i < 12; i++) {
      await det.ingest(postFrom('alice', t0 + i * 5 * 60_000));
    }
    await buildBaseline(det, ['user:alice'], t0);
    const fires = await det.scan(t0 + 60 * 60_000);
    expect(fires.filter((f) => f.kind === 'user_burst').length).toBe(0);
  });
});

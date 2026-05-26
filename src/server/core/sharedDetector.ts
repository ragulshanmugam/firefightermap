// Module-level singleton. Survives across requests in a warm Devvit process.
// LIMITATION: cold starts reset `baselines` and `recentSigs` — only the Redis-
// backed sliding window survives. If playtest shows frequent process recycling,
// add snapshot/restore of detector state to Redis on each ingest.

import { FireDetector } from './detector.ts';
import { PRESETS } from './types.ts';
import type { Sensitivity } from './types.ts';
import { devvitKv } from './devvitKv.ts';

export const SENSITIVITY: Sensitivity = PRESETS.small_sub;

let _det: FireDetector | undefined;

export function getDetector(): FireDetector {
  if (!_det) _det = new FireDetector(devvitKv, SENSITIVITY);
  return _det;
}

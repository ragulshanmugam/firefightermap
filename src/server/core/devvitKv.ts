// Maps our KV interface onto @devvit/web/server's redis.

import { redis } from '@devvit/web/server';
import type { KV } from './kv.ts';

export const devvitKv: KV = {
  async zAdd(key, score, member) {
    await redis.zAdd(key, { score, member });
  },

  async zCount(key, min, max) {
    const r = await redis.zRange(key, min, max, { by: 'score' });
    return r.length;
  },

  async zRangeByScore(key, min, max) {
    const r = await redis.zRange(key, min, max, { by: 'score' });
    return r.map((e) => ({ member: e.member, score: e.score }));
  },

  async zRemRangeByScore(key, min, max) {
    return redis.zRemRangeByScore(key, min, max);
  },
};

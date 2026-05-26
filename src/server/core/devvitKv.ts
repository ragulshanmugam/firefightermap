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

  async hIncrBy(key, field, by) {
    return redis.hIncrBy(key, field, by);
  },

  async hGet(key, field) {
    const v = await redis.hGet(key, field);
    return v === undefined ? undefined : Number(v);
  },

  async hGetAll(key) {
    const m = (await redis.hGetAll(key)) ?? {};
    const out: Record<string, number> = {};
    for (const k of Object.keys(m)) out[k] = Number(m[k]);
    return out;
  },

  async set(key, value, ttlSec) {
    if (ttlSec) {
      await redis.set(key, value, { expiration: new Date(Date.now() + ttlSec * 1000) });
    } else {
      await redis.set(key, value);
    }
  },

  async get(key) {
    return redis.get(key);
  },

  async expire(key, ttlSec) {
    await redis.expire(key, ttlSec);
  },
};

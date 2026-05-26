// KV interface — devvitKv adapter implements this against Devvit's redis.

export interface KV {
  zAdd(key: string, score: number, member: string): Promise<void>;
  zCount(key: string, min: number, max: number): Promise<number>;
  zRangeByScore(key: string, min: number, max: number): Promise<Array<{ member: string; score: number }>>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<number>;
  hIncrBy(key: string, field: string, by: number): Promise<number>;
  hGet(key: string, field: string): Promise<number | undefined>;
  hGetAll(key: string): Promise<Record<string, number>>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  get(key: string): Promise<string | undefined>;
  expire(key: string, ttlSec: number): Promise<void>;
}

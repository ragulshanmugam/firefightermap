// KV interface — devvitKv adapter implements this against Devvit's redis.

export interface KV {
  zAdd(key: string, score: number, member: string): Promise<void>;
  zCount(key: string, min: number, max: number): Promise<number>;
  zRangeByScore(key: string, min: number, max: number): Promise<Array<{ member: string; score: number }>>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<number>;
}

import { describe, expect, it } from 'vitest';
import { jaccardEstimate, lshBuckets, minhashSignature } from '../src/server/core/minhash.ts';

describe('minhash', () => {
  it('gives jaccard ~1 for identical text', () => {
    const a = minhashSignature('buy crypto now at totally-legit-coin dot com');
    const b = minhashSignature('buy crypto now at totally-legit-coin dot com');
    expect(jaccardEstimate(a, b)).toBe(1);
  });

  it('gives high jaccard for near-duplicate spam text', () => {
    const a = minhashSignature('Buy Bitcoin now at scam-site.com, limited offer!');
    const b = minhashSignature('Buy Bitcoin now at scam-site.com, limited time offer!');
    expect(jaccardEstimate(a, b)).toBeGreaterThan(0.65);
  });

  it('gives low jaccard for unrelated posts', () => {
    const a = minhashSignature(
      'Anyone know good resources for learning Rust ownership semantics?',
    );
    const b = minhashSignature('My cat keeps knocking over my coffee, send help');
    expect(jaccardEstimate(a, b)).toBeLessThan(0.2);
  });

  it('LSH buckets overlap for near-duplicates', () => {
    const a = lshBuckets(minhashSignature('Free iPhone giveaway click here scam'));
    const b = lshBuckets(minhashSignature('Free iPhone giveaway click here SCAM!!'));
    const overlap = a.filter((x) => b.includes(x));
    expect(overlap.length).toBeGreaterThanOrEqual(1);
  });
});

// MinHash + banded LSH for near-duplicate post detection (FNV-1a, no deps).

const K = 64; // signature length; 64 is enough for ~0.1 jaccard resolution
const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;
const UINT32 = 0xffffffff;

function fnv1a(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

function makeCoeffs(): Array<{ a: number; b: number }> {
  const coeffs: Array<{ a: number; b: number }> = [];
  for (let i = 0; i < K; i++) {
    coeffs.push({
      a: fnv1a(`a:${i}`),
      b: fnv1a(`b:${i}`),
    });
  }
  return coeffs;
}

const COEFFS = makeCoeffs();

function shingles(text: string, k = 5): Set<string> {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const out = new Set<string>();
  if (norm.length < k) {
    if (norm.length > 0) out.add(norm);
    return out;
  }
  for (let i = 0; i <= norm.length - k; i++) {
    out.add(norm.slice(i, i + k));
  }
  return out;
}

export function minhashSignature(text: string): number[] {
  const sh = shingles(text);
  const sig: number[] = new Array(K).fill(UINT32);
  for (const s of sh) {
    const h = fnv1a(s);
    for (let i = 0; i < K; i++) {
      const c = COEFFS[i]!;
      const perm = (Math.imul(c.a, h) + c.b) >>> 0;
      if (perm < sig[i]!) sig[i] = perm;
    }
  }
  return sig;
}

export function jaccardEstimate(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

// Banded LSH: signatures sharing any band hash are likely near-duplicates.
export function lshBuckets(sig: number[], bands = 8): string[] {
  const r = Math.floor(sig.length / bands);
  const out: string[] = [];
  for (let b = 0; b < bands; b++) {
    const slice = sig.slice(b * r, (b + 1) * r).join(',');
    out.push(`b${b}:${fnv1a(slice)}`);
  }
  return out;
}

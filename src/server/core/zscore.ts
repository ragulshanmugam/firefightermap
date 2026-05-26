// Adaptive z-score with a min-count floor (suppresses false positives on quiet subs).

export interface ZScoreResult {
  z: number;
  baseline: number;
  observed: number;
  exceededFloor: boolean;
}

export function zscore(
  observed: number,
  baselineMean: number,
  baselineStd: number,
  minCountFloor: number,
): ZScoreResult {
  const std = Math.max(baselineStd, 1); // avoid div-by-zero on quiet keys
  const z = (observed - baselineMean) / std;
  return {
    z,
    baseline: baselineMean,
    observed,
    exceededFloor: observed >= minCountFloor,
  };
}

// Welford online stats — O(1) memory.
export class RollingStats {
  private n = 0;
  private mean = 0;
  private m2 = 0;

  push(x: number): void {
    this.n++;
    const delta = x - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (x - this.mean);
  }

  snapshot(): { n: number; mean: number; std: number } {
    const std = this.n < 2 ? 0 : Math.sqrt(this.m2 / (this.n - 1));
    return { n: this.n, mean: this.mean, std };
  }
}

/**
 * Assetto Corsa style lookup table (`.lut` / AC EVO `.curve`).
 *
 * Piecewise-linear interpolation, clamped to the first/last value outside the
 * defined range (identical to how Kunos physics evaluates LUTs).
 */
export type LutPoints = ReadonlyArray<readonly [number, number]>;

export class Lut {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;

  constructor(points: LutPoints) {
    if (points.length === 0) {
      throw new Error('Lut requires at least one point');
    }
    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    this.xs = Float64Array.from(sorted.map((p) => p[0]));
    this.ys = Float64Array.from(sorted.map((p) => p[1]));
  }

  get minX(): number {
    return this.xs[0];
  }

  get maxX(): number {
    return this.xs[this.xs.length - 1];
  }

  /** Maximum Y value in the table (e.g. peak of a torque curve). */
  get maxY(): number {
    let m = -Infinity;
    for (let i = 0; i < this.ys.length; i++) m = Math.max(m, this.ys[i]);
    return m;
  }

  evaluate(x: number): number {
    const xs = this.xs;
    const ys = this.ys;
    const n = xs.length;
    if (n === 1 || x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    // Binary search for the bracketing segment
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return ys[lo] + (ys[hi] - ys[lo]) * t;
  }
}

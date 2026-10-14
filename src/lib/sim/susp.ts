/**
 * 4-Corner Suspension, Damper, Packer & Axle Anti-Roll Bar / Heave Spring Solver
 *
 * Ported directly from Speed Dreams / TORCS `simuv5/susp.cpp` and `simuv5/axle.cpp`:
 * - `damperForce`: piecewise linear slow/fast bump and rebound damping with knee velocity `v1`
 * - `springForce`: Hooke's law `K * (x - x0) + F0`
 * - `SimSuspCheckIn`: travel clamping, packer / bump-stop engagement (`STATE_PACKER`),
 *   finite-difference suspension velocity `v = (x - prex) / dt` and acceleration `a = (v - prev) / dt`
 * - `SimSuspUpdate`: `(springForce + damperForce + inertance * a) * overf`
 * - `SimAxleUpdate`: anti-roll bar (`arbSusp`) differential wheel travel transfer and
 *   third/heave spring (`heaveSusp`) on average axle travel `0.5 * (xR + xL)`
 */

import {
  SimAxleConfig,
  SimCornerSuspensionConfig,
  SimSuspensionDamperConfig,
  SimSuspensionSpringConfig,
} from './car-configs';

export const SUSP_STATE_NORMAL = 0;
export const SUSP_STATE_BUMP = 1;   // Compressed past packer / bump stop
export const SUSP_STATE_EXT = 2;    // Fully extended (wheel unloaded / airborne)

export interface SimDamperCoeffs {
  C1: number;
  b1: number;
  v1: number;
  C2: number;
  b2: number;
}

export interface SimSuspensionState {
  /** Current suspension travel x (m) */
  x: number;
  /** Previous step travel (m) */
  prex: number;
  /** Suspension compression velocity v (m/s) */
  v: number;
  /** Previous step velocity (m/s) */
  prev: number;
  /** Suspension compression acceleration a (m/s²) */
  a: number;
  /** Net suspension force acting on wheel/chassis (N) */
  force: number;
  /** State flags (SUSP_STATE_BUMP | SUSP_STATE_EXT) */
  state: number;
  /** Multiplier applied when hitting packers */
  overf: number;
  spring: SimSuspensionSpringConfig;
  bump: SimDamperCoeffs;
  rebound: SimDamperCoeffs;
  bellcrank: number;
  inertance: number;
}

export interface SimAxleState {
  arbStiffness: number;
  heaveSusp: SimSuspensionState;
  /** Third/heave spring force distributed per wheel on this axle (N) */
  thirdForcePerWheel: number;
  /** Anti-roll bar force on [right, left] wheel of this axle (N) */
  arbForce: [number, number];
}

/**
 * Port of `initDamper` from `susp.cpp`:
 * Computes piecewise linear intercept `b2 = (C1 - C2) * v1 + b1` at velocity knee `v1`.
 */
export function buildDamperCoeffs(cfg: SimSuspensionDamperConfig): {
  bump: SimDamperCoeffs;
  rebound: SimDamperCoeffs;
} {
  const bump: SimDamperCoeffs = {
    C1: cfg.bumpSlow,
    b1: 0,
    v1: cfg.bumpLv,
    C2: cfg.bumpFast,
    b2: (cfg.bumpSlow - cfg.bumpFast) * cfg.bumpLv,
  };
  const rebound: SimDamperCoeffs = {
    C1: cfg.reboundSlow,
    b1: 0,
    v1: cfg.reboundLv,
    C2: cfg.reboundFast,
    b2: (cfg.reboundSlow - cfg.reboundFast) * cfg.reboundLv,
  };
  return { bump, rebound };
}

export function initSuspensionState(
  cfg: SimCornerSuspensionConfig,
  staticWeightN: number,
  restX0Override?: number
): SimSuspensionState {
  const { bump, rebound } = buildDamperCoeffs(cfg.damper);
  // Compute rest deflection x0 from static weight so that at x = x0, force = staticWeightN,
  // and at x = 0 (full droop), force = 0.
  const bellcrank = cfg.bellcrank || 1.0;
  const effectiveK = Math.max(1, cfg.spring.K * bellcrank);
  const x0 =
    restX0Override !== undefined
      ? restX0Override
      : Math.max(
          0.002,
          Math.min(cfg.spring.xMax * 0.65, staticWeightN / effectiveK)
        );
  const f0 = staticWeightN / bellcrank;

  return {
    x: x0,
    prex: x0,
    v: 0,
    prev: 0,
    a: 0,
    force: staticWeightN,
    state: SUSP_STATE_NORMAL,
    overf: 1.0,
    spring: {
      ...cfg.spring,
      x0,
      F0: f0,
    },
    bump,
    rebound,
    bellcrank,
    inertance: cfg.inertance,
  };
}

export function initAxleState(
  cfg: SimAxleConfig,
  staticCornerRestX0: number
): SimAxleState {
  // Heave spring engages symmetrically around static ride height x0 (0 preload at static rest)
  const heaveSusp = initSuspensionState(
    {
      spring: cfg.heaveSpring,
      damper: cfg.heaveDamper,
      bellcrank: 1.0,
      inertance: 0.0,
    },
    0,
    staticCornerRestX0
  );
  return {
    arbStiffness: cfg.arbStiffness,
    heaveSusp,
    thirdForcePerWheel: 0,
    arbForce: [0, 0],
  };
}

/**
 * Port of `damperForce(tSuspension *susp)` from `simuv5/susp.cpp`
 */
export function computeDamperForce(susp: SimSuspensionState): number {
  const v = susp.v;
  if (Math.abs(v) < 1e-5) return 0;

  let f = 0;
  if (v < 0) {
    // Rebound (extension)
    const av = -v;
    const d = susp.rebound;
    if (av < d.v1) {
      f = av * d.C1 + d.b1;
    } else {
      f = av * d.C2 + d.b2;
    }
    f = -f;
  } else {
    // Bump (compression)
    const d = susp.bump;
    if (v < d.v1) {
      f = v * d.C1 + d.b1;
    } else {
      f = v * d.C2 + d.b2;
    }
  }
  return f;
}

/**
 * Port of `springForce(tSuspension *susp)` from `simuv5/susp.cpp`
 */
export function computeSpringForce(susp: SimSuspensionState): number {
  const s = susp.spring;
  const packerLimit = s.packers > 0 ? s.packers : s.xMax;
  const fPacker =
    susp.x > packerLimit ? s.K * 1.5 * (susp.x - packerLimit) : 0;
  // K is positive, so force increases with compression x above static deflection x0
  const f = s.K * (susp.x - s.x0) + s.F0 + fPacker;
  return Math.max(0, f);
}

/**
 * Port of `SimSuspCheckIn(tSuspension *susp, tdble dt)` from `simuv5/susp.cpp`
 * Note: here `x` increases with compression (when wheel moves up relative to chassis).
 */
export function simSuspCheckIn(susp: SimSuspensionState, dt: number): void {
  susp.state = SUSP_STATE_NORMAL;
  susp.overf = 1.0;

  // Extension limit: wheel droops below max travel (airborne / unloaded)
  if (susp.x <= 0) {
    susp.x = 0;
    susp.state = SUSP_STATE_EXT;
  }

  // Packer / bump stop limit: suspension compresses beyond packer gap
  const maxTravel = susp.spring.xMax;
  const packerLimit = susp.spring.packers > 0 ? susp.spring.packers : maxTravel;
  if (susp.x > packerLimit) {
    if (susp.x > maxTravel) {
      susp.x = maxTravel;
    }
    susp.state = SUSP_STATE_BUMP;
  }

  const safeDt = Math.max(1e-5, dt);
  const rawV = Math.max(-1.8, Math.min(1.8, (susp.x - susp.prex) / safeDt));
  // Low-pass filter finite-difference velocity slightly to prevent numerical chatter
  susp.v = susp.prev + (rawV - susp.prev) * 0.35;
  susp.a = Math.max(-30.0, Math.min(30.0, (susp.v - susp.prev) / safeDt));
  susp.prev = susp.v;
  susp.prex = susp.x;
}

/**
 * Port of `SimSuspUpdate(tSuspension *susp)` from `simuv5/susp.cpp`
 */
export function simSuspUpdate(susp: SimSuspensionState): void {
  if (susp.state === SUSP_STATE_EXT) {
    susp.force = 0;
    return;
  }
  const fSpring = computeSpringForce(susp);
  const fDamper = computeDamperForce(susp);
  const fInertance = susp.inertance * susp.a;
  const rawForce = (fSpring + fDamper + fInertance) * susp.bellcrank;
  susp.force = Math.max(0, rawForce);
}

/**
 * Port of `SimAxleUpdate(tCar *car, int index)` from `simuv5/axle.cpp`
 * Updates Anti-Roll Bar (ARB) lateral load transfer and 3rd/Heave Spring force.
 */
export function simAxleUpdate(
  axle: SimAxleState,
  rightSusp: SimSuspensionState,
  leftSusp: SimSuspensionState,
  dt: number
): void {
  const xR = rightSusp.x;
  const xL = leftSusp.x;

  // Differential roll travel across the axle:
  // If right wheel is compressed more than left (xR > xL), ARB adds upward force to right wheel
  // and subtracts from left wheel (resisting body roll).
  const deltaRoll = xR - xL;
  const arbForceMag = axle.arbStiffness * deltaRoll;
  axle.arbForce[0] = arbForceMag;  // Right wheel
  axle.arbForce[1] = -arbForceMag; // Left wheel

  // Third / Heave spring acts on average axle compression 0.5 * (xR + xL)
  axle.heaveSusp.x = 0.5 * (xR + xL);
  simSuspCheckIn(axle.heaveSusp, dt);
  simSuspUpdate(axle.heaveSusp);
  axle.thirdForcePerWheel = 0.5 * axle.heaveSusp.force;
}

/**
 * Assetto Corsa–style tyre model driven by the VF26 `.tyre` data.
 *
 * - Load-sensitive friction:   μ = D_REF · (Fz / FZ0)^(LS_EXP − 1)   (separate X / Y)
 * - Peak slip:                 FRICTION_LIMIT_ANGLE (lateral) and peak slip ratio (longitudinal)
 * - Combined slip:             normalised slip vector s = |(κ/κpk, tanα/tanαpk)|, friction ellipse
 * - Slip curve:                smooth rise to the peak at s = 1, then falls toward FALLOFF_LEVEL
 * - Camber:                    1 + DCAMBER_0·γ + DCAMBER_1·γ² (γ = camber leaning into the force)
 * - Temperature:               performance curve (tcurve) on a 2-node surface/core thermal model
 * - Transient:                 relaxation-length carcass deflection states (x and y). This gives a
 *                              physically correct low-speed / standstill behaviour (the car is held
 *                              by static friction, no creeping or phantom yaw) without any clamps.
 */

import { Lut } from './lut';
import type { Vf26TyreSpec } from './vf26-data';

export interface TyreRuntime {
  spec: Vf26TyreSpec;
  thermal: Lut;
  tanPeakAngle: number;
  /** Carcass deflection states (m) */
  deflX: number;
  deflY: number;
  /** Surface / core temperatures (°C) */
  surfaceTempC: number;
  coreTempC: number;
  /** Tread wear (0 = new, 1 = destroyed) */
  wear: number;
}

export interface TyreForceInput {
  /** Vertical load (N) */
  fz: number;
  /** Contact-patch velocity in the wheel frame (m/s): x along the wheel heading, y to the left */
  vx: number;
  vy: number;
  /** Rim speed ω·R (m/s) */
  rimSpeed: number;
  /** Camber leaning toward +y (left) relative to the road (rad) */
  camberLeftRad: number;
  /** Surface friction multiplier (asphalt 1.0, kerb, grass …) */
  surfaceGrip: number;
  dt: number;
}

export interface TyreForceOutput {
  /** Longitudinal force in the wheel frame (N, + forward) */
  fx: number;
  /** Lateral force in the wheel frame (N, + left) */
  fy: number;
  /** Self-aligning moment about the vertical axis (Nm, + CCW from above) */
  mz: number;
  /** Signed longitudinal slip ratio (+ traction) */
  slipRatio: number;
  /** Slip angle (rad, + when the patch moves left) */
  slipAngle: number;
  /** Combined normalised slip (1.0 = at the peak of the grip curve) */
  normSlip: number;
  /** Effective friction coefficient actually available (lateral) */
  mu: number;
  /** Grip multiplier from temperature × camber × wear (diagnostics) */
  gripFactor: number;
  /** Power dissipated in the contact patch (W) */
  slipPower: number;
}

const DEG2RAD = Math.PI / 180;
/** Maximum stored normalised slip — beyond this the patch is fully sliding */
const MAX_NORM_SLIP = 5;
/** Below this speed the carcass damping term blends in */
const LOW_SPEED_BLEND_MS = 3;

export function createTyreRuntime(spec: Vf26TyreSpec, initialTempC: number): TyreRuntime {
  return {
    spec,
    thermal: new Lut(spec.thermalCurve),
    tanPeakAngle: Math.tan(spec.frictionLimitAngleDeg * DEG2RAD),
    deflX: 0,
    deflY: 0,
    surfaceTempC: initialTempC,
    coreTempC: initialTempC,
    wear: 0,
  };
}

export function setTyreSpec(t: TyreRuntime, spec: Vf26TyreSpec): void {
  if (t.spec === spec) return;
  t.spec = spec;
  t.thermal = new Lut(spec.thermalCurve);
  t.tanPeakAngle = Math.tan(spec.frictionLimitAngleDeg * DEG2RAD);
}

/** Normalised grip curve: rises smoothly to 1 at s = 1, then decays toward the falloff level. */
function slipCurve(s: number, falloffLevel: number, falloffSpeed: number): number {
  if (s <= 1) {
    const u = 1 - s;
    return 1 - u * u;
  }
  const e = s - 1;
  return falloffLevel + (1 - falloffLevel) * Math.exp(-falloffSpeed * e * e);
}

/**
 * Advances the carcass deflection states and returns the contact forces.
 */
export function computeTyreForces(t: TyreRuntime, inp: TyreForceInput): TyreForceOutput {
  const spec = t.spec;
  const sigmaY = spec.relaxationLength;
  const sigmaX = spec.relaxationLength * 0.7;
  const absVx = Math.abs(inp.vx);
  const slipVelX = inp.rimSpeed - inp.vx; // + when the tyre is driving
  const slipVelY = inp.vy;

  // Relaxation-length carcass dynamics, integrated exactly over dt:
  //   d(defl)/dt = slipVel − |vx|/σ · defl
  const decayX = absVx / sigmaX;
  const decayY = absVx / sigmaY;
  if (decayX > 1e-6) {
    const ssX = slipVelX / decayX;
    const ssY = slipVelY / decayY;
    const ex = Math.exp(-decayX * inp.dt);
    const ey = Math.exp(-decayY * inp.dt);
    t.deflX = ssX + (t.deflX - ssX) * ex;
    t.deflY = ssY + (t.deflY - ssY) * ey;
  } else {
    t.deflX += slipVelX * inp.dt;
    t.deflY += slipVelY * inp.dt;
  }

  if (inp.fz <= 1) {
    // Airborne: carcass relaxes, no force
    t.deflX *= 0.5;
    t.deflY *= 0.5;
    return {
      fx: 0, fy: 0, mz: 0, slipRatio: 0, slipAngle: 0, normSlip: 0, mu: 0, gripFactor: 1, slipPower: 0,
    };
  }

  // Normalised slip components
  let sk = t.deflX / sigmaX / spec.peakSlipRatio;
  let sa = t.deflY / sigmaY / t.tanPeakAngle;
  let s = Math.hypot(sk, sa);
  if (s > MAX_NORM_SLIP) {
    const k = MAX_NORM_SLIP / s;
    t.deflX *= k;
    t.deflY *= k;
    sk *= k;
    sa *= k;
    s = MAX_NORM_SLIP;
  }

  // Load sensitivity (AC: D = D_REF · (Fz/FZ0)^(LS_EXP − 1))
  const loadRatio = Math.max(0.15, inp.fz / spec.fz0);
  let muY = spec.dyRef * Math.pow(loadRatio, spec.lsExpY - 1);
  let muX = spec.dxRef * Math.pow(loadRatio, spec.lsExpX - 1);

  // Temperature: blend of surface and core against the compound performance curve
  const gripTemp = 0.6 * t.surfaceTempC + 0.4 * t.coreTempC;
  const thermal = t.thermal.evaluate(gripTemp);
  const wearMult = 1 - 0.12 * Math.min(1, t.wear);

  // Camber (γ positive when leaning into the lateral force direction)
  const dirY = s > 1e-9 ? -sa / s : 0;
  const gamma = inp.camberLeftRad;
  const camberLat = 1 + spec.dcamber0 * gamma * Math.sign(dirY) * Math.min(1, Math.abs(dirY) * 4) + spec.dcamber1 * gamma * gamma;
  const camberLong = 1 + spec.dcamber1 * gamma * gamma;

  // Sliding-speed sensitivity
  const slideSpeed = Math.hypot(slipVelX, slipVelY) * Math.min(1, Math.max(0, s - 0.6));
  const speedSens = 1 / (1 + spec.speedSensitivity * slideSpeed);

  const common = thermal * wearMult * speedSens * inp.surfaceGrip;
  muY *= common * Math.max(0.75, camberLat);
  muX *= common * Math.max(0.75, camberLong);

  const f = slipCurve(s, spec.falloffLevel, spec.falloffSpeed);
  let fx = 0;
  let fy = 0;
  if (s > 1e-9) {
    fx = (inp.fz * muX * f * sk) / s;
    fy = (-inp.fz * muY * f * sa) / s;
  }

  // Low-speed carcass damping (prevents the deflection spring from ringing at standstill)
  if (absVx < LOW_SPEED_BLEND_MS) {
    const blend = 1 - absVx / LOW_SPEED_BLEND_MS;
    const c = (inp.fz * 3.0) * blend; // N per (m/s) — ζ≈0.3 on the carcass spring, stable at 2 kHz
    fx += c * slipVelX;
    fy -= c * slipVelY;
    const limX = inp.fz * muX;
    const limY = inp.fz * muY;
    fx = Math.max(-limX, Math.min(limX, fx));
    fy = Math.max(-limY, Math.min(limY, fy));
  }

  // Self-aligning torque: pneumatic trail collapses as the tyre reaches its peak
  const contactLength = 2 * Math.sqrt(Math.max(1e-4, spec.radius * (inp.fz / spec.rate)));
  const trail0 = contactLength / 6;
  const absSa = Math.abs(sa);
  const trail = absSa <= 1 ? trail0 * (1 - absSa) * (1 - Math.min(0.6, Math.abs(sk) * 0.3)) : -trail0 * 0.08 * Math.min(1, absSa - 1);
  const mz = -trail * fy;

  const slipPower = Math.abs(fx * slipVelX) + Math.abs(fy * slipVelY);

  return {
    fx,
    fy,
    mz,
    slipRatio: (t.deflX / sigmaX),
    slipAngle: Math.atan(t.deflY / sigmaY),
    normSlip: s,
    mu: muY,
    gripFactor: thermal * wearMult * Math.max(0.75, camberLat),
    slipPower,
  };
}

/**
 * Two-node tyre thermal model (surface tread + carcass core).
 *
 * The mod's thermal block is in an undocumented EVO format, so the coefficients are assumed.
 * They are calibrated on AI lap averages at Rwanda (≈7 kW slip power at a front tyre, ≈11 kW at a
 * rear, ≈53 m/s): over a stint the soft compound's grip temperature settles at ≈85–90 °C (front) and
 * ≈105–115 °C (rear), inside its working window, instead of cooling off the blankets.
 */
export function updateTyreThermal(
  t: TyreRuntime,
  slipPowerW: number,
  fz: number,
  rollSpeedMs: number,
  ambientC: number,
  trackC: number,
  dt: number
): void {
  const surfaceCap = 2600; // J/K
  const coreCap = 21000; // J/K
  const v = Math.abs(rollSpeedMs);

  const slipHeat = 0.45 * slipPowerW;
  const rollingHeat = 0.0105 * fz * v; // carcass hysteresis
  const surfaceToAir = (4 + 0.9 * v) * (t.surfaceTempC - ambientC);
  const surfaceToTrack = (fz > 1 ? 12 : 0) * (t.surfaceTempC - trackC);
  const surfaceToCore = 95 * (t.surfaceTempC - t.coreTempC);
  const coreToAir = (4 + 0.3 * v) * (t.coreTempC - ambientC);

  t.surfaceTempC += ((slipHeat - surfaceToAir - surfaceToTrack - surfaceToCore) / surfaceCap) * dt;
  t.coreTempC += ((rollingHeat + surfaceToCore - coreToAir) / coreCap) * dt;
  t.surfaceTempC = Math.max(ambientC - 5, Math.min(220, t.surfaceTempC));
  t.coreTempC = Math.max(ambientC - 5, Math.min(180, t.coreTempC));

  // Abrasive wear proportional to sliding energy
  t.wear = Math.min(1, t.wear + slipPowerW * dt * 1.6e-10);
}

/**
 * 4-Wheel Contact Patch, Pacejka Magic Formula, Rotational Spin & Thermal/Wear Solver
 *
 * Ported directly from Speed Dreams / TORCS `simuv5/wheel.cpp`:
 * - `SimWheelConfig`: computes Pacejka stiffness `mfB = tan(PI / (2 * mfC)) / slipMax`
 *   from shape factor `mfC`, curvature `mfE`, and peak slip `slipMax`.
 * - `SimWheelUpdateRide`: queries road height/normal under each wheel, updates suspension travel
 *   `SimSuspCheckIn` & `SimSuspUpdate`, and computes dynamic ride height & effective camber.
 * - `SimWheelUpdateForce`: computes wheel hub ground velocity in tire local frame,
 *   longitudinal slip `sx`, lateral slip `sy`, combined slip `s = hypot(sx, sy)`,
 *   load-sensitive friction `mu = mu0 * (lfMin + (lfMax - lfMin) * exp(lfK * Fz / opLoad))`,
 *   camber thrust `(1 + 0.05 * sin((-camber + casterCamber) * 18))`,
 *   Pacejka Magic Formula `F = Fz * mu * sin(C * atan(B * (1 - E) * sb + E * atan(B * sb)))`,
 *   directional components `Ft = -F * sx / s`, `Fn = -F * sy / s`,
 *   and pneumatic trail self-aligning torque `torqueAlign`.
 * - `SimWheelUpdateRotation`: integrates wheel angular velocity `spinVel` from drive torque,
 *   road reaction torque `spinTq = Ft * radius`, and opposing hydraulic brake torque `brkTq`.
 * - `SimWheelUpdateTire`: hysteresis heating, convective air cooling, and tread wear degradation.
 */

import { SurfaceType, TireCompound } from '@/types/f1';
import { SimWheelConfig, TIRE_COMPOUND_PRESETS, WheelCornerIndex } from './car-configs';
import { SimAxleState, SimSuspensionState, simSuspCheckIn, simSuspUpdate, SUSP_STATE_EXT } from './susp';
import { SimWheelBrakeState } from './drivetrain';

export interface SimWheelState {
  index: WheelCornerIndex;
  /** World-space wheel contact patch position (x, y, z in physics frame) */
  worldPos: { x: number; y: number; z: number };
  /** Static position relative to chassis GC (m, +x forward, +y left) */
  staticPos: { x: number; y: number; z: number };
  /** Hub velocity in car body frame (m/s) */
  bodyVel: { x: number; y: number; z: number };
  /** Steering angle of this wheel (rad, +left, -right) */
  steerRad: number;
  /** Road surface elevation under this wheel (m) */
  zRoad: number;
  /** Surface type under this wheel */
  surfaceType: SurfaceType;
  /** Surface grip multiplier (1.0 asphalt, 0.88 kerb, 0.62 runoff, 0.45 grass) */
  surfaceFrictionMult: number;
  /** Surface bumpiness amplitude (m) */
  surfaceBumpM: number;
  /** Dynamic ride height at this corner (m) */
  rideHeight: number;
  /** Effective camber relative to road plane (rad) */
  effCamberRad: number;
  /** Wheel angular spin velocity (rad/s) */
  spinVel: number;
  /** Previous step wheel angular spin velocity (rad/s) */
  preSpinVel: number;
  /** Visual cumulative wheel rotation angle (rad) */
  rotationRad: number;
  /** Normal vertical load Fz at contact patch (N, >= 0) */
  fzN: number;
  /** Longitudinal tire force in tire frame Ft (N) */
  ftN: number;
  /** Lateral tire force in tire frame Fn (N) */
  fnN: number;
  /** Forces resolved into car body frame (x: longitudinal, y: lateral, z: vertical) (N) */
  forcesCar: { x: number; y: number; z: number };
  /** Reaction torques on chassis (x, y, z) (Nm) */
  torquesCar: { x: number; y: number; z: number };
  /** Longitudinal slip ratio sx (dimensionless) */
  slipRatio: number;
  /** Lateral slip angle alpha (rad) */
  slipAngleRad: number;
  /** Combined normalized slip s / slipMax (0..1+ where 1.0 = peak grip) */
  combinedSlipNorm: number;
  /** Raw combined slip magnitude hypot(sx, sy) */
  combinedSlipRaw: number;
  /** Effective friction coefficient mu after load sensitivity & surface */
  effectiveMu: number;
  /** Self-aligning torque around kingpin axis (Nm) */
  torqueAlignNm: number;
  /** Reaction torque opposing wheel spin = Ft * radius (Nm) */
  spinTqNm: number;
  /** Rolling resistance force magnitude (N) */
  rollResN: number;
  /** Dynamic tire carcass/tread temperature (°C) */
  tempC: number;
  /** Tread condition (1.0 = fresh 100%, 0.1 = worn out) */
  treadCondition: number;
  /** Tire wear percentage (0..100%) */
  wearPct: number;
  /** Pacejka stiffness factor B */
  mfB: number;
  /** Pacejka shape factor C */
  mfC: number;
  /** Pacejka curvature factor E */
  mfE: number;
  /** Peak slip threshold */
  slipMax: number;
}

export function initWheelState(
  index: WheelCornerIndex,
  cfg: SimWheelConfig,
  statGcX: number,
  statGcY: number,
  compound: TireCompound = 'soft'
): SimWheelState {
  const preset = TIRE_COMPOUND_PRESETS[compound];
  const mfC = preset.mfC;
  const mfE = preset.mfE;
  const slipMax = preset.slipMax;
  // Exact Pacejka B calculation from SimWheelConfig in wheel.cpp lines 269-278
  const mfB = Math.tan(Math.PI / (2.0 * mfC)) / Math.max(0.02, slipMax);

  return {
    index,
    worldPos: { x: 0, y: 0, z: 0 },
    staticPos: {
      x: cfg.relPosX - statGcX,
      y: cfg.relPosY - statGcY,
      z: -cfg.rideHeight,
    },
    bodyVel: { x: 0, y: 0, z: 0 },
    steerRad: 0,
    zRoad: 0,
    surfaceType: 'asphalt',
    surfaceFrictionMult: 1.0,
    surfaceBumpM: 0,
    rideHeight: cfg.rideHeight,
    effCamberRad: cfg.camberRad,
    spinVel: 0,
    preSpinVel: 0,
    rotationRad: 0,
    fzN: cfg.opLoad * 0.65,
    ftN: 0,
    fnN: 0,
    forcesCar: { x: 0, y: 0, z: cfg.opLoad * 0.65 },
    torquesCar: { x: 0, y: 0, z: 0 },
    slipRatio: 0,
    slipAngleRad: 0,
    combinedSlipNorm: 0,
    combinedSlipRaw: 0,
    effectiveMu: cfg.mu0 * preset.muMultiplier,
    torqueAlignNm: 0,
    spinTqNm: 0,
    rollResN: 0,
    tempC: cfg.tempInitC,
    treadCondition: 1.0,
    wearPct: 0,
    mfB,
    mfC,
    mfE,
    slipMax,
  };
}

export function updateWheelCompoundParams(
  wheel: SimWheelState,
  compound: TireCompound
): void {
  const preset = TIRE_COMPOUND_PRESETS[compound];
  wheel.mfC = preset.mfC;
  wheel.mfE = preset.mfE;
  wheel.slipMax = preset.slipMax;
  wheel.mfB = Math.tan(Math.PI / (2.0 * wheel.mfC)) / Math.max(0.02, wheel.slipMax);
}

/**
 * Port of `SimWheelUpdateRide` from `simuv5/wheel.cpp`
 */
export function simWheelUpdateRide(
  wheel: SimWheelState,
  cfg: SimWheelConfig,
  susp: SimSuspensionState,
  chassisRollRad: number,
  roadBankRad: number,
  dt: number
): void {
  // Effective road height including micro-kerb/rumble bump
  const effZRoad = wheel.zRoad + wheel.surfaceBumpM;

  // Suspension compression x:
  // In steady state, susp.x = susp.spring.x0 when wheel.worldPos.z === effZRoad.
  // Vertical displacement of wheel hub relative to road compresses/extends suspension:
  const hubClearance = wheel.worldPos.z - effZRoad;
  const targetSuspX = susp.spring.x0 - hubClearance;

  susp.x = targetSuspX;
  simSuspCheckIn(susp, dt);
  simSuspUpdate(susp);

  // Dynamic corner ride height
  wheel.rideHeight = Math.max(
    0.002,
    cfg.rideHeight - (susp.x / susp.bellcrank - susp.spring.x0)
  );

  // Effective camber relative to road plane (sign flipped between right and left wheel)
  const sideSign = wheel.index % 2 === 0 ? -1 : 1; // 0,2 = Right; 1,3 = Left
  wheel.effCamberRad = cfg.camberRad + sideSign * (chassisRollRad - roadBankRad) * 0.45;
}

/**
 * Port of `SimWheelUpdateForce` and `SimWheelUpdateTire` from `simuv5/wheel.cpp`
 */
export function simWheelUpdateForce(
  wheel: SimWheelState,
  cfg: SimWheelConfig,
  susp: SimSuspensionState,
  axle: SimAxleState,
  aeroCornerLoadN: number,
  compound: TireCompound,
  ambientTempC: number,
  dt: number
): void {
  const isLeftOnAxle = wheel.index % 2 === 1 ? 1 : 0;
  const arbF = axle.arbForce[isLeftOnAxle];

  // Total vertical normal force Fz acting on contact patch (from wheel.cpp lines 632-648)
  const rawFz =
    susp.state === SUSP_STATE_EXT
      ? 0
      : susp.force + axle.thirdForcePerWheel + arbF + aeroCornerLoadN;

  const fz = Math.max(0, rawFz);
  wheel.fzN = fz;
  wheel.forcesCar.z = fz;

  // Update spin velocity history
  wheel.preSpinVel = wheel.spinVel;

  if (fz <= 1.0) {
    // Wheel is airborne
    wheel.ftN = 0;
    wheel.fnN = 0;
    wheel.forcesCar.x = 0;
    wheel.forcesCar.y = 0;
    wheel.slipRatio = 0;
    wheel.slipAngleRad = 0;
    wheel.combinedSlipNorm = 0;
    wheel.combinedSlipRaw = 0;
    wheel.torqueAlignNm = 0;
    wheel.spinTqNm = 0;
    wheel.rollResN = 0;
    // Convective air cooling while airborne
    const vHub = Math.hypot(wheel.bodyVel.x, wheel.bodyVel.y);
    wheel.tempC -= cfg.airCoolingMult * (1.0 + 0.025 * vHub) * (wheel.tempC - ambientTempC) * dt;
    return;
  }

  // Total wheel steer angle = steering rack angle + static toe angle
  const totalSteer = wheel.steerRad + cfg.toeRad;
  const cosA = Math.cos(totalSteer);
  const sinA = Math.sin(totalSteer);

  // Horizontal wheel hub velocity in tire local frame (from wheel.cpp lines 655-656)
  const vx = wheel.bodyVel.x * cosA + wheel.bodyVel.y * sinA;
  const vy = -wheel.bodyVel.x * sinA + wheel.bodyVel.y * cosA;

  // Tangential wheel rim speed
  const wrl = wheel.spinVel * cfg.radius;

  // Slip velocity components
  // Crucial low-speed relaxation (ported from wheel.cpp lines 659-705 & Pacejka relaxation length):
  // When both hub speed |vx| and rim speed |wrl| are near zero, slip vanishes smoothly.
  // Specifically, lateral slip sy ONLY depends on lateral hub velocity vy (NOT steer angle alone!),
  // so steering while stationary (vx = 0, vy = 0) produces strictly sy = 0 and Fn = 0!
  const absVx = Math.abs(vx);
  const absVy = Math.abs(vy);
  const absWrl = Math.abs(wrl);

  // Relaxation denominator (prevents division by zero at standstill while preserving launch traction)
  const denomLong = Math.max(1.25, absVx, absWrl * 0.65);
  const denomLat = Math.max(1.6, absVx, absVy * 0.45);

  let sx = (vx - wrl) / denomLong;
  let sy = vy / denomLat;

  // At ultra-low speed (< 0.08 m/s) with no wheel spin, damp micro-oscillations to zero
  if (absVx < 0.08 && absVy < 0.08 && absWrl < 0.08) {
    const lowSpeedFade = Math.max(absVx, absVy, absWrl) / 0.08;
    sx *= lowSpeedFade;
    sy *= lowSpeedFade;
  }

  sx = Math.max(-2.5, Math.min(2.5, sx));
  sy = Math.max(-2.0, Math.min(2.0, sy));

  const s = Math.hypot(sx, sy);
  wheel.slipRatio = -sx; // Positive when accelerating (wrl > vx), negative when braking
  wheel.slipAngleRad = Math.atan2(vy, Math.max(0.5, absVx));
  wheel.combinedSlipRaw = s;
  wheel.combinedSlipNorm = s / Math.max(0.02, wheel.slipMax);

  // Load sensitivity from wheel.cpp line 732:
  // mu = wheel->mu * (wheel->lfMin + (wheel->lfMax - wheel->lfMin) * exp(wheel->lfK * Fn / wheel->opLoad))
  const preset = TIRE_COMPOUND_PRESETS[compound];
  const loadSens =
    cfg.lfMin + (cfg.lfMax - cfg.lfMin) * Math.exp((cfg.lfK * fz) / cfg.opLoad);

  // Camber thrust multiplier from wheel.cpp line 728:
  // Dynamic camber thrust acts laterally during cornering/steering; keep longitudinal traction symmetric
  const casterCamber = cfg.casterRad * Math.sin(wheel.steerRad);
  const staticCamberMult = 1.0 + 0.05 * Math.sin(-cfg.camberRad * 18.0);
  const latCamberMult =
    (1.0 + 0.05 * Math.sin((-wheel.effCamberRad + casterCamber) * 18.0)) /
    Math.max(0.8, staticCamberMult);

  // Thermal grip window factor from SimWheelUpdateTire in wheel.cpp lines 830-850
  const tempDiff = wheel.tempC - preset.optimalTempC;
  const tempMult = Math.max(0.84, Math.min(1.03, 1.0 - 0.00014 * tempDiff * tempDiff));

  // Tread wear factor
  const wearMult = Math.max(0.65, wheel.treadCondition);

  const mu =
    cfg.mu0 *
    preset.muMultiplier *
    loadSens *
    staticCamberMult *
    tempMult *
    wearMult *
    wheel.surfaceFrictionMult;
  wheel.effectiveMu = mu;

  // Pacejka Magic Formula from wheel.cpp lines 725-734:
  // F = Fn * mu * sin(mfC * atan(mfB * (1 - mfE) * s + mfE * atan(mfB * s)))
  const bS = wheel.mfB * s;
  const magicNorm = Math.sin(
    wheel.mfC * Math.atan(bS * (1.0 - wheel.mfE) + wheel.mfE * Math.atan(bS))
  );
  const fTotal = fz * mu * magicNorm;

  // Resolve combined force into longitudinal (Ft) and lateral (Fn) tire components (wheel.cpp lines 738-745)
  let ft = 0;
  let fn = 0;
  if (s > 1e-6) {
    ft = (-fTotal * sx) / s;
    fn = ((-fTotal * sy) / s) * latCamberMult;
  }

  // Pneumatic trail self-aligning torque from wheel.cpp line 748:
  // wheel->torqueAlign = wheel->AlignTqFactor * wheel->Forcen * sy / (1.0f + sy * sy)
  wheel.torqueAlignNm = (cfg.alignTqFactor * fn * sy) / (1.0 + sy * sy);
  wheel.spinTqNm = ft * cfg.radius;

  wheel.ftN = ft;
  wheel.fnN = fn;

  // Rotate tire forces back into car body frame (wheel.cpp lines 768-769)
  wheel.forcesCar.x = ft * cosA - fn * sinA;
  wheel.forcesCar.y = ft * sinA + fn * cosA;

  // Rolling resistance from wheel.cpp line 771
  const surfaceRollMult =
    wheel.surfaceType === 'grass' ? 3.5 : wheel.surfaceType === 'runoff' ? 1.8 : 1.0;
  wheel.rollResN = fz * cfg.rollingResistance * surfaceRollMult;

  // Tire thermal & wear update (`SimWheelUpdateTire` in `wheel.cpp` lines 815-870)
  const slipWork = Math.abs((vx - wrl) * ft + vy * fn);
  const vHub = Math.hypot(vx, vy);
  const heatGain = cfg.heatingMult * slipWork * dt;
  const heatLoss =
    cfg.airCoolingMult * (1.0 + 0.028 * vHub) * (wheel.tempC - ambientTempC) * dt;
  wheel.tempC = Math.max(ambientTempC, Math.min(155, wheel.tempC + heatGain - heatLoss));

  // Tread degradation proportional to slip work & compound wear rate
  const wearDelta = slipWork * 2.4e-9 * preset.wearRateMultiplier * dt;
  wheel.treadCondition = Math.max(0.15, wheel.treadCondition - wearDelta);
  wheel.wearPct = Math.min(100, (1.0 - wheel.treadCondition) * 100);
}

/**
 * Port of `SimWheelUpdateRotation` from `simuv5/wheel.cpp`
 */
export function simWheelUpdateRotation(
  wheel: SimWheelState,
  cfg: SimWheelConfig,
  brake: SimWheelBrakeState,
  driveInTqNm: number,
  effectiveInertia: number,
  vxMs: number,
  throttleCmd: number,
  dt: number
): void {
  const totalI = Math.max(0.5, effectiveInertia);

  // F1 ECU Launch & Traction Torque Control: regulate drive torque when wheel rim speed
  // exceeds optimal Pacejka peak slip window so the tire stays at peak traction (magicNorm ~ 1.0)
  let effectiveDriveTq = driveInTqNm;
  if (driveInTqNm > 0 && vxMs >= 0) {
    const rimSpeed = wheel.spinVel * cfg.radius;
    const optSlipSpeed = vxMs + Math.max(1.6, vxMs) * (wheel.slipMax * 1.08);
    if (rimSpeed > optSlipSpeed) {
      const overSpeed = rimSpeed - optSlipSpeed;
      const trim = Math.max(0.0, 1.0 - overSpeed * 0.45);
      effectiveDriveTq =
        wheel.spinTqNm + (driveInTqNm - wheel.spinTqNm) * trim;
    }
  }

  // Accelerate wheel spin from drive torque minus road contact reaction torque (wheel.cpp line 794)
  const netSpinTq = effectiveDriveTq - wheel.spinTqNm;
  wheel.spinVel += (netSpinTq / totalI) * dt;

  // Apply opposing hydraulic brake torque (wheel.cpp lines 798-808):
  // If brake impulse exceeds angular momentum, wheel locks (spinVel = 0)
  if (brake.tqNm > 0.01) {
    const brkDeltaSpin =
      -Math.sign(wheel.spinVel) * (brake.tqNm / (cfg.inertia + cfg.brakeInertia)) * dt;
    if (wheel.spinVel * (wheel.spinVel + brkDeltaSpin) <= 0.0) {
      wheel.spinVel = 0.0;
    } else {
      wheel.spinVel = Math.max(0.0, wheel.spinVel + brkDeltaSpin);
    }
  }

  // Stop residual micro-spin when car is parked with no throttle
  if (Math.abs(vxMs) < 0.05 && throttleCmd < 0.01 && Math.abs(wheel.spinVel) < 0.25) {
    wheel.spinVel = 0;
  }

  wheel.rotationRad = (wheel.rotationRad + wheel.spinVel * dt) % (Math.PI * 2000);
}

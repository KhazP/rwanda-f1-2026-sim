/**
 * Aerodynamics & Active Wing Solver
 *
 * Ported directly from Speed Dreams / TORCS `simuv5/aero.cpp`:
 * - `SimAeroConfig`, `SimAeroUpdate` (velocity-squared drag, yaw drag magnification,
 *   and ground-effect undertray suction sensitive to 4-wheel ride height:
 *   `hm = 1.5 * sum(rideHeight); hm = 2 * exp(-3 * hm^4)`)
 * - `SimWingConfig`, `SimWingUpdate` (front & rear wing angle-of-attack downforce
 *   and induced drag, extended with 2026 FIA Z-Mode / X-Mode active flap actuation)
 */

import { AeroMode } from '@/types/f1';
import { SimAerodynamicsConfig, SimAeroWingConfig } from './car-configs';

export interface SimWingState {
  /** Current flap angle of attack (rad) */
  angleRad: number;
  /** Target flap angle of attack (rad) */
  targetAngleRad: number;
  /** Drag coefficient Kx = -0.5 * rho * area * dragMult */
  kx: number;
  /** Lift/downforce coefficient Kz = 4.0 * kx * downforceMult */
  kz: number;
  /** Longitudinal position relative to GC (m) */
  staticPosX: number;
  /** Vertical position relative to GC (m) */
  staticPosZ: number;
  /** Longitudinal aerodynamic force Fx (N, negative = drag) */
  forceX: number;
  /** Vertical aerodynamic force Fz (N, negative = downward in TORCS, we also expose positive downforceN) */
  forceZ: number;
}

export interface SimAeroState {
  /** Base drag coefficient CdBody = 0.5 * rho * Cx * frontalArea */
  cdBody: number;
  /** Ground-effect lift coefficients [front, rear] */
  clift: [number, number];
  /** Current ground-effect vertical forces [front, rear] (N, negative = downward) */
  lift: [number, number];
  /** Current body + induced drag force (N, negative = rearward) */
  drag: number;
  /** Front and rear active wings */
  wings: [SimWingState, SimWingState];
  /** Current active aero mode */
  aeroMode: AeroMode;
  /** Smooth transition factor (0 = Z-Mode high downforce, 1 = X-Mode low drag) */
  xModeBlend: number;
  /** Total positive downforce magnitude (N) */
  totalDownforceN: number;
  /** Front positive downforce magnitude (N) */
  frontDownforceN: number;
  /** Rear positive downforce magnitude (N) */
  rearDownforceN: number;
  /** Total positive drag magnitude (N) */
  totalDragN: number;
  /** Ground effect suction multiplier hm */
  groundEffectFactor: number;
}

function createWingState(cfg: SimAeroWingConfig, airDensity: number): SimWingState {
  // From SimWingConfig in aero.cpp: Kx = -0.5 * airDensity * area * dragMult, Kz = Kx * downforceMult
  const kx = -0.5 * airDensity * cfg.area * cfg.dragMult;
  const kz = kx * cfg.downforceMult;
  return {
    angleRad: cfg.angleZModeRad,
    targetAngleRad: cfg.angleZModeRad,
    kx,
    kz,
    staticPosX: cfg.posX,
    staticPosZ: cfg.posZ,
    forceX: 0,
    forceZ: 0,
  };
}

export function initSimAeroState(cfg: SimAerodynamicsConfig): SimAeroState {
  // From SimAeroConfig in aero.cpp:
  const cdBody = 0.5 * cfg.airDensity * cfg.cx * cfg.frontalArea;
  const clift0 = 0.25 * cfg.airDensity * cfg.frontClift;
  const clift1 = 0.25 * cfg.airDensity * cfg.rearClift;

  return {
    cdBody,
    clift: [clift0, clift1],
    lift: [0, 0],
    drag: 0,
    wings: [
      createWingState(cfg.frontWing, cfg.airDensity),
      createWingState(cfg.rearWing, cfg.airDensity),
    ],
    aeroMode: 'Z-MODE',
    xModeBlend: 0,
    totalDownforceN: 0,
    frontDownforceN: 0,
    rearDownforceN: 0,
    totalDragN: 0,
    groundEffectFactor: 1.0,
  };
}

/**
 * Port of `SimAeroUpdate` and `SimWingUpdate` from Speed Dreams `simuv5/aero.cpp`
 */
export function updateSimAero(
  state: SimAeroState,
  cfg: SimAerodynamicsConfig,
  vxMs: number,
  vyMs: number,
  rideHeightsM: [number, number, number, number],
  requestedMode: AeroMode,
  dt: number
): void {
  state.aeroMode = requestedMode;
  const targetBlend = requestedMode === 'X-MODE' ? 1.0 : 0.0;
  // Hydraulic wing actuator response (~120ms full travel)
  const actuatorRate = 8.5;
  state.xModeBlend += (targetBlend - state.xModeBlend) * Math.min(1.0, actuatorRate * dt);

  // Update front and rear wing angles
  state.wings[0].targetAngleRad =
    cfg.frontWing.angleZModeRad +
    (cfg.frontWing.angleXModeRad - cfg.frontWing.angleZModeRad) * state.xModeBlend;
  state.wings[1].targetAngleRad =
    cfg.rearWing.angleZModeRad +
    (cfg.rearWing.angleXModeRad - cfg.rearWing.angleZModeRad) * state.xModeBlend;

  state.wings[0].angleRad = state.wings[0].targetAngleRad;
  state.wings[1].angleRad = state.wings[1].targetAngleRad;

  // From SimAeroUpdate in aero.cpp:
  // hm = 1.5 * (wheel[0].rideHeight + wheel[1].rideHeight + wheel[2].rideHeight + wheel[3].rideHeight)
  // hm = hm * hm; hm = hm * hm; hm = 2 * exp(-3 * hm);
  const sumRideHeight =
    Math.max(0.005, rideHeightsM[0]) +
    Math.max(0.005, rideHeightsM[1]) +
    Math.max(0.005, rideHeightsM[2]) +
    Math.max(0.005, rideHeightsM[3]);
  let hm = 1.5 * sumRideHeight;
  hm = hm * hm;
  hm = hm * hm;
  hm = 2.0 * Math.exp(-3.0 * hm);
  state.groundEffectFactor = hm;

  const v2 = vxMs * vxMs + vyMs * vyMs;
  const airSpeed2 = vxMs > 0 ? vxMs * vxMs : 0;

  // Yaw angle drag magnification: 1 + E_d * tan^2(beta) (from aero.cpp line 69)
  let yawDragMult = 1.0;
  if (Math.abs(vxMs) > 1.0) {
    const tanBeta = Math.min(1.5, Math.abs(vyMs / vxMs));
    yawDragMult = 1.0 + 0.35 * tanBeta * tanBeta;
  }

  // Body parasitic drag + ground-effect induced drag
  const signVx = vxMs >= 0 ? -1.0 : 1.0;
  state.drag = signVx * v2 * state.cdBody * yawDragMult * (1.0 + 0.08 * hm * (1.0 - 0.45 * state.xModeBlend));

  // Ground-effect undertray suction (negative Z in TORCS = downward)
  state.lift[0] = -state.clift[0] * airSpeed2 * hm;
  state.lift[1] = -state.clift[1] * airSpeed2 * hm;

  // SimWingUpdate for Front Wing (0) and Rear Wing (1)
  for (let i = 0; i < 2; i++) {
    const wing = state.wings[i];
    if (vxMs > 0.0) {
      const sinA = Math.sin(wing.angleRad);
      // From SimWingUpdate in aero.cpp:
      // wing->forces.x = wing->Kx * vt2 * (1.0f + (tdble)car->dammage / 10000.0) * sina;
      // wing->forces.z = wing->Kz * vt2 * sina;
      wing.forceX = wing.kx * airSpeed2 * sinA;
      wing.forceZ = wing.kz * airSpeed2 * sinA;
    } else {
      wing.forceX = 0;
      wing.forceZ = 0;
    }
  }

  const frontDownforce = Math.max(0, -(state.lift[0] + state.wings[0].forceZ));
  const rearDownforce = Math.max(0, -(state.lift[1] + state.wings[1].forceZ));
  state.frontDownforceN = frontDownforce;
  state.rearDownforceN = rearDownforce;
  state.totalDownforceN = frontDownforce + rearDownforce;
  state.totalDragN = Math.abs(state.drag + state.wings[0].forceX + state.wings[1].forceX);
}

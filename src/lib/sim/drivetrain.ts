/**
 * Steering, Engine, Gearbox, Clutch, Differential & Brake System Solver
 *
 * Ported directly from Speed Dreams / TORCS `simuv5`:
 * - `steer.cpp`: `SimSteerUpdate` (Ackermann steering geometry + steering rate limit)
 * - `engine.cpp`: `SimEngineUpdateTq`, `SimEngineUpdateRpm` (piecewise linear torque curve,
 *   parabolic + linear engine braking, rev limiter, flywheel rotational inertia,
 *   extended with 2026 FIA 350 kW MGU-K electrical deployment, `/boost` override, and regen)
 * - `transmission.cpp`: `SimGearboxUpdate`, `SimTransmissionUpdate` (8-speed seamless gearbox,
 *   effective reflected drivetrain inertia `driveI` / `freeI`, clutch transfer)
 * - `differential.cpp`: `SimDifferentialUpdate` (1.5-way Salisbury Limited Slip Differential
 *   with `dSlipMax` power locking, `dCoastSlipMax` coast locking, `lockInputTq` preload,
 *   and spider gear torque split)
 * - `brake.cpp`: `SimBrakeSystemUpdate`, `SimBrakeUpdate` (hydraulic brake bias repartition,
 *   disc torque `coeff * pressure`, brake disc thermal model)
 */

import { ERSMode } from '@/types/f1';
import {
  SimBrakeSystemConfig,
  SimCarConfig,
  SimEngineConfig,
  SimSteerConfig,
  SimTransmissionConfig,
} from './car-configs';

const RPM2RADS = (2.0 * Math.PI) / 60.0;
const RADS2RPM = 60.0 / (2.0 * Math.PI);

export interface SimSteerState {
  /** Center steering rack angle (rad, +left, -right) */
  steerRad: number;
  /** Front Right wheel steer angle (rad, with Ackermann) */
  wheelSteerFR: number;
  /** Front Left wheel steer angle (rad, with Ackermann) */
  wheelSteerFL: number;
}

export interface SimEngineState {
  /** Engine angular velocity (rad/s) */
  rads: number;
  /** Current engine RPM */
  rpm: number;
  /** Net ICE + MGU-K torque at crankshaft (Nm) */
  tqCrankNm: number;
  /** Pure ICE torque (Nm) */
  tqIceNm: number;
  /** Pure MGU-K torque at crankshaft (Nm, positive = deploy, negative = harvest) */
  tqMgukNm: number;
  /** Current MGU-K electrical power (kW, positive = deploy, negative = harvest) */
  mgukPowerKw: number;
  /** Remaining usable battery energy (J) */
  ersEnergyJ: number;
  /** Remaining manual override /boost time (s) */
  boostRemainingS: number;
  /** Cooldown before next /boost activation (s) */
  boostCooldownS: number;
  /** Current ERS deployment mode */
  ersMode: ERSMode;
  /** Current fuel remaining (kg) */
  fuelKg: number;
}

export interface SimClutchState {
  /** Clutch engagement state (1.0 = fully engaged, 0.0 = disengaged) */
  transferValue: number;
  /** Time remaining in automatic launch/shift clutch release (s) */
  timeToReleaseS: number;
}

export interface SimGearboxState {
  /** Current engaged gear (-1 = Reverse, 0 = Neutral, 1..8 = Forward gears) */
  gear: number;
  /** Target gear during shift */
  gearNext: number;
  /** Remaining shift engagement time (s) */
  timeToEngageS: number;
  /** Overall ratio = gearRatio * finalDriveRatio */
  overallRatios: number[];
  /** Reflected drivetrain inertia with clutch engaged (kg·m²) */
  driveI: number[];
  /** Reflected drivetrain inertia with clutch disengaged (kg·m²) */
  freeI: number[];
  /** Current active overall ratio */
  curOverallRatio: number;
  /** Current reflected drivetrain inertia at rear axle (kg·m²) */
  curI: number;
  /** Cooldown between automatic gear shifts (s) */
  autoShiftCooldownS: number;
}

export interface SimDifferentialState {
  /** Lock state (1 = locked, 0 = unlocked/slipping) */
  locked: boolean;
  /** Output drive torque to [Right Rear, Left Rear] wheels (Nm) */
  outTq: [number, number];
  /** Output reflected rotational inertia to [Right Rear, Left Rear] wheels (kg·m²) */
  outI: [number, number];
}

export interface SimWheelBrakeState {
  /** Hydraulic brake line pressure at caliper (Pa) */
  pressurePa: number;
  /** Opposing brake torque magnitude (Nm) */
  tqNm: number;
  /** Normalized disc thermal glow (0..1) */
  tempNorm: number;
  /** Brake disc temperature (°C) */
  tempC: number;
  /** Brake torque coefficient = 0.5 * diam * area * mu */
  coeff: number;
  /** Effective disc radius (m) */
  radius: number;
  /** ABS modulation factor (0..1) */
  absFactor: number;
}

export interface SimDrivetrainState {
  steer: SimSteerState;
  engine: SimEngineState;
  clutch: SimClutchState;
  gearbox: SimGearboxState;
  rearDiff: SimDifferentialState;
  brakes: [SimWheelBrakeState, SimWheelBrakeState, SimWheelBrakeState, SimWheelBrakeState];
}

export function initDrivetrainState(cfg: SimCarConfig): SimDrivetrainState {
  const fRatio = cfg.transmission.rearDifferential.ratio;
  const overallRatios: number[] = [];
  const driveI: number[] = [];
  const freeI: number[] = [];

  for (let i = 0; i < cfg.transmission.gearRatios.length; i++) {
    const gRatio = cfg.transmission.gearRatios[i];
    const gI = cfg.transmission.gearInertias[i] ?? 0.0025;
    if (gRatio === 0) {
      overallRatios.push(0);
      driveI.push(0);
      freeI.push(0);
    } else {
      const ov = gRatio * fRatio;
      overallRatios.push(ov);
      // From SimTransmissionReConfig in transmission.cpp:
      // driveI[i] = (engine.I + gearI[i]) * (gRatio^2 * fRatio^2)
      driveI.push((cfg.engine.inertia + gI) * ov * ov);
      freeI.push(gI * ov * ov);
    }
  }

  const brakes = cfg.wheels.map((w) => ({
    pressurePa: 0,
    tqNm: 0,
    tempNorm: 0.15,
    tempC: 340,
    coeff: 0.5 * w.brakeDiameter * w.brakeArea * w.brakeMu,
    radius: w.brakeDiameter * 0.5,
    absFactor: 1.0,
  })) as [SimWheelBrakeState, SimWheelBrakeState, SimWheelBrakeState, SimWheelBrakeState];

  // Start in 1st gear ready to launch
  const initialGear = 1;
  const initialIdx = initialGear + 1;

  return {
    steer: {
      steerRad: 0,
      wheelSteerFR: 0,
      wheelSteerFL: 0,
    },
    engine: {
      rads: cfg.engine.tickoverRpm * RPM2RADS,
      rpm: cfg.engine.tickoverRpm,
      tqCrankNm: 0,
      tqIceNm: 0,
      tqMgukNm: 0,
      mgukPowerKw: 0,
      ersEnergyJ: cfg.engine.ersBatteryCapacityJ,
      boostRemainingS: 0,
      boostCooldownS: 0,
      ersMode: 'BALANCED',
      fuelKg: cfg.initialFuelKg,
    },
    clutch: {
      transferValue: 1.0,
      timeToReleaseS: 0,
    },
    gearbox: {
      gear: initialGear,
      gearNext: initialGear,
      timeToEngageS: 0,
      overallRatios,
      driveI,
      freeI,
      curOverallRatio: overallRatios[initialIdx],
      curI: driveI[initialIdx],
      autoShiftCooldownS: 0,
    },
    rearDiff: {
      locked: false,
      outTq: [0, 0],
      outI: [
        driveI[initialIdx] * 0.5 + cfg.wheels[2].inertia,
        driveI[initialIdx] * 0.5 + cfg.wheels[3].inertia,
      ],
    },
    brakes,
  };
}

/**
 * Port of `SimSteerUpdate` from `simuv5/steer.cpp`
 * Applies steering rate limit and exact Ackermann geometry across the front track.
 */
export function simSteerUpdate(
  steerState: SimSteerState,
  cfg: SimSteerConfig,
  steerCmd: number, // -1 (right) to +1 (left) in TORCS convention
  wheelbaseM: number,
  wheeltrackM: number,
  dt: number
): void {
  let targetSteer = steerCmd * cfg.steerLockRad;
  const stDelta = targetSteer - steerState.steerRad;
  const maxStep = cfg.maxSteerSpeedRadS * dt;

  if (Math.abs(stDelta) > maxStep) {
    targetSteer = steerState.steerRad + Math.sign(stDelta) * maxStep;
  }

  steerState.steerRad = targetSteer;
  const tanSteer = Math.abs(Math.tan(targetSteer));
  // Exact Ackermann formula from steer.cpp line 92:
  // steer2 = atan2(wheelbase * tanSteer, wheelbase - tanSteer * wheeltrack)
  const steer2 = Math.atan2(
    wheelbaseM * tanSteer,
    Math.max(0.2, wheelbaseM - tanSteer * wheeltrackM)
  );

  if (targetSteer > 0) {
    // Turning left: Front Left is inside wheel (sharper angle steer2), Front Right is outside
    steerState.wheelSteerFL = steer2;
    steerState.wheelSteerFR = targetSteer;
  } else if (targetSteer < 0) {
    // Turning right: Front Right is inside wheel (-steer2), Front Left is outside
    steerState.wheelSteerFR = -steer2;
    steerState.wheelSteerFL = targetSteer;
  } else {
    steerState.wheelSteerFR = 0;
    steerState.wheelSteerFL = 0;
  }
}

/**
 * Piecewise linear ICE torque curve interpolation (`SimEngineUpdateTq` in `simuv5/engine.cpp`)
 */
export function interpolateEngineTorque(
  curve: SimEngineConfig['torqueCurve'],
  rpm: number
): number {
  if (curve.length === 0) return 0;
  if (rpm <= curve[0].rpm) return curve[0].torqueNm;
  for (let i = 0; i < curve.length - 1; i++) {
    const p0 = curve[i];
    const p1 = curve[i + 1];
    if (rpm >= p0.rpm && rpm <= p1.rpm) {
      const t = (rpm - p0.rpm) / Math.max(1e-3, p1.rpm - p0.rpm);
      return p0.torqueNm + t * (p1.torqueNm - p0.torqueNm);
    }
  }
  return curve[curve.length - 1].torqueNm;
}

/**
 * Port of `SimEngineUpdateTq` from `simuv5/engine.cpp`
 * Includes 2026 FIA 350 kW MGU-K hybrid deployment, `/boost` manual override, and braking harvest.
 */
export function simEngineUpdateTq(
  engine: SimEngineState,
  cfg: SimEngineConfig,
  throttleCmd: number,
  brakeCmd: number,
  vxMs: number,
  dt: number
): void {
  const tickoverRads = cfg.tickoverRpm * RPM2RADS;
  const revsMaxRads = cfg.revsMaxRpm * RPM2RADS;
  const revsLimiterRads = cfg.revsLimiterRpm * RPM2RADS;

  if (engine.rads < tickoverRads) {
    engine.rads = tickoverRads;
  } else if (engine.rads > revsMaxRads) {
    engine.rads = revsMaxRads;
  }
  engine.rpm = engine.rads * RADS2RPM;

  // Update /boost timer & cooldown
  if (engine.boostCooldownS > 0) {
    engine.boostCooldownS = Math.max(0, engine.boostCooldownS - dt);
  }
  if (engine.boostRemainingS > 0) {
    engine.boostRemainingS = Math.max(0, engine.boostRemainingS - dt);
    if (engine.boostRemainingS === 0 && engine.ersMode === 'OVERRIDE') {
      engine.ersMode = 'BALANCED';
      engine.boostCooldownS = 4.0;
    }
  }

  // Soft rev limiter cut
  let effThrottle = Math.max(0, Math.min(1, throttleCmd));
  if (engine.rads > revsLimiterRads) {
    const overFraction = (engine.rads - revsLimiterRads) / Math.max(10, revsMaxRads - revsLimiterRads);
    effThrottle *= Math.max(0, 1.0 - overFraction * 3.5);
  }

  // Peak ICE torque at current RPM
  const tqMax = interpolateEngineTorque(cfg.torqueCurve, engine.rpm);

  // Parabolic + linear engine braking model from engine.cpp lines 199-213:
  const rpmRat = (engine.rads - tickoverRads) / Math.max(1, revsMaxRads - tickoverRads);
  let tqMin = 0;
  if (engine.rads > tickoverRads) {
    tqMin = -tqMax * (cfg.brakeLinCoeff * rpmRat + cfg.brakeCoeff * rpmRat * rpmRat);
  }

  const tqIce = (tqMax - tqMin) * effThrottle + tqMin;
  engine.tqIceNm = tqIce;

  // 2026 FIA MGU-K Hybrid Electrical Deployment & Regenerative Harvesting
  const speedKmh = Math.abs(vxMs) * 3.6;
  const socFraction = engine.ersEnergyJ / cfg.ersBatteryCapacityJ;
  let mgukPowerW = 0;

  if (effThrottle > 0.12 && socFraction > 0.01) {
    let taperFactor = 1.0;
    if (engine.ersMode === 'OVERRIDE' || engine.boostRemainingS > 0) {
      // 2026 FIA Manual Override (/Boost): Full 350 kW sustained up to 337 km/h, tapering to 0 at 355 km/h
      if (speedKmh > 337) {
        taperFactor = Math.max(0, 1.0 - (speedKmh - 337) / 18);
      }
      mgukPowerW = cfg.mgukMaxPowerW * taperFactor * effThrottle;
    } else if (engine.ersMode === 'HOTLAP') {
      if (speedKmh > 312) {
        taperFactor = Math.max(0, 1.0 - (speedKmh - 312) / 38);
      }
      mgukPowerW = cfg.mgukMaxPowerW * 0.94 * taperFactor * effThrottle;
    } else if (engine.ersMode === 'BALANCED') {
      // Standard 2026 regulatory taper above 290 km/h: P = 350 * (1 - (v - 290) / 55)
      if (speedKmh > 290) {
        taperFactor = Math.max(0, 1.0 - (speedKmh - 290) / 55);
      }
      mgukPowerW = cfg.mgukMaxPowerW * 0.78 * taperFactor * effThrottle;
    } else {
      // HARVEST mode: minimal deployment
      mgukPowerW = cfg.mgukMaxPowerW * 0.25 * Math.max(0, 1.0 - speedKmh / 290) * effThrottle;
    }

    const energyUsedJ = mgukPowerW * dt;
    if (energyUsedJ > engine.ersEnergyJ) {
      mgukPowerW = engine.ersEnergyJ / Math.max(1e-5, dt);
    }
    engine.ersEnergyJ = Math.max(0, engine.ersEnergyJ - mgukPowerW * dt);
  } else if ((brakeCmd > 0.05 || effThrottle < 0.05) && speedKmh > 35 && socFraction < 1.0) {
    // Regenerative harvesting under braking and overrun (up to 350 kW under heavy braking)
    const harvestFactor = Math.min(1.0, brakeCmd * 0.92 + (1.0 - effThrottle) * 0.24);
    const harvestPowerW = cfg.mgukMaxPowerW * harvestFactor * Math.min(1.0, speedKmh / 110);
    mgukPowerW = -harvestPowerW;
    engine.ersEnergyJ = Math.min(
      cfg.ersBatteryCapacityJ,
      engine.ersEnergyJ + harvestPowerW * dt * 0.88
    );
  }

  engine.mgukPowerKw = mgukPowerW / 1000.0;
  // Convert MGU-K power to crankshaft torque: T = P / omega
  const safeRads = Math.max(tickoverRads, engine.rads);
  engine.tqMgukNm = Math.max(
    -cfg.mgukMaxTorqueNm * 0.65,
    Math.min(cfg.mgukMaxTorqueNm, mgukPowerW / safeRads)
  );

  engine.tqCrankNm = engine.tqIceNm + engine.tqMgukNm;

  // Fuel consumption (~100 kg/hr at full load)
  if (effThrottle > 0.01 && engine.fuelKg > 0) {
    const fuelRateKgS = 0.024 * effThrottle * (engine.rpm / cfg.revsLimiterRpm);
    engine.fuelKg = Math.max(0, engine.fuelKg - fuelRateKgS * dt);
  }
}

/**
 * Port of `SimGearboxUpdate` from `simuv5/transmission.cpp`
 * Supports both manual paddle shifts (`shiftRequest`: -1 down, +1 up) and automatic F1 shift schedule.
 */
export function simGearboxUpdate(
  drivetrain: SimDrivetrainState,
  cfg: SimTransmissionConfig,
  engineCfg: SimEngineConfig,
  vxMs: number,
  throttleCmd: number,
  brakeCmd: number,
  shiftRequest: -1 | 0 | 1,
  autoGearbox: boolean,
  dt: number
): void {
  const { gearbox, clutch, engine } = drivetrain;

  if (gearbox.autoShiftCooldownS > 0) {
    gearbox.autoShiftCooldownS = Math.max(0, gearbox.autoShiftCooldownS - dt);
  }

  // Automatic F1 gear shift schedule if no manual shift requested
  let desiredGear = gearbox.gear;
  if (shiftRequest !== 0) {
    desiredGear = Math.max(1, Math.min(8, gearbox.gear + shiftRequest));
  } else if (autoGearbox && gearbox.autoShiftCooldownS <= 0 && gearbox.timeToEngageS <= 0) {
    const rearWheelRadius = 0.352;
    const roadReferredRpm =
      ((Math.max(0, vxMs) / rearWheelRadius) * Math.abs(gearbox.curOverallRatio)) * RADS2RPM;
    if (
      engine.rpm > 11900 &&
      roadReferredRpm > 11200 &&
      gearbox.gear < 8 &&
      throttleCmd > 0.25
    ) {
      desiredGear = gearbox.gear + 1;
      gearbox.autoShiftCooldownS = 0.14;
    } else if (
      gearbox.gear > 1 &&
      (engine.rpm < 9200 || (brakeCmd > 0.25 && engine.rpm < 10300))
    ) {
      // Check that downshifting won't over-rev past 12,800 RPM
      const lowerRatio = Math.abs(gearbox.overallRatios[gearbox.gear]); // gear-1 is index `gear`
      const projectedRpm = ((Math.max(0, vxMs) / rearWheelRadius) * lowerRatio) * RADS2RPM;
      if (projectedRpm < 12750) {
        desiredGear = gearbox.gear - 1;
        gearbox.autoShiftCooldownS = 0.14;
      }
    }
  }

  if (desiredGear !== gearbox.gear && gearbox.timeToEngageS <= 0) {
    gearbox.gearNext = desiredGear;
    gearbox.timeToEngageS = cfg.shiftTimeS;
  }

  if (gearbox.timeToEngageS > 0) {
    gearbox.timeToEngageS -= dt;
    // Brief torque cut during seamless shift engagement
    clutch.transferValue = 0.35;
    if (gearbox.timeToEngageS <= 0) {
      gearbox.gear = gearbox.gearNext;
      gearbox.timeToEngageS = 0;
      clutch.transferValue = 1.0;
    }
  } else {
    // Automatic anti-stall clutch at very low wheel speed
    const rearWheelRadius = 0.352;
    const roadReferredRpm =
      ((Math.max(0, vxMs) / rearWheelRadius) *
        Math.abs(gearbox.overallRatios[gearbox.gear + 1] || 10)) *
      RADS2RPM;
    if (roadReferredRpm < engineCfg.tickoverRpm * 1.15) {
      // Smooth launch slip clutch when starting from standstill
      const slipBlend = Math.max(
        0.18,
        Math.min(1.0, roadReferredRpm / (engineCfg.tickoverRpm * 1.15))
      );
      clutch.transferValue = Math.max(slipBlend, throttleCmd * 0.85);
    } else {
      clutch.transferValue = 1.0;
    }
  }

  const gearIdx = gearbox.gear + 1;
  gearbox.curOverallRatio = gearbox.overallRatios[gearIdx] ?? 0;
  const transfer = Math.min(1.0, Math.max(0.05, clutch.transferValue * 2.0));
  gearbox.curI =
    (gearbox.driveI[gearIdx] ?? 0) * transfer +
    (gearbox.freeI[gearIdx] ?? 0) * (1.0 - transfer);
}

/**
 * Port of `SimDifferentialUpdate` from `simuv5/differential.cpp`
 * Models a 1.5-way Salisbury Limited Slip Differential (LSD) between Rear Right (0) and Rear Left (1).
 */
export function simDifferentialUpdate(
  drivetrain: SimDrivetrainState,
  cfg: SimCarConfig,
  rearWheelSpinVel: [number, number], // [RR spinVel, RL spinVel] (rad/s)
  rearWheelBrkTq: [number, number],
  throttleCmd: number,
  dt: number
): void {
  const diffCfg = cfg.transmission.rearDifferential;
  const { gearbox, clutch, engine, rearDiff } = drivetrain;

  const gearIdx = gearbox.gear + 1;
  const gEff = cfg.transmission.gearEfficiencies[gearIdx] ?? 0.98;
  const transfer = clutch.transferValue;

  // Drive torque entering the rear differential ring gear
  const drTq = engine.tqCrankNm * gearbox.curOverallRatio * gEff * diffCfg.efficiency * transfer;

  const spinVel0 = rearWheelSpinVel[0]; // Rear Right
  const spinVel1 = rearWheelSpinVel[1]; // Rear Left

  const inI0 = cfg.wheels[2].inertia + cfg.wheels[2].brakeInertia;
  const inI1 = cfg.wheels[3].inertia + cfg.wheels[3].brakeInertia;

  // Total reflected rotational inertia at rear axle
  const halfDriveI = gearbox.curI * 0.5;
  rearDiff.outI[0] = halfDriveI + inI0;
  rearDiff.outI[1] = halfDriveI + inI1;

  // From SimDifferentialUpdate in differential.cpp (DIFF_LIMITED_SLIP):
  if (drTq > diffCfg.lockInputTq) {
    const spdRatioMax = diffCfg.dSlipMax - (1.0 - throttleCmd) * diffCfg.dCoastSlipMax;
    const meanv = (spinVel0 + spinVel1) * 0.5;
    const spdRatio = Math.abs(meanv) > 0.5 ? Math.abs(spinVel0 - spinVel1) / Math.abs(meanv) : 0;

    if (spdRatio > spdRatioMax) {
      const deltaSpd = (spdRatio - spdRatioMax) * Math.abs(meanv) * 0.5;
      if (spinVel0 > spinVel1) {
        rearWheelSpinVel[0] -= deltaSpd * Math.min(1.0, dt * 80);
        rearWheelSpinVel[1] += deltaSpd * Math.min(1.0, dt * 80);
      } else {
        rearWheelSpinVel[0] += deltaSpd * Math.min(1.0, dt * 80);
        rearWheelSpinVel[1] -= deltaSpd * Math.min(1.0, dt * 80);
      }
    }
  }

  // Spider gear locking & bias torque distribution
  const spiderTq = inI1 * spinVel1 - inI0 * spinVel0;
  const rate =
    Math.abs(drTq) > diffCfg.lockInputTq
      ? diffCfg.dSlipMax +
        (1.0 - diffCfg.dSlipMax) *
          (diffCfg.lockInputTq / Math.max(diffCfg.lockInputTq, Math.abs(drTq)))
      : 1.0;
  const tqLock = Math.abs(drTq) * rate;

  const deltaTq = spiderTq / Math.max(1e-4, dt);
  if (Math.abs(deltaTq) > tqLock && !rearDiff.locked) {
    // Differential slipping: bias torque by tqLock toward slower wheel
    const bias = spinVel0 > spinVel1 ? -tqLock * 0.35 : tqLock * 0.35;
    rearDiff.outTq[0] = drTq * 0.5 + bias;
    rearDiff.outTq[1] = drTq * 0.5 - bias;
  } else {
    // Differential locked or within preload
    const iTot = rearDiff.outI[0] + rearDiff.outI[1];
    const r0 = rearDiff.outI[0] / iTot;
    const r1 = rearDiff.outI[1] / iTot;
    rearDiff.outTq[0] = drTq * r0;
    rearDiff.outTq[1] = drTq * r1;
  }

  // Update engine RPM from rear axle feedback (`SimEngineUpdateRpm` in `engine.cpp`)
  const axleSpinVel = (rearWheelSpinVel[0] + rearWheelSpinVel[1]) * 0.5;
  const wheelRefRads = Math.abs(axleSpinVel * gearbox.curOverallRatio);
  const freeEngineRads =
    engine.rads + (engine.tqCrankNm / Math.max(0.02, cfg.engine.inertia)) * dt;

  // Blend engine speed between road-coupled speed and free-revving speed via clutch transfer
  const coupledBlend = Math.min(1.0, Math.max(0.0, clutch.transferValue));
  engine.rads = Math.max(
    cfg.engine.tickoverRpm * RPM2RADS,
    Math.min(
      cfg.engine.revsMaxRpm * RPM2RADS,
      wheelRefRads * coupledBlend + freeEngineRads * (1.0 - coupledBlend)
    )
  );
  engine.rpm = engine.rads * RADS2RPM;
}

/**
 * Port of `SimBrakeSystemUpdate` and `SimBrakeUpdate` from `simuv5/brake.cpp`
 */
export function simBrakeSystemUpdate(
  drivetrain: SimDrivetrainState,
  cfg: SimBrakeSystemConfig,
  brakeCmd: number,
  vxMs: number,
  wheelSpinVels: [number, number, number, number],
  wheelSlipRatios: [number, number, number, number],
  dt: number
): void {
  const clampedBrake = Math.max(0, Math.min(1, brakeCmd));
  const masterPressure = clampedBrake * cfg.maxPressurePa;

  // Front (0: FR, 1: FL) and Rear (2: RR, 3: RL) hydraulic bias repartition
  drivetrain.brakes[0].pressurePa = masterPressure * cfg.frontBias;
  drivetrain.brakes[1].pressurePa = masterPressure * cfg.frontBias;
  drivetrain.brakes[2].pressurePa = masterPressure * (1.0 - cfg.frontBias);
  drivetrain.brakes[3].pressurePa = masterPressure * (1.0 - cfg.frontBias);

  const absVx = Math.abs(vxMs);

  for (let i = 0; i < 4; i++) {
    const brk = drivetrain.brakes[i];

    // 2026 FIA F1 Brake-By-Wire (BBW) & threshold slip modulation:
    // Regulate caliper pressure as longitudinal slip reaches the Pacejka peak window (-0.085)
    // so full threshold braking tracks peak tire deceleration without locking spinVel to 0
    const slipTarget = cfg.enableAbs ? -0.080 : -0.085;
    const slipGain = cfg.enableAbs ? 18.0 : 15.0;
    if (absVx > 1.5 && wheelSlipRatios[i] < slipTarget) {
      brk.absFactor = Math.max(
        0.0,
        1.0 - (Math.abs(wheelSlipRatios[i]) - Math.abs(slipTarget)) * slipGain
      );
    } else {
      brk.absFactor = 1.0;
    }

    brk.tqNm = brk.coeff * brk.pressurePa * brk.absFactor;

    // Thermal model from brake.cpp lines 88-91:
    // Cooling proportional to airflow speed + ambient radiation
    brk.tempNorm -= (absVx * 0.0018 + 0.015) * dt;
    if (brk.tempNorm < 0) brk.tempNorm = 0;
    // Frictional heating proportional to caliper pressure * disc radius * wheel angular speed
    const heatPower =
      brk.pressurePa *
      Math.max(0.35, brk.absFactor) *
      brk.radius *
      Math.abs(wheelSpinVels[i]) *
      3.2e-9;
    brk.tempNorm += heatPower * dt;
    if (brk.tempNorm > 1.0) brk.tempNorm = 1.0;

    // Map normalized brake temperature to °C (260°C ambient cruise up to 1,020°C carbon-carbon glow)
    brk.tempC = Math.round(240 + brk.tempNorm * 780);
  }
}

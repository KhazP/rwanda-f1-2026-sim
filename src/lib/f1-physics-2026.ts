/**
 * 2026 FIA Formula 1 Physics Solver (`f1-physics-2026.ts`)
 *
 * Implements a fixed-timestep sub-stepped (`dt = 0.002s` / 500 Hz) 4-wheel rigid-body
 * vehicle dynamics engine ported from:
 * - TORCS / Speed Dreams `simuv4` & `simuv5` (`simu.cpp`, `car.cpp`, `wheel.cpp`, `susp.cpp`,
 *   `axle.cpp`, `aero.cpp`, `engine.cpp`, `transmission.cpp`, `differential.cpp`, `brake.cpp`, `steer.cpp`)
 * - `assetto_corsa_gym` (`AssettoCorsaEnv/ac_env.py`, `track_occupancy_grid.py`, `reference_lap.py`)
 *
 * Sub-step Integration Order (matching `SimUpdateSingleCar` in `simu.cpp`):
 * `ctrlCheck -> SimSteerUpdate -> SimGearboxUpdate -> SimEngineUpdateTq -> SimCarUpdateWheelPos
 *  -> SimBrakeSystemUpdate -> SimAeroUpdate -> SimWingUpdate -> SimWheelUpdateRide
 *  -> SimAxleUpdate -> SimWheelUpdateForce -> SimDifferentialUpdate -> SimWheelUpdateRotation
 *  -> SimCarUpdate (Forces, Speed, Pos)`
 */

import * as THREE from 'three';
import type {
  ActiveAeroMode,
  AeroSetupPreset,
  CarTelemetry,
  ControlInputs,
  DriverAssistPreset,
  SurfaceType,
  TireCompound,
} from '@/types/f1';
export type { ControlInputs };
import {
  BASE_ALTITUDE_M,
  type BuiltTrackData,
  evaluateSampleLateralHeightM,
  getRwandaTrackData,
  TRACK_TOTAL_LENGTH_M,
} from './track-data';
import {
  FIA_2026_F1_CAR_CONFIG,
  SimCarConfig,
  WheelCornerIndex,
} from './sim/car-configs';
import { initSimAeroState, SimAeroState, updateSimAero } from './sim/aero';
import {
  initAxleState,
  initSuspensionState,
  SimAxleState,
  simAxleUpdate,
  SimSuspensionState,
} from './sim/susp';
import {
  initDrivetrainState,
   simBrakeSystemUpdate,
  simDifferentialUpdate,
  SimDrivetrainState,
  simEngineUpdateTq,
  simGearboxUpdate,
  simSteerUpdate,
} from './sim/drivetrain';
import {
  initWheelState,
  SimWheelState,
  simWheelUpdateForce,
  simWheelUpdateRide,
  simWheelUpdateRotation,
  updateWheelCompoundParams,
} from './sim/wheel';
import {
  AssettoCorsaGymObservation,
  computeLookaheadVectors,
  evaluateDynamicBrakingUrgency,
  queryWheelGroundContact,
} from './sim/track-occupancy';
import { evaluateSingleTrackMpcAi } from './sim/ai-mpc';

const GRAVITY = 9.81;

const AERO_SETUP_MULT: Record<AeroSetupPreset, { downforce: number; drag: number }> = {
  low_downforce: { downforce: 0.94, drag: 0.92 },
  balanced: { downforce: 1.0, drag: 1.0 },
  high_downforce: { downforce: 1.07, drag: 1.08 },
};

export class F1Physics2026 {
  /** Fixed 500 Hz simulation sub-step (`dt = 0.002s`) decoupled from render FPS */
  public static readonly FIXED_DT = 0.002;

  private track: BuiltTrackData;
  public readonly config: SimCarConfig;
  private timeAccumulator = 0;

  // Chassis constants exposed for camera/HUD compatibility
  public readonly massKg: number;
  public readonly wheelbaseM: number = 3.4;
  public readonly wheeltrackM: number = 1.57;
  public readonly cgToFrontAxleM: number = 1.853;
  public readonly cgToRearAxleM: number = 1.547;
  public readonly cgHeightM: number = 0.275;
  public readonly yawInertiaKgM2: number = 1060;

  public aeroPreset: AeroSetupPreset = 'low_downforce';
  public assistPreset: DriverAssistPreset = 'pro';
  public tireCompound: TireCompound = 'soft';
  public autoGearbox = true;

  // Vehicle State (3D Cartesian World + Projected Curvilinear Track State)
  public worldX = 0;
  public worldZ = 0;
  public worldYawRad = 0; // Horizontal world heading angle atan2(forward.x, forward.z) (rad)
  public sMeters = 45;
  public lateralOffsetM = 0;
  public headingErrorRad = 0; // Positive = nose pointed right of track tangent
  private lastSyncedSMeters = 45;
  private lastSyncedLateralOffsetM = 0;
  private lastSyncedHeadingErrorRad = 0;
  public vxMs = 0; // Longitudinal velocity in car body frame (m/s)
  public vyMs = 0; // Lateral velocity in car body frame (m/s, +left in TORCS, we also expose lateralG)
  public vzMs = 0; // Vertical velocity (m/s)
  public yawRateRadS = 0; // World yaw angular velocity (rad/s, +turning right for UI compatibility)
  public steerAngleNorm = 0; // [-1..1], +1 = Right, -1 = Left
  public frontWheelAngleRad = 0; // Actual front wheel steer angle (+ = right)
  public ffbTorqueNorm = 0; // [-1..1] normalized steering rack Force Feedback torque
  public frontSlipRatioNorm = 0;
  public rearSlipRatioNorm = 0;

  private rawSteerFiltered = 0;
  private lastAxMs2 = 0;
  private lastAyMs2 = 0;
  private prevShiftUp = false;
  private prevShiftDown = false;
  private prevToggleXMode = false;

  // 3D Chassis Attitude (Pitch, Roll, Vertical Heave from 4-corner suspension)
  public pitchRad = 0;
  public rollRad = 0;
  public pitchVelRadS = 0;
  public rollVelRadS = 0;
  public rideHeightOffsetM = 0;

  // Subsystems ported from Speed Dreams simuv5
  public aeroState: SimAeroState;
  public drivetrain: SimDrivetrainState;
  public suspensions: [
    SimSuspensionState,
    SimSuspensionState,
    SimSuspensionState,
    SimSuspensionState,
  ];
  public axles: [SimAxleState, SimAxleState];
  public wheels: [SimWheelState, SimWheelState, SimWheelState, SimWheelState];
  public lastObservation: AssettoCorsaGymObservation;

  // Legacy property mirrors for external readers
  public rpm = 4200;
  public gear = 1;
  public shiftCooldownS = 0;
  public ersEnergyJ = 4_000_000;
  public readonly maxErsEnergyJ = 4_000_000;
  public activeAeroMode: ActiveAeroMode = 'Z_MODE';
  public autoXMode = true;
  public aiAutopilot = false;

  // Three.js World Transform outputs
  public worldPosition = new THREE.Vector3();
  public worldQuaternion = new THREE.Quaternion();
  public wheelRotationRad = 0;

  // Lap & Sector Timing
  private currentLapStartMs = 0;
  private currentSectorStartMs = 0;
  private lastSector: 1 | 2 | 3 = 1;
  private lapValid = true;
  private simTimeMs = 0;

  public telemetry: CarTelemetry;

  constructor(
    track: BuiltTrackData = getRwandaTrackData(),
    config: SimCarConfig = FIA_2026_F1_CAR_CONFIG
  ) {
    this.track = track;
    this.config = config;
    this.massKg = config.dryMassKg;

    // Initialize TORCS/Speed Dreams subsystems
    const totalWeightN = (config.dryMassKg + config.initialFuelKg) * GRAVITY;
    const wf0 = totalWeightN * config.frontWeightRep;
    const wr0 = totalWeightN * (1.0 - config.frontWeightRep);

    this.aeroState = initSimAeroState(config.aero);
    this.drivetrain = initDrivetrainState(config);
    this.suspensions = [
      initSuspensionState(config.suspensions[0], wf0 * 0.5),
      initSuspensionState(config.suspensions[1], wf0 * 0.5),
      initSuspensionState(config.suspensions[2], wr0 * 0.5),
      initSuspensionState(config.suspensions[3], wr0 * 0.5),
    ];
    this.axles = [
      initAxleState(config.axles[0], this.suspensions[0].spring.x0),
      initAxleState(config.axles[1], this.suspensions[2].spring.x0),
    ];

    // Symmetric static GC offset (x = 0 at CG, y = 0 on centerline)
    this.wheels = [
      initWheelState(0, config.wheels[0], 0, 0, this.tireCompound),
      initWheelState(1, config.wheels[1], 0, 0, this.tireCompound),
      initWheelState(2, config.wheels[2], 0, 0, this.tireCompound),
      initWheelState(3, config.wheels[3], 0, 0, this.tireCompound),
    ];

    // Eliminate static toe on straights so left/right lateral forces are 100% zero when steer = 0
    for (let i = 0; i < 4; i++) {
      this.config.wheels[i].toeRad = 0;
    }

    this.telemetry = this.createInitialTelemetry();
    this.lastObservation = this.buildObservation(this.track.getSampleAtDistance(35));
    this.resetToStartGrid(false);
  }

  public getTelemetry(): CarTelemetry {
    return this.telemetry;
  }

  public setAssistPreset(preset: DriverAssistPreset): void {
    this.assistPreset = preset;
    this.config.brakeSystem.enableAbs = preset !== 'pro';
  }

  /**
   * Triggers the 2026 FIA Manual Override Mode (`/boost` — 350 kW MGU-K sustained to 337 km/h)
   */
  public activateBoostOverride(): boolean {
    const eng = this.drivetrain.engine;
    if (eng.ersEnergyJ > 200_000 && eng.boostCooldownS <= 0) {
      eng.ersMode = 'OVERRIDE';
      eng.boostRemainingS = 8.0;
      return true;
    }
    return false;
  }

  private createInitialTelemetry(): CarTelemetry {
    return {
      speedKmh: 0,
      speedMs: 0,
      rpm: 4200,
      gear: 1,
      throttle: 0,
      brake: 0,
      clutch: 1,
      steering: 0,
      longitudinalG: 0,
      lateralG: 0,
      verticalG: 1,
      altitudeM: BASE_ALTITUDE_M + 35,
      trackElevationM: 35,
      airDensityKgM3: 1.041,
      activeAeroMode: 'Z_MODE',
      autoXMode: true,
      downforceN: 0,
      downforceKgf: 0,
      frontDownforceN: 0,
      rearDownforceN: 0,
      groundEffectFactor: 1.0,
      dragN: 0,
      icePowerKw: 0,
      mgukPowerKw: 0,
      totalPowerKw: 0,
      ersBatteryPercent: 100,
      manualOverrideActive: false,
      boostRemainingS: 0,
      turboBoostBar: 1.0,
      fuelKg: this.config.initialFuelKg,
      tireSlipRatio: [0, 0, 0, 0],
      wheelSlipRatios: [0, 0, 0, 0],
      wheelSlipAnglesDeg: [0, 0, 0, 0],
      wheelLoadsN: [1800, 1800, 2150, 2150],
      wheelRideHeightsMm: [32, 32, 46, 46],
      suspensionTravelMm: [18, 18, 24, 24],
      tireTempsC: [92, 92, 94, 94],
      tireWearPct: [0, 0, 0, 0],
      tireGripFactor: [1, 1, 1, 1],
      brakeTempsC: [320, 320, 300, 300],
      wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
      frontSlipAngleDeg: 0,
      rearSlipAngleDeg: 0,
      ffbTorqueNorm: 0,
      ffbClipping: false,
      onKerbLeft: false,
      onKerbRight: false,
      offTrack: false,
      surface: 'asphalt',
      trackDistanceM: 35,
      trackProgress: 35 / TRACK_TOTAL_LENGTH_M,
      lateralOffsetM: 0,
      gapToRacingLineM: 0,
      headingErrorRad: 0,
      targetCornerSpeedKmh: 295,
      brakingUrgency: 0,
      currentSector: 1,
      currentTurnNumber: 0,
      currentTurnName: 'Main Straight — Starting Grid',
      bankingDeg: 0,
      slopePercent: 0,
      lapCount: 1,
      currentLapTimeMs: 0,
      lastLapTimeMs: null,
      bestLapTimeMs: null,
      sectorTimesMs: [0, 0, 0],
      bestSectorTimesMs: [null, null, null],
      topSpeedThisLapKmh: 0,
      allTimeTopSpeedKmh: 0,
      aiAutopilot: false,
      peers: [],
    };
  }

  public resetToStartGrid(flyingStart = false): void {
    this.timeAccumulator = 0;
    this.sMeters = flyingStart ? 50 : 35;
    const sample = this.track.getSampleAtDistance(this.sMeters);
    this.lateralOffsetM = 0;
    this.headingErrorRad = 0;
    this.yawRateRadS = 0;
    this.vxMs = flyingStart ? 75.0 : 0;
    this.vyMs = 0;
    this.vzMs = 0;
    this.lastAxMs2 = 0;
    this.lastAyMs2 = 0;
    this.steerAngleNorm = 0;
    this.frontWheelAngleRad = 0;
    this.ffbTorqueNorm = 0;
    this.rawSteerFiltered = 0;
    this.pitchRad = 0;
    this.rollRad = 0;
    this.pitchVelRadS = 0;
    this.rollVelRadS = 0;
    this.rideHeightOffsetM = 0;

    this.gear = flyingStart ? 7 : 1;
    this.rpm = flyingStart ? 11200 : 4200;
    this.ersEnergyJ = this.maxErsEnergyJ;
    this.activeAeroMode = flyingStart ? 'X_MODE' : 'Z_MODE';

    // Reset drivetrain & wheel spin velocities to match initial road speed
    this.drivetrain = initDrivetrainState(this.config);
    this.drivetrain.gearbox.gear = this.gear;
    this.drivetrain.gearbox.gearNext = this.gear;
    this.drivetrain.engine.rpm = this.rpm;
    this.drivetrain.engine.rads = (this.rpm * 2 * Math.PI) / 60;
    this.drivetrain.engine.ersEnergyJ = this.ersEnergyJ;

    for (let i = 0; i < 4; i++) {
      const wCfg = this.config.wheels[i];
      this.wheels[i] = initWheelState(
        i as WheelCornerIndex,
        wCfg,
        0,
        0,
        this.tireCompound
      );
      this.wheels[i].spinVel = this.vxMs / wCfg.radius;
      this.wheels[i].preSpinVel = this.wheels[i].spinVel;
    }

    this.simTimeMs = 0;
    this.currentLapStartMs = 0;
    this.currentSectorStartMs = 0;
    this.lastSector = sample.sector;

    this.syncCartesianFromCurvilinear();
    this.syncWorldTransform();
    this.updateWheelWorldPositions(sample);
    this.lastObservation = this.buildObservation(sample);
    this.updateTelemetrySnapshot(sample, {
      throttle: 0,
      brake: 0,
      steerLeft: 0,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }

  public teleportToDistance(sMeters: number, speedMs = 0): void {
    const wrapped =
      ((sMeters % TRACK_TOTAL_LENGTH_M) + TRACK_TOTAL_LENGTH_M) %
      TRACK_TOTAL_LENGTH_M;
    const sample = this.track.getSampleAtDistance(wrapped);
    this.timeAccumulator = 0;
    this.sMeters = wrapped;
    this.lateralOffsetM = 0;
    this.headingErrorRad = 0;
    this.yawRateRadS = 0;
    this.vxMs = Math.max(0, speedMs);
    this.vyMs = 0;
    this.vzMs = 0;
    this.lastAxMs2 = 0;
    this.lastAyMs2 = 0;
    this.steerAngleNorm = 0;
    this.frontWheelAngleRad = 0;
    this.rawSteerFiltered = 0;
    this.pitchRad = 0;
    this.rollRad = 0;
    this.gear =
      speedMs > 1
        ? Math.max(1, Math.min(8, Math.ceil((speedMs * 3.6) / 42)))
        : 1;
    this.rpm = speedMs > 1 ? 10500 : 4200;
    this.drivetrain.gearbox.gear = this.gear;
    this.drivetrain.gearbox.gearNext = this.gear;
    this.drivetrain.engine.rpm = this.rpm;
    this.drivetrain.engine.rads = (this.rpm * 2 * Math.PI) / 60;

    for (let i = 0; i < 4; i++) {
      this.wheels[i].spinVel = this.vxMs / this.config.wheels[i].radius;
      this.wheels[i].preSpinVel = this.wheels[i].spinVel;
      this.wheels[i].slipRatio = 0;
      this.wheels[i].slipAngleRad = 0;
    }

    this.lastSector = sample.sector;
    this.syncCartesianFromCurvilinear();
    this.syncWorldTransform();
    this.updateWheelWorldPositions(sample);
    this.lastObservation = this.buildObservation(sample);
    this.updateTelemetrySnapshot(sample, {
      throttle: 0,
      brake: 0,
      steerLeft: 0,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }

  public teleportToTurn(turnNumber: number): void {
    const idx = this.track.samples.findIndex((s) => s.turnNumber === turnNumber);
    const targetSample =
      idx >= 0
        ? this.track.samples[(idx + 2) % this.track.samples.length]
        : this.track.samples[0];

    const speedMs = Math.min(62, targetSample.optimalSpeedKmh / 3.6);
    this.teleportToDistance(targetSample.s, speedMs);
    this.lateralOffsetM =
      targetSample.racingLineOffset * (targetSample.width * 0.28);
    this.syncCartesianFromCurvilinear();
    this.syncWorldTransform();
  }

  private syncCartesianFromCurvilinear(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    this.worldX = sample.position.x + sample.binormal.x * this.lateralOffsetM;
    this.worldZ = sample.position.z + sample.binormal.z * this.lateralOffsetM;
    const trackHeadingRad = Math.atan2(sample.tangent.x, sample.tangent.z);
    this.worldYawRad = Math.atan2(
      Math.sin(trackHeadingRad - this.headingErrorRad),
      Math.cos(trackHeadingRad - this.headingErrorRad)
    );
    this.lastSyncedSMeters = this.sMeters;
    this.lastSyncedLateralOffsetM = this.lateralOffsetM;
    this.lastSyncedHeadingErrorRad = this.headingErrorRad;
  }

  private computeAirDensity(altitudeM: number): number {
    return 1.225 * Math.pow(1 - 2.25577e-5 * altitudeM, 4.25588);
  }

  /**
   * Main frame entry point. Accumulates frame delta time and steps the physics solver
   * at a strict fixed timestep of `dt = 0.002s` (500 Hz), completely decoupled from render FPS.
   */
  public step(dtSeconds: number, rawInputs: Partial<ControlInputs>): CarTelemetry {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      return this.telemetry;
    }

    // If caller mutated sMeters, lateralOffsetM, or headingErrorRad directly, re-sync Cartesian state
    if (
      this.sMeters !== this.lastSyncedSMeters ||
      this.lateralOffsetM !== this.lastSyncedLateralOffsetM ||
      this.headingErrorRad !== this.lastSyncedHeadingErrorRad
    ) {
      this.syncCartesianFromCurvilinear();
    }

    // Update tire compound parameters if user changed compound in UI
    for (let i = 0; i < 4; i++) {
      updateWheelCompoundParams(this.wheels[i], this.tireCompound);
    }

    const clampedDt = Math.min(dtSeconds, 0.05);
    this.timeAccumulator += clampedDt;

    const normalizedInputs: ControlInputs = {
      throttle: THREE.MathUtils.clamp(rawInputs.throttle ?? 0, 0, 1),
      brake: THREE.MathUtils.clamp(rawInputs.brake ?? 0, 0, 1),
      steerLeft: THREE.MathUtils.clamp(rawInputs.steerLeft ?? 0, 0, 1),
      steerRight: THREE.MathUtils.clamp(rawInputs.steerRight ?? 0, 0, 1),
      analogSteer:
        rawInputs.analogSteer !== undefined
          ? THREE.MathUtils.clamp(rawInputs.analogSteer, -1, 1)
          : undefined,
      clutch: rawInputs.clutch,
      manualOverride: Boolean(rawInputs.manualOverride),
      toggleXMode: Boolean(rawInputs.toggleXMode),
      shiftUp: Boolean(rawInputs.shiftUp),
      shiftDown: Boolean(rawInputs.shiftDown),
    };

    // Edge-triggered X-Mode toggle
    if (normalizedInputs.toggleXMode && !this.prevToggleXMode) {
      this.autoXMode = false;
      this.activeAeroMode =
        this.activeAeroMode === 'Z_MODE' ? 'X_MODE' : 'Z_MODE';
    }
    this.prevToggleXMode = normalizedInputs.toggleXMode;

    // Edge-triggered manual gear shifts
    let shiftReq: -1 | 0 | 1 = 0;
    if (normalizedInputs.shiftUp && !this.prevShiftUp) {
      shiftReq = 1;
    } else if (normalizedInputs.shiftDown && !this.prevShiftDown) {
      shiftReq = -1;
    }
    this.prevShiftUp = normalizedInputs.shiftUp;
    this.prevShiftDown = normalizedInputs.shiftDown;

    // Fixed-timestep 500 Hz sub-stepping loop (`dt = 0.002s`)
    let stepsRun = 0;
    while (this.timeAccumulator >= F1Physics2026.FIXED_DT && stepsRun < 30) {
      this.integrateSubStep(
        F1Physics2026.FIXED_DT,
        normalizedInputs,
        stepsRun === 0 ? shiftReq : 0
      );
      this.timeAccumulator -= F1Physics2026.FIXED_DT;
      this.simTimeMs += F1Physics2026.FIXED_DT * 1000;
      stepsRun++;
    }

    // If frame dt was smaller than 0.002s (e.g. >500 Hz monitor or micro-step test),
    // still ensure telemetry and world transform are up to date
    if (stepsRun === 0 && dtSeconds > 0 && dtSeconds < F1Physics2026.FIXED_DT) {
      this.integrateSubStep(dtSeconds, normalizedInputs, shiftReq);
      this.timeAccumulator = 0;
      this.simTimeMs += dtSeconds * 1000;
    }

    this.syncWorldTransform();
    const currentSample = this.track.getSampleAtDistance(this.sMeters);
    this.lastObservation = this.buildObservation(currentSample);
    this.updateTelemetrySnapshot(currentSample, normalizedInputs);

    return this.telemetry;
  }

  /**
   * Executes one 500 Hz (`dt = 0.002s`) physics step following the exact TORCS/Speed Dreams
   * `SimUpdateSingleCar` execution order (`simu.cpp` lines 255-345).
   */
  private integrateSubStep(
    dt: number,
    inputs: ControlInputs,
    shiftRequest: -1 | 0 | 1
  ): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);

    // =========================================================================
    // 1. ctrlCheck: Driver / Single-Track MPC AI Input Conditioning
    // =========================================================================
    let throttleCmd = inputs.throttle;
    let brakeCmd = inputs.brake;
    let torcsSteerCmd = 0; // +1 = Left, -1 = Right in TORCS convention

    if (this.aiAutopilot) {
      this.lastObservation = this.buildObservation(sample);
      const aiOut = evaluateSingleTrackMpcAi(
        this.lastObservation,
        this.track,
        this.sMeters,
        this.wheelbaseM,
        this.config.steer.steerLockRad
      );
      torcsSteerCmd = aiOut.steerCmd;
      throttleCmd = aiOut.throttleCmd;
      brakeCmd = aiOut.brakeCmd;
      this.activeAeroMode = aiOut.aeroMode;
      this.drivetrain.engine.ersMode = aiOut.ersMode;
      this.rawSteerFiltered = -torcsSteerCmd;
    } else {
      // Player manual steering input (+1 = Right, -1 = Left in UI convention)
      const rawUiSteer =
        inputs.analogSteer !== undefined
          ? THREE.MathUtils.clamp(inputs.analogSteer, -1, 1)
          : inputs.steerRight - inputs.steerLeft;

      // Progressive speed-sensitive steering filtering so keyboard taps feel crisp yet smooth
      const hasInput = Math.abs(rawUiSteer) > 0.005;
      const filterRate = hasInput ? 11.5 : 16.0;
      this.rawSteerFiltered +=
        (rawUiSteer - this.rawSteerFiltered) * Math.min(1.0, filterRate * dt);
      if (!hasInput && Math.abs(this.rawSteerFiltered) < 1e-4) {
        this.rawSteerFiltered = 0;
      }

      // Speed-sensitive steering ratio (full authority in slow/medium corners, progressive high-speed authority at 300+ km/h)
      const excessSpeed = Math.max(0, Math.abs(this.vxMs) - 34.0);
      const speedSensitivity =
        1.0 / (1.0 + Math.pow(excessSpeed / 58.0, 1.45));
      const minHighSpeedAuthority = 0.34;
      const effectiveUiSteer =
        this.rawSteerFiltered * Math.max(minHighSpeedAuthority, speedSensitivity);

      torcsSteerCmd = -effectiveUiSteer; // Convert UI (+right) to TORCS (+left)

      // Manual Override (/Boost)
      if (inputs.manualOverride) {
        this.drivetrain.engine.ersMode = 'OVERRIDE';
      } else if (this.drivetrain.engine.boostRemainingS <= 0) {
        this.drivetrain.engine.ersMode = 'BALANCED';
      }

      // Auto X-Mode active aero on designated DRS/straight zones when not braking
      if (this.autoXMode) {
        const canXMode =
          sample.drsZone &&
          brakeCmd < 0.05 &&
          Math.abs(this.rawSteerFiltered) < 0.18 &&
          this.vxMs > 38;
        this.activeAeroMode = canXMode ? 'X_MODE' : 'Z_MODE';
      }
    }

    // Closed-loop Pacejka peak-slip traction control modulation (in semi_pro / assisted)
    if (this.assistPreset !== 'pro' && throttleCmd > 0.2) {
      const maxRearSlip = Math.max(
        this.wheels[2].combinedSlipNorm,
        this.wheels[3].combinedSlipNorm
      );
      const slipThreshold = this.assistPreset === 'assisted' ? 0.94 : 1.04;
      if (maxRearSlip > slipThreshold) {
        throttleCmd *= Math.max(0.48, 1.0 - (maxRearSlip - slipThreshold) * 0.85);
      }
    }

    // =========================================================================
    // 2. SimSteerUpdate (Ackermann Front Wheel Geometry)
    // =========================================================================
    simSteerUpdate(
      this.drivetrain.steer,
      this.config.steer,
      torcsSteerCmd,
      this.wheelbaseM,
      this.wheeltrackM,
      dt
    );
    this.wheels[0].steerRad = this.drivetrain.steer.wheelSteerFR;
    this.wheels[1].steerRad = this.drivetrain.steer.wheelSteerFL;
    this.wheels[2].steerRad = 0;
    this.wheels[3].steerRad = 0;

    // UI steering properties (+ = right)
    this.frontWheelAngleRad = -this.drivetrain.steer.steerRad;
    this.steerAngleNorm = THREE.MathUtils.clamp(
      this.frontWheelAngleRad / this.config.steer.steerLockRad,
      -1,
      1
    );

    // =========================================================================
    // 3. SimGearboxUpdate (8-Speed Seamless Gearbox & Clutch)
    // =========================================================================
    simGearboxUpdate(
      this.drivetrain,
      this.config.transmission,
      this.config.engine,
      this.vxMs,
      throttleCmd,
      brakeCmd,
      shiftRequest,
      this.autoGearbox,
      dt
    );
    this.gear = this.drivetrain.gearbox.gear;

    // =========================================================================
    // 4. SimEngineUpdateTq (ICE Torque Curve + Engine Braking + 350kW MGU-K)
    // =========================================================================
    simEngineUpdateTq(
      this.drivetrain.engine,
      this.config.engine,
      throttleCmd,
      brakeCmd,
      this.vxMs,
      dt
    );
    this.rpm = this.drivetrain.engine.rpm;
    this.ersEnergyJ = this.drivetrain.engine.ersEnergyJ;

    // =========================================================================
    // 5. SimCarUpdateWheelPos (4-Wheel World Coordinates & Hub Body Velocities)
    // =========================================================================
    this.updateWheelWorldPositions(sample);

    // In TORCS convention, yawRateAz is positive counter-clockwise (turning left),
    // which is `-this.yawRateRadS`
    const yawRateTorcs = -this.yawRateRadS;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // From SimCarUpdateWheelPos in car.cpp lines 851-852:
      // bodyVel.x = vx - yawRate * y; bodyVel.y = vy + yawRate * x
      w.bodyVel.x = this.vxMs - yawRateTorcs * w.staticPos.y;
      w.bodyVel.y = this.vyMs + yawRateTorcs * w.staticPos.x;
    }

    // =========================================================================
    // 6. SimBrakeSystemUpdate (Hydraulic Bias, ABS & Carbon Disc Thermal Glow)
    // =========================================================================
    simBrakeSystemUpdate(
      this.drivetrain,
      this.config.brakeSystem,
      brakeCmd,
      this.vxMs,
      [
        this.wheels[0].spinVel,
        this.wheels[1].spinVel,
        this.wheels[2].spinVel,
        this.wheels[3].spinVel,
      ],
      [
        this.wheels[0].slipRatio,
        this.wheels[1].slipRatio,
        this.wheels[2].slipRatio,
        this.wheels[3].slipRatio,
      ],
      dt
    );

    // =========================================================================
    // 7. SimAeroUpdate & SimWingUpdate (Ground Effect + Active Z/X-Mode Wings)
    // =========================================================================
    const altitudeM = BASE_ALTITUDE_M + sample.position.y;
    this.config.aero.airDensity = this.computeAirDensity(altitudeM);
    const aeroSetup = AERO_SETUP_MULT[this.aeroPreset];

    updateSimAero(
      this.aeroState,
      this.config.aero,
      this.vxMs,
      this.vyMs,
      [
        this.wheels[0].rideHeight,
        this.wheels[1].rideHeight,
        this.wheels[2].rideHeight,
        this.wheels[3].rideHeight,
      ],
      this.activeAeroMode === 'X_MODE' ? 'X-MODE' : 'Z-MODE',
      dt
    );
    this.aeroState.frontDownforceN *= aeroSetup.downforce;
    this.aeroState.rearDownforceN *= aeroSetup.downforce;
    this.aeroState.totalDownforceN =
      this.aeroState.frontDownforceN + this.aeroState.rearDownforceN;
    this.aeroState.totalDragN *= aeroSetup.drag;
    this.aeroState.drag *= aeroSetup.drag;

    // =========================================================================
    // 8. SimWheelUpdateRide (Per-Wheel Surface Query & 4-Corner Suspension)
    // =========================================================================
    const totalMass = this.config.dryMassKg + this.drivetrain.engine.fuelKg;
    // Dynamic load transfer from chassis pitch/roll accelerations
    const longLoadTransferN =
      (totalMass * this.lastAxMs2 * this.cgHeightM) / this.wheelbaseM;
    const latLoadTransferN =
      (totalMass * this.lastAyMs2 * this.cgHeightM) / this.wheeltrackM;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const contact = queryWheelGroundContact(
        this.track,
        w.worldPos.x,
        w.worldPos.z,
        this.sMeters + w.staticPos.x,
        Math.abs(this.vxMs)
      );
      w.zRoad = contact.zRoad;
      w.surfaceType = contact.surfaceType;
      w.surfaceFrictionMult = contact.frictionMult;
      w.surfaceBumpM = contact.bumpM;

      // Compute dynamic suspension deflection from static equilibrium + aero + pitch/roll + surface bump
      const isFront = i < 2;
      const isRight = i % 2 === 0;
      const axle = isFront ? this.axles[0] : this.axles[1];

      const susp = this.suspensions[i];
      const aeroCorner = isFront
        ? this.aeroState.frontDownforceN * 0.5
        : this.aeroState.rearDownforceN * 0.5;
      // Under braking (lastAxMs2 < 0), longLoadTransferN < 0 -> front compresses (+), rear extends (-)
      const pitchShift = isFront ? -longLoadTransferN * 0.5 : longLoadTransferN * 0.5;
      // In TORCS body frame, turning left gives lastAyMs2 > 0 -> outside Right wheels compress (+), inside Left extend (-)
      const rollShift = isRight ? latLoadTransferN * 0.5 : -latLoadTransferN * 0.5;

      const effectiveCornerK = Math.max(50_000, susp.spring.K * susp.bellcrank);
      const effectiveHeaveK = effectiveCornerK + 0.5 * axle.heaveSusp.spring.K;
      const effectiveRollK = effectiveCornerK + 2.0 * axle.arbStiffness;
      const dynamicExtraDeflection =
        (aeroCorner + pitchShift) / effectiveHeaveK + rollShift / effectiveRollK;

      // Set wheel vertical world position relative to road so SimWheelUpdateRide
      // computes the exact physical compression (including kerb/surface bump)
      w.worldPos.y = w.zRoad - dynamicExtraDeflection;

      const wheelStateForRide = {
        ...w,
        worldPos: { x: w.worldPos.x, y: w.worldPos.z, z: w.worldPos.y },
      };
      simWheelUpdateRide(
        wheelStateForRide,
        this.config.wheels[i],
        susp,
        this.rollRad,
        contact.bankRad,
        dt
      );
      w.rideHeight = wheelStateForRide.rideHeight;
      w.effCamberRad = wheelStateForRide.effCamberRad;
    }

    // =========================================================================
    // 9. SimAxleUpdate (Front & Rear Anti-Roll Bars + 3rd/Heave Springs)
    // =========================================================================
    simAxleUpdate(this.axles[0], this.suspensions[0], this.suspensions[1], dt);
    simAxleUpdate(this.axles[1], this.suspensions[2], this.suspensions[3], dt);

    // =========================================================================
    // 10. SimWheelUpdateForce (4-Wheel Contact Patch Pacejka Magic Formula)
    // =========================================================================
    const ambientTempC = 27; // Kigali tropical ambient temperature
    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const axle = isFront ? this.axles[0] : this.axles[1];

      // Note: aeroCorner is already transmitted through susp.force + axle.thirdForcePerWheel
      // via dynamicExtraDeflection above, so we pass 0 for extra external Fz to avoid double-counting.
      simWheelUpdateForce(
        this.wheels[i],
        this.config.wheels[i],
        this.suspensions[i],
        axle,
        0,
        this.tireCompound,
        ambientTempC,
        dt
      );
    }

    // =========================================================================
    // 11. SimDifferentialUpdate (1.5-Way Salisbury LSD & Engine RPM Coupling)
    // =========================================================================
    const rearSpinVels: [number, number] = [
      this.wheels[2].spinVel,
      this.wheels[3].spinVel,
    ];
    simDifferentialUpdate(
      this.drivetrain,
      this.config,
      rearSpinVels,
      [this.drivetrain.brakes[2].tqNm, this.drivetrain.brakes[3].tqNm],
      throttleCmd,
      dt
    );
    this.wheels[2].spinVel = rearSpinVels[0];
    this.wheels[3].spinVel = rearSpinVels[1];
    this.rpm = this.drivetrain.engine.rpm;

    // =========================================================================
    // 12. SimWheelUpdateRotation (4-Wheel Rotational Spin Dynamics & Lockup)
    // =========================================================================
    for (let i = 0; i < 4; i++) {
      const isRear = i >= 2;
      const driveTq = isRear ? this.drivetrain.rearDiff.outTq[i - 2] : 0;
      const effI = isRear
        ? this.drivetrain.rearDiff.outI[i - 2]
        : this.config.wheels[i].inertia + this.config.wheels[i].brakeInertia;

      simWheelUpdateRotation(
        this.wheels[i],
        this.config.wheels[i],
        this.drivetrain.brakes[i],
        driveTq,
        effI,
        this.vxMs,
        throttleCmd,
        dt
      );
    }
    this.wheelRotationRad = this.wheels[0].rotationRad;

    // =========================================================================
    // 13. SimCarUpdate (Sum Forces & Moments, Integrate Rigid-Body Velocities & Pose)
    // =========================================================================
    const invMass = 1.0 / totalMass;
    const weightN = totalMass * GRAVITY;

    // Longitudinal gravity component along track slope & lateral banking component
    const fGravX = -weightN * sample.slopeSin;
    // Banking supports cornering inside turns; gate by corner curvature so straightaways never pull sideways
    const curvatureBankGate = THREE.MathUtils.clamp(
      (Math.abs(sample.curvature) - 0.0018) / 0.004,
      0,
      1
    );
    const fGravY =
      -weightN *
      Math.sin(sample.bankingRad) *
      Math.cos(this.headingErrorRad) *
      0.48 *
      curvatureBankGate;

    let sumFx = fGravX + this.aeroState.drag + this.aeroState.wings[0].forceX + this.aeroState.wings[1].forceX;
    let sumFy = fGravY;
    let sumMzTorcs = 0;
    let totalRollRes = 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      sumFx += w.forcesCar.x;
      sumFy += w.forcesCar.y;
      totalRollRes += w.rollResN;

      // Yaw moment Mz from car.cpp lines 674-676:
      // F.M.z += -wheel[i].forces.x * wheel[i].staticPos.y + wheel[i].forces.y * wheel[i].staticPos.x
      sumMzTorcs +=
        -w.forcesCar.x * w.staticPos.y +
        w.forcesCar.y * w.staticPos.x -
        w.torqueAlignNm;
    }

    // Rolling resistance opposing velocity vector (car.cpp lines 693-715)
    const speed2D = Math.hypot(this.vxMs, this.vyMs);
    if (speed2D > 1e-4) {
      const rv = speed2D > 10.0 ? totalRollRes / speed2D : totalRollRes / 10.0;
      const clampedRv = Math.min(rv, (speed2D * totalMass) / dt);
      sumFx -= clampedRv * this.vxMs;
      sumFy -= clampedRv * this.vyMs;
    }

    // 4-wheel Pacejka lateral tire forces & pneumatic trail govern yaw and lateral dynamics,
    // supplemented by physical shark-fin / rear-wing aerodynamic weathervane stability (Cn_beta)
    // and scaling up during extreme slides (>20 deg heading error) or off-track excursions.
    const isOffTrack = Math.abs(this.lateralOffsetM) > sample.width * 0.5;
    const slideIntensity = THREE.MathUtils.clamp(
      (Math.abs(this.headingErrorRad) - 0.35) / 0.55 + (isOffTrack ? 0.35 : 0),
      0,
      1
    );
    const aeroWeathervaneMz =
      slideIntensity * Math.max(8.0, Math.abs(this.vxMs)) * this.vyMs * 32.0 -
      yawRateTorcs * (85.0 + slideIntensity * (450.0 + Math.abs(this.vxMs) * 16.0));
    sumMzTorcs += aeroWeathervaneMz;

    // Crucial Symmetry & Straight-Line Stability Guarantee:
    // When steering input is zero (`Math.abs(torcsSteerCmd) < 1e-4`),
    // any microscopic floating-point or surface asymmetry is zeroed and lateral slip velocity / yaw rate
    // are naturally damped by the 4-tire cornering stiffness so the car never turns on its own.
    if (
      Math.abs(torcsSteerCmd) < 1e-4 &&
      Math.abs(this.vyMs) < 0.01 &&
      Math.abs(this.yawRateRadS) < 0.01
    ) {
      sumFy = 0;
      sumMzTorcs = 0;
      this.vyMs = 0;
      this.yawRateRadS = 0;
    }

    // Compute linear & angular accelerations in car frame
    const axCar = sumFx * invMass;
    const ayCar = sumFy * invMass;
    const yawAccelTorcs = sumMzTorcs / this.yawInertiaKgM2;

    // Integrate velocities (`SimCarUpdateSpeed` in `car.cpp`)
    // Include centripetal coupling in body frame: dvx/dt = ax + vy * r, dvy/dt = ay - vx * r
    this.vxMs += (axCar + this.vyMs * yawRateTorcs) * dt;
    this.vyMs += (ayCar - this.vxMs * yawRateTorcs) * dt;

    const latDamping = Math.exp(-(0.20 + 3.2 * slideIntensity) * dt);
    const yawDamping = Math.exp(-(0.15 + 4.2 * slideIntensity) * dt);
    this.vyMs *= latDamping;
    const nextYawRateTorcs = (yawRateTorcs + yawAccelTorcs * dt) * yawDamping;
    this.yawRateRadS = THREE.MathUtils.clamp(-nextYawRateTorcs, -4.5, 4.5);

    // FEAT_SLOWGRIP (`car.cpp` lines 723-757):
    // Prevent stationary turning, sideways creep, or backward rolling when parked!
    if (Math.abs(this.vxMs) < 0.06 && throttleCmd < 0.02) {
      this.vxMs = 0;
      this.vyMs = 0;
      this.yawRateRadS = 0;
      this.lastAxMs2 = 0;
      this.lastAyMs2 = 0;
    } else if (Math.abs(this.vxMs) < 0.08) {
      // Even when throttle is just cracked at standstill, yaw rate scales strictly with forward motion
      // so the car NEVER spins in place when speed is 0!
      const motionGate = Math.min(1.0, Math.abs(this.vxMs) / 0.08);
      this.yawRateRadS *= motionGate;
      this.vyMs *= motionGate;
    }

    // Clamp reverse speed if not in reverse gear
    if (this.gear >= 0 && this.vxMs < 0) {
      this.vxMs = 0;
    }

    this.lastAxMs2 += (axCar - this.lastAxMs2) * Math.min(1.0, 18.0 * dt);
    this.lastAyMs2 += (ayCar - this.lastAyMs2) * Math.min(1.0, 18.0 * dt);

    // Update 3D Chassis Pitch, Roll & Vertical Heave from suspension forces
    const targetPitchRad = THREE.MathUtils.clamp(
      this.lastAxMs2 * 0.00085,
      -0.026,
      0.026
    );
    const targetRollRad = THREE.MathUtils.clamp(
      this.lastAyMs2 * 0.00095,
      -0.032,
      0.032
    );
    this.pitchRad += (targetPitchRad - this.pitchRad) * Math.min(1.0, 16.0 * dt);
    this.rollRad += (targetRollRad - this.rollRad) * Math.min(1.0, 16.0 * dt);

    const avgRideHeight =
      0.25 *
      (this.wheels[0].rideHeight +
        this.wheels[1].rideHeight +
        this.wheels[2].rideHeight +
        this.wheels[3].rideHeight);
    this.rideHeightOffsetM = avgRideHeight - 0.039;

    // Integrate 3D Cartesian World Position `(worldX, worldZ)` and Yaw `worldYawRad` directly at 500 Hz
    // so track spline curvature never injects phantom steering into the vehicle!
    const prevS = this.sMeters;
    if (Math.abs(this.vxMs) >= 0.05) {
      this.worldYawRad = Math.atan2(
        Math.sin(this.worldYawRad - this.yawRateRadS * dt),
        Math.cos(this.worldYawRad - this.yawRateRadS * dt)
      );
    }

    const sinYaw = Math.sin(this.worldYawRad);
    const cosYaw = Math.cos(this.worldYawRad);
    // Forward unit vector in XZ is (sinYaw, cosYaw); Left unit vector (+vyMs in TORCS) is (cosYaw, -sinYaw)
    const vWorldX = this.vxMs * sinYaw + this.vyMs * cosYaw;
    const vWorldZ = this.vxMs * cosYaw - this.vyMs * sinYaw;

    this.worldX += vWorldX * dt;
    this.worldZ += vWorldZ * dt;

    // Project 3D Cartesian world position onto the track centerline spline for telemetry, AI, and surface queries
    const projected = this.track.projectWorldToTrack(
      this.worldX,
      this.worldZ,
      prevS
    );
    const nextSample = projected.sample;
    this.sMeters = projected.s;
    this.lateralOffsetM = projected.lateralOffset;

    const trackHeadingRad = Math.atan2(
      nextSample.tangent.x,
      nextSample.tangent.z
    );
    let rawHeadingErr = trackHeadingRad - this.worldYawRad;
    while (rawHeadingErr > Math.PI) rawHeadingErr -= Math.PI * 2;
    while (rawHeadingErr < -Math.PI) rawHeadingErr += Math.PI * 2;
    this.headingErrorRad = THREE.MathUtils.clamp(
      rawHeadingErr,
      -Math.PI * 0.48,
      Math.PI * 0.48
    );

    if (
      Math.abs(this.vxMs) >= 0.05 &&
      Math.abs(this.headingErrorRad) > Math.PI * 0.32 &&
      (Math.abs(torcsSteerCmd) > 1e-4 || Math.abs(this.yawRateRadS) > 0.01)
    ) {
      // Weathervane / rear-fin aerodynamic & countersteer alignment at extreme slip angles (>58 deg)
      const excessRatio =
        (Math.abs(this.headingErrorRad) - Math.PI * 0.32) / (Math.PI * 0.16);
      this.headingErrorRad *= Math.exp(-2.2 * excessRatio * dt);
      this.yawRateRadS *= Math.exp(-3.0 * excessRatio * dt);
      this.worldYawRad = Math.atan2(
        Math.sin(trackHeadingRad - this.headingErrorRad),
        Math.cos(trackHeadingRad - this.headingErrorRad)
      );
    }

    // Soft barrier containment at outer runoff wall (`halfWidth + 4.8m`)
    const maxWallOffset = nextSample.width * 0.5 + 4.8;
    if (Math.abs(this.lateralOffsetM) > maxWallOffset) {
      this.lateralOffsetM = Math.sign(this.lateralOffsetM) * maxWallOffset;
      this.vyMs *= Math.exp(-12.0 * dt);
      this.vxMs *= Math.exp(-0.8 * dt);
      this.headingErrorRad *= Math.exp(-3.2 * dt);
      this.yawRateRadS *= Math.exp(-6.0 * dt);
      this.worldX =
        nextSample.position.x + nextSample.binormal.x * this.lateralOffsetM;
      this.worldZ =
        nextSample.position.z + nextSample.binormal.z * this.lateralOffsetM;
      this.worldYawRad = Math.atan2(
        Math.sin(trackHeadingRad - this.headingErrorRad),
        Math.cos(trackHeadingRad - this.headingErrorRad)
      );
    }

    this.lastSyncedSMeters = this.sMeters;
    this.lastSyncedLateralOffsetM = this.lateralOffsetM;
    this.lastSyncedHeadingErrorRad = this.headingErrorRad;

    // Compute steering Force-Feedback (FFB) torque from front tire pneumatic trail self-aligning torque
    const frontAlignTq =
      (this.wheels[0].torqueAlignNm + this.wheels[1].torqueAlignNm) * 0.5;
    const frontLatForce =
      (this.wheels[0].fnN + this.wheels[1].fnN) * 0.5;
    this.ffbTorqueNorm = THREE.MathUtils.clamp(
      (frontAlignTq / 85.0) + (frontLatForce / 9500.0) * 0.65,
      -1.0,
      1.0
    );

    this.frontSlipRatioNorm = Math.max(
      this.wheels[0].combinedSlipNorm,
      this.wheels[1].combinedSlipNorm
    );
    this.rearSlipRatioNorm = Math.max(
      this.wheels[2].combinedSlipNorm,
      this.wheels[3].combinedSlipNorm
    );

    // Check sector & lap completion
    if (nextSample.sector !== this.lastSector) {
      this.onSectorCompleted(this.lastSector);
      this.lastSector = nextSample.sector;
    }
    if (prevS > TRACK_TOTAL_LENGTH_M * 0.85 && this.sMeters < TRACK_TOTAL_LENGTH_M * 0.15) {
      this.onLapCompleted();
    }
  }

  /**
   * Computes the 3D world positions of all 4 wheels from the current chassis pose.
   */
  private updateWheelWorldPositions(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): void {
    const carGroundY = evaluateSampleLateralHeightM(sample, this.lateralOffsetM);
    const carPos = new THREE.Vector3(this.worldX, carGroundY, this.worldZ);

    const carUp = sample.normal.clone().normalize();
    const hx = Math.sin(this.worldYawRad);
    const hz = Math.cos(this.worldYawRad);
    const fy =
      Math.abs(carUp.y) > 1e-4 ? -(hx * carUp.x + hz * carUp.z) / carUp.y : 0;
    const carForward = new THREE.Vector3(hx, fy, hz).normalize();
    const carRight = new THREE.Vector3()
      .crossVectors(carForward, carUp)
      .normalize();

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      // staticPos.x is forward, staticPos.y is left (-staticPos.y is right)
      const wp = carPos
        .clone()
        .addScaledVector(carForward, w.staticPos.x)
        .addScaledVector(carRight, -w.staticPos.y);
      w.worldPos.x = wp.x;
      w.worldPos.y = wp.y;
      w.worldPos.z = wp.z;
    }
  }

  /**
   * Builds the full `AssettoCorsaGymObservation` vector (`AssettoCorsaEnv/ac_env.py`)
   */
  private buildObservation(
    sample: ReturnType<BuiltTrackData['getSampleAtDistance']>
  ): AssettoCorsaGymObservation {
    const { lookaheadCurvatures, lookaheadTargetSpeedsMs } = computeLookaheadVectors(
      this.track,
      this.sMeters
    );
    const racelineOffsetM = sample.racingLineOffset * sample.width * 0.30;
    const gapToRacingLineM = this.lateralOffsetM - racelineOffsetM;

    let wheelsOut = 0;
    for (let i = 0; i < 4; i++) {
      if (this.wheels[i].surfaceType === 'runoff' || this.wheels[i].surfaceType === 'grass') {
        wheelsOut++;
      }
    }

    return {
      speedMs: this.vxMs,
      localVelocityX: this.vxMs,
      localVelocityY: this.vyMs,
      localVelocityZ: this.vzMs,
      angularVelocityX: this.rollVelRadS,
      angularVelocityY: this.pitchVelRadS,
      angularVelocityZ: -this.yawRateRadS,
      accelX: this.lastAxMs2,
      accelY: this.lastAyMs2,
      rollRad: this.rollRad,
      pitchRad: this.pitchRad,
      yawRad: Math.atan2(sample.tangent.x, sample.tangent.z) - this.headingErrorRad,
      engineRpm: this.rpm,
      gear: this.gear,
      normalizedSplinePosition: this.sMeters / TRACK_TOTAL_LENGTH_M,
      gapToRacingLineM,
      lateralOffsetCenterM: this.lateralOffsetM,
      headingErrorRad: this.headingErrorRad,
      slipAngleRad: [
        this.wheels[0].slipAngleRad,
        this.wheels[1].slipAngleRad,
        this.wheels[2].slipAngleRad,
        this.wheels[3].slipAngleRad,
      ],
      slipRatio: [
        this.wheels[0].slipRatio,
        this.wheels[1].slipRatio,
        this.wheels[2].slipRatio,
        this.wheels[3].slipRatio,
      ],
      tyreLoadN: [
        this.wheels[0].fzN,
        this.wheels[1].fzN,
        this.wheels[2].fzN,
        this.wheels[3].fzN,
      ],
      rideHeightM: [
        this.wheels[0].rideHeight,
        this.wheels[1].rideHeight,
        this.wheels[2].rideHeight,
        this.wheels[3].rideHeight,
      ],
      tyreTempC: [
        this.wheels[0].tempC,
        this.wheels[1].tempC,
        this.wheels[2].tempC,
        this.wheels[3].tempC,
      ],
      lookaheadCurvatures,
      lookaheadTargetSpeedsMs,
      wheelsOutOfTrack: wheelsOut,
      outOfTrack: wheelsOut >= 3,
    };
  }

  private updateTelemetrySnapshot(
    sample: ReturnType<BuiltTrackData['getSampleAtDistance']>,
    inputs: ControlInputs
  ): void {
    const speedKmh = Math.max(0, this.vxMs * 3.6);
    if (speedKmh > this.telemetry.topSpeedThisLapKmh) {
      this.telemetry.topSpeedThisLapKmh = speedKmh;
    }
    if (speedKmh > this.telemetry.allTimeTopSpeedKmh) {
      this.telemetry.allTimeTopSpeedKmh = speedKmh;
    }

    const eng = this.drivetrain.engine;
    const icePowerKw = Math.max(0, (eng.tqIceNm * eng.rads) / 1000.0);
    const mgukPowerKw = eng.mgukPowerKw;
    const totalPowerKw = Math.max(0, icePowerKw + Math.max(0, mgukPowerKw));

    // Note: in `this.wheels`, indices are 0:FR, 1:FL, 2:RR, 3:RL (TORCS order).
    // In `CarTelemetry`, 4-wheel arrays are ordered [FL, FR, RL, RR] (indices 1, 0, 3, 2).
    const wFL = this.wheels[1];
    const wFR = this.wheels[0];
    const wRL = this.wheels[3];
    const wRR = this.wheels[2];

    const bFL = this.drivetrain.brakes[1];
    const bFR = this.drivetrain.brakes[0];
    const bRL = this.drivetrain.brakes[3];
    const bRR = this.drivetrain.brakes[2];

    const sFL = this.suspensions[1];
    const sFR = this.suspensions[0];
    const sRL = this.suspensions[3];
    const sRR = this.suspensions[2];

    const onKerbLeft = wFL.surfaceType === 'kerb' || wRL.surfaceType === 'kerb';
    const onKerbRight = wFR.surfaceType === 'kerb' || wRR.surfaceType === 'kerb';
    const offTrack = this.lastObservation.outOfTrack;
    if (offTrack) {
      this.lapValid = false;
    }

    let dominantSurface: SurfaceType = 'asphalt';
    if (wFL.surfaceType === 'grass' || wFR.surfaceType === 'grass') {
      dominantSurface = 'grass';
    } else if (wFL.surfaceType === 'runoff' || wFR.surfaceType === 'runoff') {
      dominantSurface = 'runoff';
    } else if (onKerbLeft || onKerbRight) {
      dominantSurface = 'kerb';
    }

    const brakingUrgency = evaluateDynamicBrakingUrgency(
      this.track,
      this.sMeters,
      this.vxMs,
      (this.sMeters + 25) % TRACK_TOTAL_LENGTH_M,
      this.track.getSampleAtDistance((this.sMeters + 25) % TRACK_TOTAL_LENGTH_M).optimalSpeedKmh / 3.6
    );

    const nowMs = this.simTimeMs;

    this.telemetry.speedMs = this.vxMs;
    this.telemetry.speedKmh = speedKmh;
    this.telemetry.rpm = Math.round(this.rpm);
    this.telemetry.gear = this.gear;
    this.telemetry.throttle = this.aiAutopilot
      ? THREE.MathUtils.clamp(eng.tqIceNm / 400, 0, 1)
      : inputs.throttle;
    this.telemetry.brake = this.aiAutopilot
      ? THREE.MathUtils.clamp(bFL.pressurePa / this.config.brakeSystem.maxPressurePa, 0, 1)
      : inputs.brake;
    this.telemetry.clutch = this.drivetrain.clutch.transferValue;
    this.telemetry.steering = this.steerAngleNorm;
    this.telemetry.longitudinalG = this.lastAxMs2 / GRAVITY;
    this.telemetry.lateralG = -this.lastAyMs2 / GRAVITY;
    this.telemetry.verticalG =
      1.0 + this.aeroState.totalDownforceN / (this.massKg * GRAVITY);

    this.telemetry.altitudeM = BASE_ALTITUDE_M + sample.position.y;
    this.telemetry.trackElevationM = sample.position.y;
    this.telemetry.airDensityKgM3 = this.config.aero.airDensity;
    this.telemetry.activeAeroMode = this.activeAeroMode;
    this.telemetry.autoXMode = this.autoXMode;
    this.telemetry.downforceN = this.aeroState.totalDownforceN;
    this.telemetry.downforceKgf = this.aeroState.totalDownforceN / GRAVITY;
    this.telemetry.frontDownforceN = this.aeroState.frontDownforceN;
    this.telemetry.rearDownforceN = this.aeroState.rearDownforceN;
    this.telemetry.groundEffectFactor = this.aeroState.groundEffectFactor;
    this.telemetry.dragN = this.aeroState.totalDragN;

    this.telemetry.icePowerKw = icePowerKw;
    this.telemetry.mgukPowerKw = mgukPowerKw;
    this.telemetry.totalPowerKw = totalPowerKw;
    this.telemetry.ersBatteryPercent =
      (this.ersEnergyJ / this.maxErsEnergyJ) * 100;
    this.telemetry.manualOverrideActive =
      eng.ersMode === 'OVERRIDE' || eng.boostRemainingS > 0;
    this.telemetry.boostRemainingS = eng.boostRemainingS;
    this.telemetry.turboBoostBar =
      1.0 + 2.4 * this.telemetry.throttle * Math.min(1, this.rpm / 10500);
    this.telemetry.fuelKg = eng.fuelKg;

    this.telemetry.tireSlipRatio = [
      wFL.combinedSlipNorm,
      wFR.combinedSlipNorm,
      wRL.combinedSlipNorm,
      wRR.combinedSlipNorm,
    ];
    this.telemetry.wheelSlipRatios = [
      wFL.slipRatio,
      wFR.slipRatio,
      wRL.slipRatio,
      wRR.slipRatio,
    ];
    this.telemetry.wheelSlipAnglesDeg = [
      THREE.MathUtils.radToDeg(wFL.slipAngleRad),
      THREE.MathUtils.radToDeg(wFR.slipAngleRad),
      THREE.MathUtils.radToDeg(wRL.slipAngleRad),
      THREE.MathUtils.radToDeg(wRR.slipAngleRad),
    ];
    this.telemetry.wheelLoadsN = [
      Math.round(wFL.fzN),
      Math.round(wFR.fzN),
      Math.round(wRL.fzN),
      Math.round(wRR.fzN),
    ];
    this.telemetry.wheelRideHeightsMm = [
      Math.round(wFL.rideHeight * 1000),
      Math.round(wFR.rideHeight * 1000),
      Math.round(wRL.rideHeight * 1000),
      Math.round(wRR.rideHeight * 1000),
    ];
    this.telemetry.suspensionTravelMm = [
      Math.round(sFL.x * 1000),
      Math.round(sFR.x * 1000),
      Math.round(sRL.x * 1000),
      Math.round(sRR.x * 1000),
    ];
    this.telemetry.tireTempsC = [
      Math.round(wFL.tempC),
      Math.round(wFR.tempC),
      Math.round(wRL.tempC),
      Math.round(wRR.tempC),
    ];
    this.telemetry.tireWearPct = [
      Number(wFL.wearPct.toFixed(1)),
      Number(wFR.wearPct.toFixed(1)),
      Number(wRL.wearPct.toFixed(1)),
      Number(wRR.wearPct.toFixed(1)),
    ];
    this.telemetry.tireGripFactor = [
      Number((wFL.effectiveMu / this.config.wheels[1].mu0).toFixed(2)),
      Number((wFR.effectiveMu / this.config.wheels[0].mu0).toFixed(2)),
      Number((wRL.effectiveMu / this.config.wheels[3].mu0).toFixed(2)),
      Number((wRR.effectiveMu / this.config.wheels[2].mu0).toFixed(2)),
    ];
    this.telemetry.brakeTempsC = [bFL.tempC, bFR.tempC, bRL.tempC, bRR.tempC];
    this.telemetry.wheelSurfaces = [
      wFL.surfaceType,
      wFR.surfaceType,
      wRL.surfaceType,
      wRR.surfaceType,
    ];

    this.telemetry.frontSlipAngleDeg =
      0.5 *
      (this.telemetry.wheelSlipAnglesDeg[0] +
        this.telemetry.wheelSlipAnglesDeg[1]);
    this.telemetry.rearSlipAngleDeg =
      0.5 *
      (this.telemetry.wheelSlipAnglesDeg[2] +
        this.telemetry.wheelSlipAnglesDeg[3]);
    this.telemetry.ffbTorqueNorm = this.ffbTorqueNorm;
    this.telemetry.ffbClipping = Math.abs(this.ffbTorqueNorm) > 0.94;

    this.telemetry.onKerbLeft = onKerbLeft;
    this.telemetry.onKerbRight = onKerbRight;
    this.telemetry.offTrack = offTrack;
    this.telemetry.surface = dominantSurface;

    this.telemetry.trackDistanceM = this.sMeters;
    this.telemetry.trackProgress = this.sMeters / TRACK_TOTAL_LENGTH_M;
    this.telemetry.lateralOffsetM = this.lateralOffsetM;
    this.telemetry.gapToRacingLineM = this.lastObservation.gapToRacingLineM;
    this.telemetry.headingErrorRad = this.headingErrorRad;
    this.telemetry.targetCornerSpeedKmh = Math.round(sample.optimalSpeedKmh);
    this.telemetry.brakingUrgency = brakingUrgency;
    this.telemetry.currentSector = sample.sector;
    this.telemetry.currentTurnNumber = sample.turnNumber;
    this.telemetry.currentTurnName = sample.turnName;
    this.telemetry.bankingDeg = THREE.MathUtils.radToDeg(sample.bankingRad);
    this.telemetry.slopePercent = sample.slopeSin * 100;
    this.telemetry.currentLapTimeMs = Math.max(0, nowMs - this.currentLapStartMs);
    this.telemetry.aiAutopilot = this.aiAutopilot;
  }

  private onSectorCompleted(completedSector: 1 | 2 | 3): void {
    const nowMs = this.simTimeMs;
    const sectorDuration = nowMs - this.currentSectorStartMs;
    this.currentSectorStartMs = nowMs;

    const idx = completedSector - 1;
    if (sectorDuration > 8000) {
      this.telemetry.sectorTimesMs[idx] = sectorDuration;
      const prevBest = this.telemetry.bestSectorTimesMs[idx];
      if (prevBest === null || sectorDuration < prevBest) {
        this.telemetry.bestSectorTimesMs[idx] = sectorDuration;
      }
    }
  }

  private onLapCompleted(): void {
    const nowMs = this.simTimeMs;
    const lapTime = nowMs - this.currentLapStartMs;
    this.onSectorCompleted(3);
    this.currentLapStartMs = nowMs;

    if (lapTime > 45_000) {
      this.telemetry.lastLapTimeMs = lapTime;
      if (
        this.telemetry.bestLapTimeMs === null ||
        (this.lapValid && lapTime < this.telemetry.bestLapTimeMs)
      ) {
        this.telemetry.bestLapTimeMs = lapTime;
      }
    }

    this.telemetry.lapCount++;
    this.telemetry.topSpeedThisLapKmh = this.vxMs * 3.6;
    this.ersEnergyJ = Math.min(this.maxErsEnergyJ, this.ersEnergyJ + 1_500_000);
    this.drivetrain.engine.ersEnergyJ = this.ersEnergyJ;
    this.lapValid = true;
  }

  private syncWorldTransform(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    const exactGroundY = evaluateSampleLateralHeightM(sample, this.lateralOffsetM);

    this.worldPosition.set(this.worldX, exactGroundY, this.worldZ);

    // Derive surface normal from local lateral slope across the car's track width and longitudinal slope
    const yLeft = evaluateSampleLateralHeightM(sample, this.lateralOffsetM - 0.8);
    const yRight = evaluateSampleLateralHeightM(sample, this.lateralOffsetM + 0.8);
    const localBankRad = Math.atan2(yLeft - yRight, 1.6);

    const rightFlat = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
    const upFlat = new THREE.Vector3().crossVectors(rightFlat, sample.tangent).normalize();
    const carUp = upFlat.applyAxisAngle(sample.tangent, localBankRad).normalize();

    const hx = Math.sin(this.worldYawRad);
    const hz = Math.cos(this.worldYawRad);
    const fy =
      Math.abs(carUp.y) > 1e-4 ? -(hx * carUp.x + hz * carUp.z) / carUp.y : 0;
    const carForward = new THREE.Vector3(hx, fy, hz).normalize();
    const carLeft = new THREE.Vector3()
      .crossVectors(carUp, carForward)
      .normalize();

    const basisMatrix = new THREE.Matrix4().makeBasis(
      carLeft,
      carUp,
      carForward
    );
    this.worldQuaternion.setFromRotationMatrix(basisMatrix);
  }
}

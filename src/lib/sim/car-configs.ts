/**
 * Data-driven Vehicle Configuration Schema
 *
 * Ported from:
 * - TORCS / Speed Dreams `simuv4` & `simuv5` XML parameter sections
 *   (`SECT_CAR`, `SECT_AERODYNAMICS`, `SECT_FRNTWING`, `SECT_REARWING`,
 *    `SECT_ENGINE`, `SECT_GEARBOX`, `SECT_REARDIFF`, `SECT_BRKSYST`,
 *    `SECT_FRNTAXLE`, `SECT_REARAXLE`, `SECT_FRNTLFTSUSP`, `SECT_FRNTLFTWHL`, etc.)
 * - `assetto_corsa_gym` (`AssettoCorsaConfigs/cars/*.json`) vehicle & tire parameters
 */

import { TireCompound } from '@/types/f1';

export type WheelCornerIndex = 0 | 1 | 2 | 3; // 0: FR, 1: FL, 2: RR, 3: RL (matching TORCS FRNT_RGT=0, FRNT_LFT=1, REAR_RGT=2, REAR_LFT=3)

export interface SimSuspensionSpringConfig {
  /** Spring stiffness K (N/m) */
  K: number;
  /** Initial static preload force F0 (N) */
  F0: number;
  /** Rest length x0 (m) */
  x0: number;
  /** Maximum suspension travel xMax (m) */
  xMax: number;
  /** Packer / bump-stop engagement thickness (m) */
  packers: number;
}

export interface SimSuspensionDamperConfig {
  /** Slow bump damping coefficient (N·s/m) */
  bumpSlow: number;
  /** Fast bump damping coefficient (N·s/m) */
  bumpFast: number;
  /** Slow rebound damping coefficient (N·s/m) */
  reboundSlow: number;
  /** Fast rebound damping coefficient (N·s/m) */
  reboundFast: number;
  /** Velocity knee v1 between slow and fast bump (m/s) */
  bumpLv: number;
  /** Velocity knee v1 between slow and fast rebound (m/s) */
  reboundLv: number;
}

export interface SimCornerSuspensionConfig {
  spring: SimSuspensionSpringConfig;
  damper: SimSuspensionDamperConfig;
  /** Bellcrank motion ratio */
  bellcrank: number;
  /** Unsprung mass inertance (kg) */
  inertance: number;
}

export interface SimAxleConfig {
  /** Anti-roll bar stiffness (N/m) */
  arbStiffness: number;
  /** Third / heave spring configuration (controls aerodynamic platform pitch/heave) */
  heaveSpring: SimSuspensionSpringConfig;
  heaveDamper: SimSuspensionDamperConfig;
  /** Roll center height above ground (m) */
  rollCenterHeight: number;
}

export interface SimWheelConfig {
  /** Longitudinal position relative to chassis origin/GC (m, +forward, -rear) */
  relPosX: number;
  /** Lateral position relative to chassis GC (m, +left, -right in TORCS convention) */
  relPosY: number;
  /** Static ride height (m) */
  rideHeight: number;
  /** Wheel rim + tire effective radius (m) */
  radius: number;
  /** Tire contact patch width (m) */
  width: number;
  /** Rotational inertia of wheel + tire assembly (kg·m²) */
  inertia: number;
  /** Static camber angle (rad, negative = top tilted inward) */
  camberRad: number;
  /** Static toe angle (rad,front toe-out / rear toe-in) */
  toeRad: number;
  /** Kingpin caster angle (rad) */
  casterRad: number;
  /** Rolling resistance coefficient */
  rollingResistance: number;
  /** Base friction coefficient mu0 */
  mu0: number;
  /** Pacejka Magic Formula shape factor C */
  mfC: number;
  /** Pacejka Magic Formula curvature factor E */
  mfE: number;
  /** Slip at peak force sm (slip ratio / tan(alpha)) */
  slipMax: number;
  /** Load sensitivity minimum factor lfMin */
  lfMin: number;
  /** Load sensitivity maximum factor lfMax */
  lfMax: number;
  /** Nominal operating vertical load opLoad (N) */
  opLoad: number;
  /** Load sensitivity exponential constant lfK */
  lfK: number;
  /** Self-aligning torque pneumatic trail factor (m) */
  alignTqFactor: number;
  /** Optimal operating temperature Topt (°C) */
  tempOptC: number;
  /** Initial temperature Tinit (°C) */
  tempInitC: number;
  /** Hysteresis heating factor */
  heatingMult: number;
  /** Air cooling factor */
  airCoolingMult: number;
  /** Brake disc diameter (m) */
  brakeDiameter: number;
  /** Brake pad area (m²) */
  brakeArea: number;
  /** Brake pad friction coefficient */
  brakeMu: number;
  /** Brake disc rotational inertia (kg·m²) */
  brakeInertia: number;
}

export interface SimAeroWingConfig {
  /** Wing planform area (m²) */
  area: number;
  /** Z-Mode (high downforce) angle of attack (rad) */
  angleZModeRad: number;
  /** X-Mode (low drag straight-line active aero) angle of attack (rad) */
  angleXModeRad: number;
  /** Longitudinal position relative to GC (m) */
  posX: number;
  /** Vertical position relative to GC (m) */
  posZ: number;
  /** Downforce efficiency multiplier */
  downforceMult: number;
  /** Induced drag multiplier */
  dragMult: number;
}

export interface SimAerodynamicsConfig {
  /** Frontal area (m²) */
  frontalArea: number;
  /** Base parasitic drag coefficient Cx */
  cx: number;
  /** Front undertray ground-effect lift/downforce coefficient Clift0 */
  frontClift: number;
  /** Rear diffuser ground-effect lift/downforce coefficient Clift1 */
  rearClift: number;
  /** Air density (kg/m³) */
  airDensity: number;
  frontWing: SimAeroWingConfig;
  rearWing: SimAeroWingConfig;
}

export interface SimEngineTorquePoint {
  rpm: number;
  torqueNm: number;
}

export interface SimEngineConfig {
  /** Idle speed (RPM) */
  tickoverRpm: number;
  /** Rev limiter speed (RPM) */
  revsLimiterRpm: number;
  /** Maximum mechanical RPM */
  revsMaxRpm: number;
  /** Engine + flywheel rotational inertia (kg·m²) */
  inertia: number;
  /** Engine braking parabolic coefficient */
  brakeCoeff: number;
  /** Engine braking linear coefficient */
  brakeLinCoeff: number;
  /** Piecewise linear ICE torque curve (RPM -> Nm) */
  torqueCurve: SimEngineTorquePoint[];
  /** 2026 MGU-K maximum electrical power (W) */
  mgukMaxPowerW: number;
  /** 2026 MGU-K maximum electrical torque (Nm) */
  mgukMaxTorqueNm: number;
  /** Battery usable capacity (J) */
  ersBatteryCapacityJ: number;
}

export interface SimDifferentialConfig {
  type: 'FREE' | 'LIMITED_SLIP' | 'VISCOUS_COUPLER' | 'SPOOL';
  /** Final drive ratio */
  ratio: number;
  /** Rotational inertia (kg·m²) */
  inertia: number;
  /** Mechanical efficiency (0..1) */
  efficiency: number;
  /** Preload / threshold torque before locking (Nm) */
  lockInputTq: number;
  /** Power-side locking ratio dSlipMax (0..1) */
  dSlipMax: number;
  /** Coast/overrun locking ratio dCoastSlipMax (0..1) */
  dCoastSlipMax: number;
}

export interface SimTransmissionConfig {
  /** Gear ratios: [reverse, neutral, 1st, 2nd, 3rd, 4th, 5th, 6th, 7th, 8th] */
  gearRatios: number[];
  /** Gear rotational inertias (kg·m²) */
  gearInertias: number[];
  /** Gear mechanical efficiencies (0..1) */
  gearEfficiencies: number[];
  /** Seamless shift duration (s) */
  shiftTimeS: number;
  /** Clutch release duration (s) */
  clutchReleaseTimeS: number;
  rearDifferential: SimDifferentialConfig;
}

export interface SimBrakeSystemConfig {
  /** Front brake bias repartition (0..1, e.g. 0.565 = 56.5% front) */
  frontBias: number;
  /** Maximum hydraulic master cylinder pressure (Pa) */
  maxPressurePa: number;
  /** Enable ABS in simulation */
  enableAbs: boolean;
}

export interface SimSteerConfig {
  /** Maximum front steering lock angle (rad) */
  steerLockRad: number;
  /** Maximum steering rack angular speed (rad/s) */
  maxSteerSpeedRadS: number;
  /** Steering wheel visual rotation multiplier */
  steerWheelRotMult: number;
}

export interface SimCarConfig {
  id: string;
  name: string;
  /** Dry chassis + driver mass excluding fuel (kg) */
  dryMassKg: number;
  /** Initial fuel load (kg) */
  initialFuelKg: number;
  /** Fuel tank capacity (kg) */
  fuelTankCapacityKg: number;
  /** Overall length, width, height (m) */
  dimensions: { length: number; width: number; height: number };
  /** Static Center of Gravity height above ground (m) */
  gcHeightM: number;
  /** Front-to-rear static weight distribution (fraction on front axle, e.g. 0.455) */
  frontWeightRep: number;
  /** Rotational moments of inertia [Ixx (roll), Iyy (pitch), Izz (yaw)] (kg·m²) */
  inertiaRpy: [number, number, number];
  steer: SimSteerConfig;
  brakeSystem: SimBrakeSystemConfig;
  aero: SimAerodynamicsConfig;
  engine: SimEngineConfig;
  transmission: SimTransmissionConfig;
  axles: [SimAxleConfig, SimAxleConfig]; // [Front, Rear]
  suspensions: [
    SimCornerSuspensionConfig,
    SimCornerSuspensionConfig,
    SimCornerSuspensionConfig,
    SimCornerSuspensionConfig,
  ]; // [FR, FL, RR, RL]
  wheels: [SimWheelConfig, SimWheelConfig, SimWheelConfig, SimWheelConfig]; // [FR, FL, RR, RL]
}

export interface TireCompoundParams {
  muMultiplier: number;
  mfC: number;
  mfE: number;
  slipMax: number;
  optimalTempC: number;
  wearRateMultiplier: number;
}

export const TIRE_COMPOUND_PRESETS: Record<TireCompound, TireCompoundParams> = {
  soft: {
    muMultiplier: 1.07,
    mfC: 1.54,
    mfE: -0.18,
    slipMax: 0.088,
    optimalTempC: 95,
    wearRateMultiplier: 1.45,
  },
  medium: {
    muMultiplier: 1.0,
    mfC: 1.48,
    mfE: -0.14,
    slipMax: 0.092,
    optimalTempC: 100,
    wearRateMultiplier: 1.0,
  },
  hard: {
    muMultiplier: 0.93,
    mfC: 1.42,
    mfE: -0.10,
    slipMax: 0.098,
    optimalTempC: 106,
    wearRateMultiplier: 0.65,
  },
};

/**
 * 2026 FIA Formula 1 Technical Regulations Vehicle Configuration
 * - 768 kg minimum weight (+ fuel)
 * - 3,400 mm wheelbase, 1,900 mm max width
 * - Active Aerodynamics (Z-Mode cornering / X-Mode straight-line low drag)
 * - 50/50 Power Unit: ~400 kW 1.6L V6 Turbo ICE + 350 kW MGU-K (with Manual Override /Boost)
 * - 8-speed seamless sequential gearbox + 1.5-way Salisbury Limited Slip Differential
 */
export const FIA_2026_F1_CAR_CONFIG: SimCarConfig = {
  id: 'fia_f1_2026',
  name: 'FIA 2026 Formula 1 Single-Seater',
  dryMassKg: 768,
  initialFuelKg: 30,
  fuelTankCapacityKg: 75,
  dimensions: {
    length: 5.15,
    width: 1.90,
    height: 0.95,
  },
  gcHeightM: 0.275,
  frontWeightRep: 0.455,
  inertiaRpy: [265, 980, 1060],
  steer: {
    steerLockRad: 0.36, // ~20.6 degrees max front wheel angle
    maxSteerSpeedRadS: 2.8,
    steerWheelRotMult: 8.5,
  },
  brakeSystem: {
    frontBias: 0.565,
    maxPressurePa: 7_900_000, // 7.9 MPa peak hydraulic line pressure
    enableAbs: false,
  },
  aero: {
    frontalArea: 1.42,
    cx: 0.64,
    frontClift: 1.35, // Ground-effect front venturi tunnels (~57% of total downforce from floor)
    rearClift: 1.65,  // Ground-effect rear diffuser
    airDensity: 1.08, // Kigali ~1,500m altitude air density (kg/m³)
    frontWing: {
      area: 1.32,
      angleZModeRad: 0.23, // ~13.2 deg in Z-Mode
      angleXModeRad: 0.08, // Flattened in X-Mode
      posX: 2.15,
      posZ: 0.08,
      downforceMult: 3.8,
      dragMult: 0.82,
    },
    rearWing: {
      area: 1.15,
      angleZModeRad: 0.27, // ~15.5 deg in Z-Mode
      angleXModeRad: 0.06, // Flattened in X-Mode
      posX: -1.85,
      posZ: 0.68,
      downforceMult: 4.0,
      dragMult: 1.05,
    },
  },
  engine: {
    tickoverRpm: 4200,
    revsLimiterRpm: 13200,
    revsMaxRpm: 15000,
    inertia: 0.095,
    brakeCoeff: 0.22,
    brakeLinCoeff: 0.04,
    // 1.6L V6 Turbo ICE Torque Curve (~415 kW peak around 10,800-11,800 RPM)
    torqueCurve: [
      { rpm: 0, torqueNm: 0 },
      { rpm: 4000, torqueNm: 260 },
      { rpm: 6000, torqueNm: 335 },
      { rpm: 8000, torqueNm: 382 },
      { rpm: 9500, torqueNm: 405 },
      { rpm: 10500, torqueNm: 392 },
      { rpm: 11500, torqueNm: 365 },
      { rpm: 12500, torqueNm: 325 },
      { rpm: 13500, torqueNm: 265 },
      { rpm: 15000, torqueNm: 140 },
    ],
    mgukMaxPowerW: 350_000, // 350 kW (470 hp) electrical MGU-K
    mgukMaxTorqueNm: 340,
    ersBatteryCapacityJ: 4_000_000, // 4 MJ usable per lap
  },
  transmission: {
    // [Reverse, Neutral, 1st, 2nd, 3rd, 4th, 5th, 6th, 7th, 8th]
    gearRatios: [-3.15, 0, 3.08, 2.42, 1.98, 1.66, 1.42, 1.24, 1.10, 0.99],
    gearInertias: [0.004, 0.002, 0.0045, 0.0038, 0.0032, 0.0028, 0.0025, 0.0022, 0.002, 0.0018],
    gearEfficiencies: [0.95, 1.0, 0.97, 0.975, 0.98, 0.982, 0.985, 0.986, 0.988, 0.988],
    shiftTimeS: 0.018, // 18ms seamless shift
    clutchReleaseTimeS: 0.14,
    rearDifferential: {
      type: 'LIMITED_SLIP',
      ratio: 3.55,
      inertia: 0.048,
      efficiency: 0.975,
      lockInputTq: 180,     // 180 Nm static preload
      dSlipMax: 0.48,       // 48% power locking
      dCoastSlipMax: 0.62,  // 62% coast/overrun locking (stabilizes braking entry)
    },
  },
  axles: [
    // Front Axle
    {
      arbStiffness: 92_000,
      heaveSpring: {
        K: 145_000,
        F0: 800,
        x0: 0.015,
        xMax: 0.055,
        packers: 0.036,
      },
      heaveDamper: {
        bumpSlow: 7200,
        bumpFast: 3800,
        reboundSlow: 8600,
        reboundFast: 4200,
        bumpLv: 0.08,
        reboundLv: 0.08,
      },
      rollCenterHeight: 0.035,
    },
    // Rear Axle
    {
      arbStiffness: 68_000,
      heaveSpring: {
        K: 165_000,
        F0: 950,
        x0: 0.018,
        xMax: 0.068,
        packers: 0.046,
      },
      heaveDamper: {
        bumpSlow: 7800,
        bumpFast: 4100,
        reboundSlow: 9400,
        reboundFast: 4600,
        bumpLv: 0.08,
        reboundLv: 0.08,
      },
      rollCenterHeight: 0.055,
    },
  ],
  suspensions: [
    // 0: Front Right
    {
      spring: { K: 165_000, F0: 1400, x0: 0.018, xMax: 0.055, packers: 0.038 },
      damper: { bumpSlow: 5800, bumpFast: 3100, reboundSlow: 7400, reboundFast: 3600, bumpLv: 0.08, reboundLv: 0.08 },
      bellcrank: 1.0,
      inertance: 14.5,
    },
    // 1: Front Left
    {
      spring: { K: 165_000, F0: 1400, x0: 0.018, xMax: 0.055, packers: 0.038 },
      damper: { bumpSlow: 5800, bumpFast: 3100, reboundSlow: 7400, reboundFast: 3600, bumpLv: 0.08, reboundLv: 0.08 },
      bellcrank: 1.0,
      inertance: 14.5,
    },
    // 2: Rear Right
    {
      spring: { K: 145_000, F0: 1650, x0: 0.024, xMax: 0.068, packers: 0.048 },
      damper: { bumpSlow: 5400, bumpFast: 2900, reboundSlow: 7100, reboundFast: 3400, bumpLv: 0.08, reboundLv: 0.08 },
      bellcrank: 1.0,
      inertance: 16.5,
    },
    // 3: Rear Left
    {
      spring: { K: 145_000, F0: 1650, x0: 0.024, xMax: 0.068, packers: 0.048 },
      damper: { bumpSlow: 5400, bumpFast: 2900, reboundSlow: 7100, reboundFast: 3400, bumpLv: 0.08, reboundLv: 0.08 },
      bellcrank: 1.0,
      inertance: 16.5,
    },
  ],
  wheels: [
    // 0: Front Right (FRNT_RGT)
    {
      relPosX: 1.853,
      relPosY: -0.785,
      rideHeight: 0.032,
      radius: 0.345,
      width: 0.280,
      inertia: 1.18,
      camberRad: -0.056, // -3.2 deg
      toeRad: -0.002,
      casterRad: 0.085,
      rollingResistance: 0.011,
      mu0: 1.46,
      mfC: 1.48,
      mfE: -0.14,
      slipMax: 0.092,
      lfMin: 0.54,
      lfMax: 1.18,
      opLoad: 3600,
      lfK: -0.62,
      alignTqFactor: 0.042,
      tempOptC: 98,
      tempInitC: 92,
      heatingMult: 0.000032,
      airCoolingMult: 0.0012,
      brakeDiameter: 0.328,
      brakeArea: 0.0082,
      brakeMu: 0.42,
      brakeInertia: 0.11,
    },
    // 1: Front Left (FRNT_LFT)
    {
      relPosX: 1.853,
      relPosY: 0.785,
      rideHeight: 0.032,
      radius: 0.345,
      width: 0.280,
      inertia: 1.18,
      camberRad: -0.056,
      toeRad: 0.002,
      casterRad: 0.085,
      rollingResistance: 0.011,
      mu0: 1.46,
      mfC: 1.48,
      mfE: -0.14,
      slipMax: 0.092,
      lfMin: 0.54,
      lfMax: 1.18,
      opLoad: 3600,
      lfK: -0.62,
      alignTqFactor: 0.042,
      tempOptC: 98,
      tempInitC: 92,
      heatingMult: 0.000032,
      airCoolingMult: 0.0012,
      brakeDiameter: 0.328,
      brakeArea: 0.0082,
      brakeMu: 0.42,
      brakeInertia: 0.11,
    },
    // 2: Rear Right (REAR_RGT)
    {
      relPosX: -1.547,
      relPosY: -0.785,
      rideHeight: 0.046,
      radius: 0.352,
      width: 0.375,
      inertia: 1.42,
      camberRad: -0.031, // -1.8 deg
      toeRad: 0.003,
      casterRad: 0.0,
      rollingResistance: 0.012,
      mu0: 1.70,
      mfC: 1.48,
      mfE: -0.14,
      slipMax: 0.092,
      lfMin: 0.72,
      lfMax: 1.44,
      opLoad: 4200,
      lfK: -0.44,
      alignTqFactor: 0.045,
      tempOptC: 100,
      tempInitC: 94,
      heatingMult: 0.000034,
      airCoolingMult: 0.0011,
      brakeDiameter: 0.280,
      brakeArea: 0.0068,
      brakeMu: 0.40,
      brakeInertia: 0.09,
    },
    // 3: Rear Left (REAR_LFT)
    {
      relPosX: -1.547,
      relPosY: 0.785,
      rideHeight: 0.046,
      radius: 0.352,
      width: 0.375,
      inertia: 1.42,
      camberRad: -0.031,
      toeRad: -0.003,
      casterRad: 0.0,
      rollingResistance: 0.012,
      mu0: 1.70,
      mfC: 1.48,
      mfE: -0.14,
      slipMax: 0.092,
      lfMin: 0.72,
      lfMax: 1.44,
      opLoad: 4200,
      lfK: -0.44,
      alignTqFactor: 0.045,
      tempOptC: 100,
      tempInitC: 94,
      heatingMult: 0.000034,
      airCoolingMult: 0.0011,
      brakeDiameter: 0.280,
      brakeArea: 0.0068,
      brakeMu: 0.40,
      brakeInertia: 0.09,
    },
  ],
};

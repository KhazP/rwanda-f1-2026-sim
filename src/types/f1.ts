import type * as THREE from "three";

export type RunoffStyle =
  | "main_straight"
  | "qatar_maroon"
  | "visit_rwanda_blue"
  | "hills_yellow_green"
  | "bugesera_cyan"
  | "rwandair_blue_yellow";

export type AeroSetupPreset = "low_downforce" | "balanced" | "high_downforce";

export type ActiveAeroMode = "Z_MODE" | "X_MODE";
export type AeroMode = "Z-MODE" | "X-MODE" | ActiveAeroMode;

export type ERSMode = "HARVEST" | "BALANCED" | "HOTLAP" | "OVERRIDE";

export type SurfaceType = "asphalt" | "kerb" | "runoff" | "grass";

export type AssistPreset = "pro" | "semi_pro" | "assisted";
export type DriverAssistPreset = AssistPreset;

export interface ControlInputs {
  throttle: number;
  brake: number;
  steerLeft: number;
  steerRight: number;
  analogSteer?: number; // Optional continuous [-1..1] mouse/wheel/gamepad steer
  clutch?: number; // Optional manual clutch [0..1]
  manualOverride: boolean;
  toggleXMode: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
}

export type CameraMode =
  | "chase"
  | "tv_pod"
  | "cockpit_shoulder"
  | "cockpit"
  | "nose"
  | "helicopter"
  | "tv_side";

export type TireCompound = "soft" | "medium" | "hard";

export type LiveryId =
  | "rwanda_2026"
  | "scuderia_red"
  | "silver_arrow"
  | "papaya_apex"
  | "carbon_stealth";

export interface LiveryConfig {
  id: LiveryId;
  name: string;
  team: string;
  primary: string;
  secondary: string;
  accent: string;
  number: string;
}

export interface TrackControlPoint {
  x: number;
  y: number; // Elevation in meters (0m to +50m)
  z: number;
  bankingDeg: number; // Banking angle in degrees (up to 6 deg at T3 & T4-6)
  width: number; // Track width in meters (13m minimum, 15m main straight)
  sector: 1 | 2 | 3;
  turnNumber: number; // 0 for straight, 1..18 for turns
  turnName: string;
  runoffStyle: RunoffStyle;
  kerbLeft: boolean;
  kerbRight: boolean;
  drsZone: boolean;
  racingLineOffset: number; // -1 (left edge) to +1 (right edge)
}

export interface TrackSamplePoint {
  index: number;
  s: number; // Distance along track in meters
  t: number; // Normalized parameter 0..1
  position: THREE.Vector3;
  racingLinePos?: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3; // Right vector across track surface (including banking)
  bankingRad: number;
  width: number;
  curvature: number; // Signed horizontal curvature (1/m), positive = right turn
  verticalCurvature: number; // Signed vertical curvature (1/m)
  slopeSin: number; // Sin of longitudinal slope
  sector: 1 | 2 | 3;
  turnNumber: number;
  turnName: string;
  runoffStyle: RunoffStyle;
  kerbLeft: boolean;
  kerbRight: boolean;
  drsZone: boolean;
  racingLineOffset: number;
  optimalSpeedKmh: number; // Computed physics target speed at this point
  brakingZone: number; // 0 = throttle, 0.5 = lift/coast, 1 = heavy braking
  gripMultiplier?: number;
  yProf?: number[]; // 9-point lateral elevation profile across [-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12]m
}


export interface TurnMetadata {
  number: number;
  name: string;
  complexName: string;
  sector: 1 | 2 | 3;
  elevationM: number;
  bankingDeg: number;
  apexSpeedKmh: number;
  gear: number;
  description: string;
  sApprox: number; // Distance in meters from start/finish
}

export interface PeerTelemetrySummary {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  trackDistanceM: number;
  speedKmh: number;
  gapSeconds: number;
  isAiPeer: boolean;
}

export interface CarTelemetry {
  speedKmh: number;
  speedMs: number;
  rpm: number;
  gear: number; // -1 = R, 0 = N, 1..8
  throttle: number; // 0..1
  brake: number; // 0..1
  clutch: number; // 0..1 (1 = engaged, 0 = disengaged)
  steering: number; // -1..1 (positive = right)
  longitudinalG: number;
  lateralG: number;
  verticalG: number;
  // 2026 Aerodynamics & Rwanda Altitude
  altitudeM: number; // ~1385m + track elevation (up to 1435m)
  trackElevationM: number; // 0m to 50m
  airDensityKgM3: number; // ~1.04 kg/m^3 at 1400m
  activeAeroMode: ActiveAeroMode; // Z_MODE (High DF) or X_MODE (Low Drag)
  autoXMode: boolean;
  downforceN: number;
  downforceKgf: number;
  frontDownforceN: number;
  rearDownforceN: number;
  groundEffectFactor: number;
  dragN: number;
  // 2026 Power Unit (400kW ICE + 350kW MGU-K)
  icePowerKw: number;
  mgukPowerKw: number; // -350 (harvest) to +350 (deploy)
  totalPowerKw: number;
  ersBatteryPercent: number; // 0..100
  manualOverrideActive: boolean; // 2026 MOM 350kW boost
  boostRemainingS: number;
  turboBoostBar: number;
  fuelKg: number;
  // 4-Corner Tires, Suspension & Brakes (Ordered FL, FR, RL, RR for HUD display)
  tireSlipRatio: [number, number, number, number]; // FL, FR, RL, RR combined normalized slip (0..1.5)
  wheelSlipRatios: [number, number, number, number]; // FL, FR, RL, RR signed longitudinal slip ratio
  wheelSlipAnglesDeg: [number, number, number, number]; // FL, FR, RL, RR lateral slip angle (deg)
  wheelLoadsN: [number, number, number, number]; // FL, FR, RL, RR vertical contact load Fz (N)
  wheelRideHeightsMm: [number, number, number, number]; // FL, FR, RL, RR dynamic ride height (mm)
  suspensionTravelMm: [number, number, number, number]; // FL, FR, RL, RR suspension compression (mm)
  tireTempsC: [number, number, number, number]; // FL, FR, RL, RR (°C)
  tireWearPct: [number, number, number, number]; // FL, FR, RL, RR (0..100% wear)
  tireGripFactor: [number, number, number, number]; // FL, FR, RL, RR effective mu / nominal mu
  brakeTempsC: [number, number, number, number]; // FL, FR, RL, RR (°C)
  wheelSurfaces: [SurfaceType, SurfaceType, SurfaceType, SurfaceType]; // FL, FR, RL, RR
  frontSlipAngleDeg?: number;
  rearSlipAngleDeg?: number;
  ffbTorqueNorm?: number; // [-1..1] self-aligning torque + rack load
  ffbClipping?: boolean; // True when |ffbTorqueNorm| > 0.95
  onKerbLeft: boolean;
  onKerbRight: boolean;
  offTrack: boolean;
  surface: SurfaceType;
  // Track & Lap Timing
  trackDistanceM: number; // 0..5302
  trackProgress: number; // 0..1
  lateralOffsetM: number; // Distance from centerline (-width/2 to +width/2)
  gapToRacingLineM: number; // Signed offset from optimal racing line (m)
  headingErrorRad: number;
  targetCornerSpeedKmh: number;
  brakingUrgency: number; // 0..1 dynamic braking urgency for upcoming corner
  currentSector: 1 | 2 | 3;
  currentTurnNumber: number;
  currentTurnName: string;
  bankingDeg: number;
  slopePercent: number;
  lapCount: number;
  currentLapTimeMs: number;
  lastLapTimeMs: number | null;
  bestLapTimeMs: number | null;
  sectorTimesMs: [number, number, number];
  bestSectorTimesMs: [number | null, number | null, number | null];
  topSpeedThisLapKmh: number;
  allTimeTopSpeedKmh: number;
  aiAutopilot: boolean;
  peers?: PeerTelemetrySummary[];
}

export type TelemetryData = CarTelemetry;

/**
 * Track Occupancy Grid, Per-Wheel Surface Query & Dynamic Braking Line Evaluator
 *
 * Ported from `assetto_corsa_gym`:
 * - `AssettoCorsaEnv/track_occupancy_grid.py`: track boundary occupancy, inside/outside
 *   border queries, and 4-wheel surface classification (`asphalt`, `kerb`, `runoff`, `grass`).
 * - `AssettoCorsaEnv/reference_lap.py` & `ac_env.py`: `CURV_LOOK_AHEAD_DISTANCE = 300`,
 *   `CURV_LOOK_AHEAD_VECTOR_SIZE = 12` lookahead curvature & speed vectors, and
 *   full `AssettoCorsaGymObservation` state vector.
 */

import * as THREE from 'three';
import { SurfaceType, TrackSamplePoint } from '@/types/f1';
import { BuiltTrackData, catmullRomWeights, evaluateSampleLateralHeightM } from '@/lib/track-data';

export const CURV_LOOK_AHEAD_DISTANCE = 300; // meters (from assetto_corsa_gym ac_env.py)
export const CURV_LOOK_AHEAD_VECTOR_SIZE = 12; // 12 lookahead samples

/**
 * Full observation vector matching `assetto_corsa_gym` (`AssettoCorsaEnv/ac_env.py`)
 */
export interface AssettoCorsaGymObservation {
  speedMs: number;
  localVelocityX: number;
  localVelocityY: number;
  localVelocityZ: number;
  angularVelocityX: number;
  angularVelocityY: number;
  angularVelocityZ: number;
  accelX: number;
  accelY: number;
  rollRad: number;
  pitchRad: number;
  yawRad: number;
  engineRpm: number;
  gear: number;
  normalizedSplinePosition: number;
  /** Signed lateral distance from optimal racing line (m, `Gap` in ac_env.py) */
  gapToRacingLineM: number;
  /** Signed lateral distance from track centerline (m) */
  lateralOffsetCenterM: number;
  /** Heading error relative to racing line tangent (rad) */
  headingErrorRad: number;
  /** 4-wheel slip angles [FR, FL, RR, RL] (rad) */
  slipAngleRad: [number, number, number, number];
  /** 4-wheel slip ratios [FR, FL, RR, RL] */
  slipRatio: [number, number, number, number];
  /** 4-wheel vertical tire loads [FR, FL, RR, RL] (N) */
  tyreLoadN: [number, number, number, number];
  /** 4-wheel dynamic ride heights [FR, FL, RR, RL] (m) */
  rideHeightM: [number, number, number, number];
  /** 4-wheel tire core temperatures [FR, FL, RR, RL] (°C) */
  tyreTempC: [number, number, number, number];
  /** 12-point lookahead curvature vector over 300m (1/m) */
  lookaheadCurvatures: number[];
  /** 12-point lookahead optimal reference speed vector over 300m (m/s) */
  lookaheadTargetSpeedsMs: number[];
  /** Number of wheels currently outside the white track lines */
  wheelsOutOfTrack: number;
  /** True if all 4 wheels are outside track boundaries */
  outOfTrack: boolean;
}

export interface WheelGroundContact {
  zRoad: number;
  surfaceType: SurfaceType;
  frictionMult: number;
  bumpM: number;
  bankRad: number;
  pitchSlopeRad: number;
  lateralOffsetM: number;
  halfWidthM: number;
  isOutOfTrack: boolean;
}

/**
 * Queries the exact 3D road elevation, banking, longitudinal slope, and surface type
 * under a wheel at world coordinates `(worldX, worldZ)` (Three.js X, Z plane).
 */
export function queryWheelGroundContact(
  track: BuiltTrackData,
  worldX: number,
  worldZ: number,
  approxS: number,
  carSpeedMs: number
): WheelGroundContact {
  const stepM = track.totalLengthM / track.samples.length;

  // Continuous segment / lateral location (see BuiltTrackData.locateWorldPoint)
  const loc = track.locateWorldPoint(worldX, worldZ, approxS);
  const s0 = track.samples[loc.i0];
  const sNext = track.samples[loc.i1];
  const t = loc.t;

  // Signed lateral offset from track centerline (+right along horizontal binormal, -left)
  const lateralOffsetM = loc.lateralH;
  const absLat = Math.abs(lateralOffsetM);

  const halfWidthM = (s0.width + (sNext.width - s0.width) * t) * 0.5;
  const bankRad = s0.bankingRad + (sNext.bankingRad - s0.bankingRad) * t;
  const slopeSin = s0.slopeSin + (sNext.slopeSin - s0.slopeSin) * t;
  const pitchSlopeRad = Math.asin(THREE.MathUtils.clamp(slopeSin, -0.5, 0.5));

  // KN5 surface elevation at the wheel's lateral position from the 9-point cross-section
  // profiles, Catmull-Rom interpolated along the track (same as getSampleAtDistance)
  const n = track.samples.length;
  const [w0, w1, w2, w3] = catmullRomWeights(t);
  const zRoad =
    w0 * evaluateSampleLateralHeightM(track.samples[(loc.i0 - 1 + n) % n], lateralOffsetM) +
    w1 * evaluateSampleLateralHeightM(s0, lateralOffsetM) +
    w2 * evaluateSampleLateralHeightM(sNext, lateralOffsetM) +
    w3 * evaluateSampleLateralHeightM(track.samples[(loc.i1 + 1) % n], lateralOffsetM);

  // Classify surface under this specific wheel (asphalt, kerb, runoff, grass)
  const kerbInner = halfWidthM - 0.35;
  const kerbOuter = halfWidthM + 1.45;
  const runoffOuter = halfWidthM + 5.2;

  let surfaceType: SurfaceType = 'asphalt';
  let frictionMult = 1.0;
  let bumpM = 0;

  const sCoord = s0.s + t * stepM;
  if (absLat <= kerbInner) {
    surfaceType = 'asphalt';
    frictionMult = 1.0;
    bumpM = Math.sin(sCoord * 0.45) * 0.0004;
  } else if (
    absLat <= kerbOuter &&
    ((lateralOffsetM < 0 && s0.kerbLeft) || (lateralOffsetM > 0 && s0.kerbRight) || absLat <= halfWidthM + 0.65)
  ) {
    surfaceType = 'kerb';
    frictionMult = 0.89;
    // Serrated FIA kerb ridges every ~0.65m along s
    bumpM = Math.sin(sCoord * 9.6) * 0.008 * Math.min(1, carSpeedMs / 8);
  } else if (absLat <= runoffOuter) {
    surfaceType = 'runoff';
    frictionMult = 0.68;
    bumpM = Math.sin(sCoord * 3.2 + lateralOffsetM * 2.5) * 0.0038;
  } else {
    surfaceType = 'grass';
    frictionMult = 0.48;
    bumpM = Math.sin(sCoord * 4.8 + lateralOffsetM * 3.1) * 0.010;
  }

  return {
    zRoad,
    surfaceType,
    frictionMult,
    bumpM,
    bankRad,
    pitchSlopeRad,
    lateralOffsetM,
    halfWidthM,
    isOutOfTrack: absLat > kerbOuter,
  };
}

/**
 * Computes the 12-point lookahead curvature & optimal target speed vectors over 300m
 * exactly as in `assetto_corsa_gym` (`CURV_LOOK_AHEAD_DISTANCE = 300`, `CURV_LOOK_AHEAD_VECTOR_SIZE = 12`).
 */
export function computeLookaheadVectors(
  track: BuiltTrackData,
  currentS: number
): { lookaheadCurvatures: number[]; lookaheadTargetSpeedsMs: number[] } {
  const lookaheadCurvatures: number[] = [];
  const lookaheadTargetSpeedsMs: number[] = [];
  const stepDist = CURV_LOOK_AHEAD_DISTANCE / CURV_LOOK_AHEAD_VECTOR_SIZE; // 25m steps

  for (let i = 1; i <= CURV_LOOK_AHEAD_VECTOR_SIZE; i++) {
    const sampleS = (currentS + i * stepDist) % track.totalLengthM;
    const sp: TrackSamplePoint = track.getSampleAtDistance(sampleS);
    lookaheadCurvatures.push(sp.curvature);
    lookaheadTargetSpeedsMs.push(sp.optimalSpeedKmh / 3.6);
  }

  return { lookaheadCurvatures, lookaheadTargetSpeedsMs };
}

/**
 * Evaluates the dynamic braking urgency (`0.0` = full throttle green, `0.5` = caution/lift yellow,
 * `1.0` = heavy threshold braking red) for a racing line marker at track distance `markerS`
 * given the player's current speed `carSpeedMs` and position `carS`.
 *
 * A marker is red when it lies inside the distance the car needs to slow from its current speed
 * to the target speed of a slower point further along the line. Target speeds are the samples'
 * `optimalSpeedKmh`, i.e. the VF26 speed profile.
 */
export function evaluateDynamicBrakingUrgency(
  track: BuiltTrackData,
  carS: number,
  carSpeedMs: number,
  markerS: number,
  markerOptimalSpeedMs: number
): number {
  const totalLen = track.totalLengthM;
  const deltaS = (markerS - carS + totalLen) % totalLen;
  const markerSample = track.getSampleAtDistance(markerS);

  // Markers further ahead just show the static braking zones
  if (deltaS > 260) return THREE.MathUtils.clamp(markerSample.brakingZone, 0, 1);

  const tMargin = 0.04;
  let maxUrgency = 0;
  for (let distFromMarker = 5; distFromMarker <= 200; distFromMarker += 5) {
    const vTarget = track.getSampleAtDistance((markerS + distFromMarker) % totalLen).optimalSpeedKmh / 3.6;
    // Only slower points ahead of the marker (corner approach, not exit) that the car is too fast for
    if (vTarget >= markerOptimalSpeedMs - 0.5 || carSpeedMs <= vTarget + 1) continue;
    // Mean deceleration: ≈2.7 g at low speed up to ≈3.6 g with full downforce
    const vRmsSq = 0.5 * (carSpeedMs * carSpeedMs + vTarget * vTarget);
    const aEff = 26.5 + 8.5 * Math.min(1.2, vRmsSq / (88.0 * 88.0));
    const dBrake = (carSpeedMs * carSpeedMs - vTarget * vTarget) / (2.0 * aEff) + carSpeedMs * tMargin;
    if (distFromMarker <= dBrake) {
      maxUrgency = 1.0;
      break;
    }
    if (distFromMarker <= dBrake + 35.0) {
      maxUrgency = Math.max(maxUrgency, 0.35 + 0.6 * (1.0 - (distFromMarker - dBrake) / 35.0));
    }
  }

  // Keep markers inside a braking zone red while the car is still above the target speed there
  if (markerSample.brakingZone >= 0.5 && carSpeedMs >= markerOptimalSpeedMs - 2.5 && deltaS <= 125) {
    maxUrgency = 1.0;
  }

  return THREE.MathUtils.clamp(maxUrgency, 0, 1);
}

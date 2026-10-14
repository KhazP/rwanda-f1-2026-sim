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
import { BuiltTrackData, evaluateSampleLateralHeightM } from '@/lib/track-data';

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
  const totalLen = track.totalLengthM;
  const numSamples = track.samples.length;
  const stepM = totalLen / numSamples;
  const centerIdx =
    Math.floor((((approxS % totalLen) + totalLen) % totalLen) / stepM) % numSamples;

  let bestIdx = centerIdx;
  let bestDistSq = Infinity;
  const searchRadius = 24;

  for (let offset = -searchRadius; offset <= searchRadius; offset++) {
    const idx = (centerIdx + offset + numSamples) % numSamples;
    const sp = track.samples[idx];
    const dx = worldX - sp.position.x;
    const dz = worldZ - sp.position.z;
    const dSq = dx * dx + dz * dz;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = idx;
    }
  }

  const s0 = track.samples[bestIdx];
  const sNext = track.samples[(bestIdx + 1) % numSamples];
  const segX = sNext.position.x - s0.position.x;
  const segZ = sNext.position.z - s0.position.z;
  const segLenSq = Math.max(1e-4, segX * segX + segZ * segZ);
  const relX = worldX - s0.position.x;
  const relZ = worldZ - s0.position.z;
  const t = Math.max(0, Math.min(1, (relX * segX + relZ * segZ) / segLenSq));

  // Interpolated center point & horizontal binormal
  const cx = s0.position.x + segX * t;
  const cz = s0.position.z + segZ * t;

  const bx = s0.binormal.x + (sNext.binormal.x - s0.binormal.x) * t;
  const bz = s0.binormal.z + (sNext.binormal.z - s0.binormal.z) * t;
  const bLen = Math.hypot(bx, bz) || 1;

  // Signed lateral offset from track centerline (+right along horizontal binormal, -left)
  const lateralOffsetM = ((worldX - cx) * bx + (worldZ - cz) * bz) / bLen;
  const absLat = Math.abs(lateralOffsetM);

  const halfWidthM = (s0.width + (sNext.width - s0.width) * t) * 0.5;
  const bankRad = s0.bankingRad + (sNext.bankingRad - s0.bankingRad) * t;
  const slopeSin = s0.slopeSin + (sNext.slopeSin - s0.slopeSin) * t;
  const pitchSlopeRad = Math.asin(THREE.MathUtils.clamp(slopeSin, -0.5, 0.5));

  // Exact KN5 3D surface elevation at wheel lateral position interpolated from the 9-point cross-section profile
  const z0 = evaluateSampleLateralHeightM(s0, lateralOffsetM);
  const z1 = evaluateSampleLateralHeightM(sNext, lateralOffsetM);
  const zRoad = z0 + (z1 - z0) * t;

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

  // Evaluate dynamic braking urgency for markers within 260m ahead of the car
  if (deltaS <= 260) {
    const tMargin = 0.04;
    let maxUrgency = 0;

    // Look ahead from markerS up to 160m to see if markerS lies inside the physical braking zone
    // required to decelerate from carSpeedMs down to the instantaneous cornering grip speed vGrip at checkS
    for (let distFromMarker = 0; distFromMarker <= 160; distFromMarker += 6) {
      const checkS = (markerS + distFromMarker) % totalLen;
      const sp = track.getSampleAtDistance(checkS);
      const absK = Math.abs(sp.curvature);

      if (absK > 0.0055) {
        const bankBonus = Math.max(0, Math.tan(Math.abs(sp.bankingRad))) * 9.81;
        const hairpinFactor = THREE.MathUtils.clamp((absK - 0.020) / 0.012, 0, 1);
        const a0 = 17.8 - 2.4 * hairpinFactor + bankBonus * 1.25;
        const effK = Math.max(0.0022, absK - 0.0038 * (1.0 - 0.55 * hairpinFactor));
        const vGrip = THREE.MathUtils.clamp(Math.sqrt(a0 / effK), 18.5, 98.5);

        // Only trigger if checkS is stricter than the marker's local optimal speed (i.e. approaching/entering corner, not exiting)
        const isCornerApproach =
          distFromMarker === 0
            ? markerSample.brakingZone > 0.1
            : vGrip < markerOptimalSpeedMs - 0.5;

        if (isCornerApproach && carSpeedMs > vGrip + 1.0) {
          const vRmsSq = 0.5 * (carSpeedMs * carSpeedMs + vGrip * vGrip);
          const aEff = 26.5 + 8.5 * Math.min(1.2, vRmsSq / (88.0 * 88.0));
          const dBrake =
            (carSpeedMs * carSpeedMs - vGrip * vGrip) / (2.0 * aEff) +
            carSpeedMs * tMargin;

          if (distFromMarker <= dBrake) {
            maxUrgency = Math.max(maxUrgency, 1.0);
            break;
          } else if (distFromMarker <= dBrake + 35.0) {
            const blend = 1.0 - (distFromMarker - dBrake) / 35.0;
            maxUrgency = Math.max(maxUrgency, 0.35 + 0.6 * blend);
          }
        }
      }
    }

    // Also keep markers inside an active corner braking zone red while the car is threshold-braking along the optimal deceleration curve
    if (
      markerSample.brakingZone >= 0.5 &&
      carSpeedMs >= markerOptimalSpeedMs - 2.5 &&
      deltaS <= 125
    ) {
      maxUrgency = Math.max(maxUrgency, 1.0);
    }

    return THREE.MathUtils.clamp(maxUrgency, 0, 1);
  }

  return THREE.MathUtils.clamp(markerSample.brakingZone, 0, 1);
}

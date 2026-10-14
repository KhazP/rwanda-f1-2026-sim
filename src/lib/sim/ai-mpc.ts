/**
 * Single-Track Model Predictive Control (MPC) & Racing-Line AI Controller
 *
 * Ported from `assetto_corsa_gym` (`AssettoCorsaEnv`) and Speed Dreams `usr`/`simplix` AI:
 * - Uses the 12-point 300m lookahead curvature and optimal speed vectors (`AssettoCorsaGymObservation`)
 *   to solve a receding-horizon longitudinal braking & throttle profile.
 * - Uses a Single-Track lateral dynamics model (feedforward Ackermann curvature + heading error +
 *   cross-track Stanley error + yaw-rate damping + understeer/oversteer slip compensation)
 *   to steer smoothly along the minimum-curvature racing line.
 * - Modulates throttle based on rear-wheel combined slip ratio to prevent spinouts on exit.
 */

import * as THREE from 'three';
import { ActiveAeroMode, ERSMode } from '@/types/f1';
import { BuiltTrackData } from '@/lib/track-data';
import { AssettoCorsaGymObservation } from './track-occupancy';

export interface AiControlOutput {
  /** Normalized steering command (-1 right .. +1 left in TORCS convention) */
  steerCmd: number;
  /** Throttle pedal command (0..1) */
  throttleCmd: number;
  /** Brake pedal command (0..1) */
  brakeCmd: number;
  /** Requested active aero mode */
  aeroMode: ActiveAeroMode;
  /** Requested ERS mode */
  ersMode: ERSMode;
  /** Target reference speed at current track position (km/h) */
  targetSpeedKmh: number;
}

/**
 * Evaluates the Single-Track MPC / Racing-Line AI control law from the current
 * `AssettoCorsaGymObservation` vector.
 */
export function evaluateSingleTrackMpcAi(
  obs: AssettoCorsaGymObservation,
  track: BuiltTrackData,
  currentS: number,
  wheelbaseM = 3.4,
  maxSteerLockRad = 0.36
): AiControlOutput {
  const v = Math.max(0, obs.speedMs);
  const nearDist = Math.max(6.0, v * 0.18);
  const midDist = Math.max(13.0, v * 0.38);
  const sampleNow = track.getSampleAtDistance(currentS);
  const sampleNear = track.getSampleAtDistance(
    (currentS + nearDist) % track.totalLengthM
  );
  const sampleMid = track.getSampleAtDistance(
    (currentS + midDist) % track.totalLengthM
  );

  // 1. Lateral Single-Track MPC Control Law along exact 3D target racing line P_target(s)
  const rlScale = 0.25;
  const racelineNowM = sampleNow.racingLineOffset * sampleNow.width * rlScale;
  const racelineNearM = sampleNear.racingLineOffset * sampleNear.width * rlScale;
  const racelineMidM = sampleMid.racingLineOffset * sampleMid.width * rlScale;

  const ptNowX = sampleNow.position.x + sampleNow.binormal.x * racelineNowM;
  const ptNowZ = sampleNow.position.z + sampleNow.binormal.z * racelineNowM;
  const ptNearX = sampleNear.position.x + sampleNear.binormal.x * racelineNearM;
  const ptNearZ = sampleNear.position.z + sampleNear.binormal.z * racelineNearM;
  const ptMidX = sampleMid.position.x + sampleMid.binormal.x * racelineMidM;
  const ptMidZ = sampleMid.position.z + sampleMid.binormal.z * racelineMidM;

  const dx1 = ptNearX - ptNowX;
  const dz1 = ptNearZ - ptNowZ;
  const dx2 = ptMidX - ptNearX;
  const dz2 = ptMidZ - ptNearZ;

  const pathYaw1 = Math.atan2(dx1, dz1);
  const pathYaw2 = Math.atan2(dx2, dz2);

  // Exact heading error relative to the target racing line chord (+ means car nose points right of path)
  let headingErrRad = pathYaw1 - obs.yawRad;
  while (headingErrRad > Math.PI) headingErrRad -= Math.PI * 2;
  while (headingErrRad < -Math.PI) headingErrRad += Math.PI * 2;

  // Exact path curvature of the target racing line (+ means turning right)
  let dThetaPath = pathYaw1 - pathYaw2;
  while (dThetaPath > Math.PI) dThetaPath -= Math.PI * 2;
  while (dThetaPath < -Math.PI) dThetaPath += Math.PI * 2;
  const chordLen = Math.max(4.0, 0.5 * (Math.hypot(dx1, dz1) + Math.hypot(dx2, dz2)));
  const pathCurvature = dThetaPath / chordLen;

  // Cross-track error to target racing line (+ if car is to the right of target racing line)
  const crossTrackErrM = obs.lateralOffsetCenterM - racelineNowM;

  // Weighted preview curvature combining exact target path curvature and track curvature
  const previewCurvature =
    0.55 * pathCurvature +
    0.25 * sampleNow.curvature +
    0.20 * sampleNear.curvature;

  // Feedforward steering angle for single-track bicycle model including front tire slip angle demand
  const understeerFactor = 1.52 + 0.00025 * v * v;
  // Positive curvature turns right; in TORCS steerCmd > 0 is left
  const deltaFeedforward = -Math.atan(wheelbaseM * previewCurvature * understeerFactor);

  // Stanley cross-track feedback + heading proportional feedback + yaw rate damping
  const kCross = 2.45;
  const stanleyTerm = Math.atan2(kCross * crossTrackErrM, v + 6.0);
  const headingTerm = 1.65 * headingErrRad;
  const targetYawRate = -previewCurvature * v;
  const yawDampingTerm = -0.075 * (obs.angularVelocityZ - targetYawRate);

  const rawSteerRad = deltaFeedforward + stanleyTerm + headingTerm + yawDampingTerm;
  const steerCmd = THREE.MathUtils.clamp(rawSteerRad / maxSteerLockRad, -1.0, 1.0);

  // 2. Longitudinal Receding-Horizon Braking & Traction Control Law
  // Since optimalSpeedKmh already incorporates the backward-integrated braking speed ramp,
  // tracking sampleNow/sampleNear/sampleMid + 25m lookahead triggers braking right at the Red braking zone entry.
  const cornerWidePenalty =
    Math.abs(previewCurvature) > 0.009 && Math.abs(crossTrackErrM) > 1.2
      ? Math.max(0.84, 1.0 - (Math.abs(crossTrackErrM) - 1.2) * 0.055)
      : 1.0;
  const minTargetSpeedMs =
    Math.min(
      sampleNow.optimalSpeedKmh / 3.6,
      sampleNear.optimalSpeedKmh / 3.6
    ) * cornerWidePenalty;
  let maxRequiredDecelMs2 = 0;

  for (const [d, sp] of [
    [nearDist, sampleNear],
    [midDist, sampleMid],
    [25.0, track.getSampleAtDistance((currentS + 25.0) % track.totalLengthM)],
  ] as const) {
    const targetV = (sp.optimalSpeedKmh / 3.6) * cornerWidePenalty;
    if (v > targetV) {
      const reqDecel = (v * v - targetV * targetV) / (2.0 * Math.max(4.0, d));
      if (reqDecel > maxRequiredDecelMs2) {
        maxRequiredDecelMs2 = reqDecel;
      }
    }
  }

  const availableBrakeDecelMs2 = 26.5 + 8.5 * Math.min(1.2, (v / 88.0) ** 2);
  const decelRatio = maxRequiredDecelMs2 / availableBrakeDecelMs2;

  let throttleCmd = 0;
  let brakeCmd = 0;

  if (decelRatio > 0.72 || v > minTargetSpeedMs + 1.2) {
    const rawBrake = Math.max(
      (decelRatio - 0.55) * 2.1,
      (v - minTargetSpeedMs) / 7.5
    );
    const trailBrakeLimit = 1.0 - Math.min(0.24, Math.abs(steerCmd) * 0.28);
    brakeCmd = THREE.MathUtils.clamp(rawBrake * trailBrakeLimit, 0, 0.98);
    throttleCmd = 0;
  } else {
    const speedDeficit = minTargetSpeedMs - v;
    const rawThrottle = THREE.MathUtils.clamp(0.45 + speedDeficit * 0.18, 0.12, 1.0);

    const maxRearSlip = Math.max(
      Math.abs(obs.slipRatio[2]),
      Math.abs(obs.slipRatio[3]),
      Math.abs(obs.slipAngleRad[2]) * 1.4,
      Math.abs(obs.slipAngleRad[3]) * 1.4
    );
    const slipGuard =
      maxRearSlip > 0.095 ? Math.max(0.25, 1.0 - (maxRearSlip - 0.095) * 6.5) : 1.0;
    const cornerThrottleGuard = 1.0 - Math.min(0.46, Math.abs(steerCmd) * 0.52);

    throttleCmd = THREE.MathUtils.clamp(rawThrottle * slipGuard * cornerThrottleGuard, 0, 1.0);
    brakeCmd = 0;
  }

  const absCurv = Math.max(Math.abs(sampleNow.curvature), Math.abs(sampleNear.curvature));
  const aeroMode: ActiveAeroMode =
    absCurv < 0.0022 && brakeCmd < 0.05 && Math.abs(steerCmd) < 0.14 && v > 42
      ? 'X_MODE'
      : 'Z_MODE';

  const ersMode: ERSMode = aeroMode === 'X_MODE' && throttleCmd > 0.85 ? 'HOTLAP' : 'BALANCED';

  return {
    steerCmd,
    throttleCmd,
    brakeCmd,
    aeroMode,
    ersMode,
    targetSpeedKmh: Math.round(minTargetSpeedMs * 3.6),
  };
}

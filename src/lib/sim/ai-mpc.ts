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
  const sampleNow = track.getSampleAtDistance(currentS);
  const sampleNear = track.getSampleAtDistance(
    (currentS + Math.max(14, v * 0.32)) % track.totalLengthM
  );
  const sampleMid = track.getSampleAtDistance(
    (currentS + Math.max(28, v * 0.62)) % track.totalLengthM
  );

  // 1. Lateral Single-Track MPC Control Law
  const racelineNowM = sampleNow.racingLineOffset * sampleNow.width * 0.42;
  const racelineNearM = sampleNear.racingLineOffset * sampleNear.width * 0.42;
  const dRacelineShift = (racelineNearM - racelineNowM) / Math.max(8.0, v * 0.32);
  const racelinePathAngle = Math.atan(THREE.MathUtils.clamp(dRacelineShift, -0.35, 0.35));

  // Cross-track error to optimal racing line (positive if car is to the right of racing line)
  const crossTrackErrM = obs.gapToRacingLineM;
  // Heading error relative to racing line tangent
  const headingErrRad = obs.headingErrorRad + racelinePathAngle;

  // Weighted preview curvature from near/mid samples
  const previewCurvature =
    sampleNow.curvature * 0.25 +
    sampleNear.curvature * 0.50 +
    sampleMid.curvature * 0.25;

  // Feedforward steering angle for single-track bicycle model: delta_ff = atan(L * kappa * understeerGrad)
  const understeerFactor = 1.0 + 0.00018 * v * v;
  // In track-data.ts, positive curvature turns right; in TORCS steerCmd > 0 is left
  const deltaFeedforward = -Math.atan(wheelbaseM * previewCurvature * understeerFactor);

  // Stanley cross-track feedback + heading proportional feedback + yaw rate damping
  const kCross = 1.85;
  const stanleyTerm = Math.atan2(kCross * crossTrackErrM, v + 8.5);
  const headingTerm = 1.15 * headingErrRad;
  const targetYawRate = -previewCurvature * v;
  const yawDampingTerm = -0.095 * (obs.angularVelocityZ - targetYawRate);

  const rawSteerRad = deltaFeedforward + stanleyTerm + headingTerm + yawDampingTerm;
  const steerCmd = THREE.MathUtils.clamp(rawSteerRad / maxSteerLockRad, -1.0, 1.0);

  // 2. Longitudinal Receding-Horizon Braking & Traction Control Law
  let minTargetSpeedMs = sampleNow.optimalSpeedKmh / 3.6;
  let maxRequiredDecelMs2 = 0;
  const stepDist = 300 / Math.max(1, obs.lookaheadTargetSpeedsMs.length);

  for (let i = 0; i < obs.lookaheadTargetSpeedsMs.length; i++) {
    const distAhead = (i + 1) * stepDist;
    const targetV = obs.lookaheadTargetSpeedsMs[i];
    if (i < 3) {
      minTargetSpeedMs = Math.min(minTargetSpeedMs, targetV);
    }
    if (v > targetV) {
      const reqDecel = (v * v - targetV * targetV) / (2.0 * distAhead);
      if (reqDecel > maxRequiredDecelMs2) {
        maxRequiredDecelMs2 = reqDecel;
      }
    }
  }

  const availableBrakeDecelMs2 = 19.5 + 0.0032 * v * v;
  const decelRatio = maxRequiredDecelMs2 / availableBrakeDecelMs2;

  let throttleCmd = 0;
  let brakeCmd = 0;

  if (decelRatio > 0.52 || v > minTargetSpeedMs + 2.2) {
    const rawBrake = Math.max(
      (decelRatio - 0.45) * 1.65,
      (v - minTargetSpeedMs) / 14.0
    );
    const trailBrakeLimit = 1.0 - Math.min(0.55, Math.abs(steerCmd) * 0.65);
    brakeCmd = THREE.MathUtils.clamp(rawBrake * trailBrakeLimit, 0, 0.96);
    throttleCmd = 0;
  } else {
    const speedDeficit = minTargetSpeedMs - v;
    const rawThrottle = THREE.MathUtils.clamp(0.45 + speedDeficit * 0.16, 0.12, 1.0);

    const maxRearSlip = Math.max(
      Math.abs(obs.slipRatio[2]),
      Math.abs(obs.slipRatio[3]),
      Math.abs(obs.slipAngleRad[2]) * 1.4,
      Math.abs(obs.slipAngleRad[3]) * 1.4
    );
    const slipGuard =
      maxRearSlip > 0.095 ? Math.max(0.25, 1.0 - (maxRearSlip - 0.095) * 6.5) : 1.0;
    const cornerThrottleGuard = 1.0 - Math.min(0.42, Math.abs(steerCmd) * 0.48);

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

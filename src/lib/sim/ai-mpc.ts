/**
 * Racing-line AI driver.
 *
 * Longitudinal: tracks the car-aware target-speed profile (`speed-profile.ts`) with a
 * feedforward acceleration taken from the profile slope plus speed feedback, mapped to pedal
 * positions through the brake-force and drive-force capability of the car.
 *
 * Lateral: a kinematic path-following law turns lateral / course error to the AI line into a
 * yaw-rate reference (critically damped error dynamics), which a yaw-rate controller with a
 * slow integrator converts to a road-wheel angle. The vehicle model additionally limits the AI
 * road-wheel angle to the front tyres' peak slip angle, so the controller never asks for more
 * than the tyres can give.
 */

import * as THREE from 'three';
import { ActiveAeroMode, ERSMode } from '@/types/f1';
import { BuiltTrackData } from '@/lib/track-data';
import { AssettoCorsaGymObservation } from './track-occupancy';
import { sampleProfile, type SpeedProfile, type SpeedProfileCarModel } from './speed-profile';

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

export interface AiVehicleParams {
  wheelbaseM: number;
  maxSteerLockRad: number;
  /** Planning model the profile was built with */
  car: SpeedProfileCarModel;
  /** Brake force at full pedal (N) */
  fullBrakeForceN: number;
  /** Time for the active aero to return to Z-mode (s) */
  aeroTransitionS: number;
}

const G = 9.81;

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class RacingLineDriver {
  private yawRateInteg = 0;

  reset(): void {
    this.yawRateInteg = 0;
  }

  evaluate(
    obs: AssettoCorsaGymObservation,
    track: BuiltTrackData,
    currentS: number,
    profile: SpeedProfile,
    params: AiVehicleParams,
    dt: number
  ): AiControlOutput {
    const L = track.totalLengthM;
    const { car } = params;
    const v = Math.max(0, obs.speedMs);
    const vc = Math.max(6, v);
    const at = (arr: Float64Array, s: number) => sampleProfile(arr, s, L);

    // ---- Lateral ---------------------------------------------------------------
    // Errors relative to the AI line (+ = right of the line / moving to the right of it)
    const latErr = obs.lateralOffsetCenterM - at(profile.lineOffsetM, currentS);
    const hx = at(profile.pointX, currentS + 3) - at(profile.pointX, currentS - 3);
    const hz = at(profile.pointZ, currentS + 3) - at(profile.pointZ, currentS - 3);
    const pathYaw = Math.atan2(hx, hz);
    const courseYaw = obs.yawRad + Math.atan2(obs.localVelocityY, Math.max(1, obs.localVelocityX));
    const courseErr = wrapAngle(pathYaw - courseYaw);

    // Path curvature slightly ahead to cover the steering rack and tyre build-up lag (+ = right)
    const kappa = at(profile.curvature, currentS + Math.max(2, v * 0.12));

    // ë + 2ζω·ė + ω²·e = 0 with ė = v·sin(courseErr)  →  yaw-rate reference (+ = right)
    const omega = THREE.MathUtils.clamp(2.0 - v * 0.011, 1.0, 1.8);
    const zeta = 0.9;
    const eClamped = THREE.MathUtils.clamp(latErr, -3.5, 3.5);
    const courseClamped = THREE.MathUtils.clamp(courseErr, -0.35, 0.35);
    // Never ask for more yaw rate than the tyres can sustain at this speed
    const ayMax = car.muLat * (G + (car.downforceCoef * v * v) / car.massKg);
    const yawRateMax = (0.97 * ayMax) / vc;
    const yawRateRef = THREE.MathUtils.clamp(
      vc * kappa - 2 * zeta * omega * courseClamped - (omega * omega * eClamped) / vc,
      -yawRateMax,
      yawRateMax
    );

    const yawRate = -obs.angularVelocityZ; // + = right
    const yawErr = yawRateRef - yawRate;
    const lv = params.wheelbaseM / vc;
    this.yawRateInteg = THREE.MathUtils.clamp(this.yawRateInteg + 1.5 * lv * yawErr * dt, -0.05, 0.05);
    const steerRightRad = Math.atan(lv * yawRateRef) + 1.4 * lv * yawErr + this.yawRateInteg;
    const steerCmd = THREE.MathUtils.clamp(-steerRightRad / params.maxSteerLockRad, -1, 1);

    // ---- Longitudinal -------------------------------------------------------------
    const lead = Math.max(1, v * 0.18);
    const sRef = currentS + lead;
    // Wide of the line in a corner → the available radius is smaller than planned. Scale the
    // feedforward reference too, or the profile slope would read as an acceleration request.
    const wideScale =
      Math.abs(kappa) > 0.004 && Math.abs(latErr) > 1.5 ? Math.max(0.85, 1 - 0.03 * (Math.abs(latErr) - 1.5)) : 1;
    const vRef = at(profile.speedMs, sRef) * wideScale;
    const vAhead = at(profile.speedMs, sRef + 4) * wideScale;
    const aFeedforward = (vAhead * vAhead - vRef * vRef) / 8;
    const aCmd = aFeedforward + 2.2 * (vRef - v);

    const dragAcc = (car.dragCoef * v * v) / car.massKg;
    let throttleCmd = 0;
    let brakeCmd = 0;
    if (aCmd < -dragAcc - 0.5) {
      brakeCmd = THREE.MathUtils.clamp((car.massKg * (-aCmd) - car.dragCoef * v * v) / params.fullBrakeForceN, 0, 1);
    } else if (aCmd > -dragAcc * 0.5) {
      const traction =
        car.muLong * (car.rearWeightFraction * G + (car.rearDownforceShare * car.downforceCoef * v * v) / car.massKg);
      const drive = Math.min(traction, car.maxDrivePowerW / (car.massKg * Math.max(5, v)));
      // Friction circle at the current cornering load: only the remaining grip may drive the car
      const latUse = Math.min(1, Math.abs(v * yawRate) / ayMax);
      const aLongMax = traction * Math.sqrt(Math.max(0, 1 - latUse * latUse)) + 0.15 * traction;
      throttleCmd = THREE.MathUtils.clamp((Math.min(aCmd, aLongMax) + dragAcc) / drive, 0, 1);
      // Rear axle near its slip-angle peak → feed the power in gently
      const rearSlip = Math.max(Math.abs(obs.slipAngleRad[2]), Math.abs(obs.slipAngleRad[3]));
      if (rearSlip > 0.09) throttleCmd *= Math.max(0.3, 1 - (rearSlip - 0.09) * 8);
    }

    // ---- Active aero & ERS ------------------------------------------------------
    // X-mode only where allowed and while no braking is needed before the wing is closed again
    const sample = track.getSampleAtDistance(currentS);
    const closeDist = v * params.aeroTransitionS + 40;
    const brakingAhead = at(profile.speedMs, currentS + closeDist) < v - 1.5;
    const aeroMode: ActiveAeroMode =
      sample.drsZone && !brakingAhead && brakeCmd === 0 && Math.abs(kappa) < 0.0025 && Math.abs(steerCmd) < 0.12 && v > 42
        ? 'X_MODE'
        : 'Z_MODE';
    const ersMode: ERSMode = aeroMode === 'X_MODE' && throttleCmd > 0.85 ? 'HOTLAP' : 'BALANCED';

    return {
      steerCmd,
      throttleCmd,
      brakeCmd,
      aeroMode,
      ersMode,
      targetSpeedKmh: Math.round(vRef * 3.6),
    };
  }
}

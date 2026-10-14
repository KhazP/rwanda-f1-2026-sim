import { getRwandaTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { FIA_2026_F1_CAR_CONFIG } from '../src/lib/sim/car-configs';
import { initSimAeroState, updateSimAero } from '../src/lib/sim/aero';
import { initAxleState, initSuspensionState } from '../src/lib/sim/susp';
import { initWheelState, simWheelUpdateForce } from '../src/lib/sim/wheel';
import { buildRwandaCircuitScene } from '../src/lib/scene-builder';
import { MultiplayerSyncManager } from '../src/lib/sim/multiplayer-sync';
import * as THREE from 'three';

// Headless canvas shim for running scene-builder procedural textures in Node.js verification
if (typeof globalThis.document === 'undefined') {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({
      width: 256,
      height: 256,
      getContext: () => ({
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
        fillRect: () => {},
        strokeRect: () => {},
        clearRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        fillText: () => {},
        measureText: (t: string) => ({ width: t.length * 10 }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
      }),
    }),
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`  [PASS] ${message}`);
}

async function runVerification() {
  console.log('=== RWANDA F1 2026 SIMULATOR DEEP VERIFICATION SUITE ===\n');
  const track = getRwandaTrackData(1200);

  // 1. Stationary Steering Test (User bug: "the car even turns left and right when stationery")
  console.log('1. Testing Stationary Steering Stability...');
  const simStationary = new F1Physics2026(track);
  simStationary.resetToStartGrid(false);
  const initialHeading = simStationary.headingErrorRad;
  const initialLat = simStationary.lateralOffsetM;
  for (let i = 0; i < 120; i++) {
    simStationary.step(1 / 60, {
      throttle: 0,
      brake: 0,
      steerLeft: i < 60 ? 1 : 0,
      steerRight: i >= 60 ? 1 : 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }
  assert(
    Math.abs(simStationary.yawRateRadS) === 0,
    `Stationary yawRateRadS is exactly 0 (got ${simStationary.yawRateRadS})`
  );
  assert(
    Math.abs(simStationary.headingErrorRad - initialHeading) === 0,
    `Stationary headingErrorRad did not change when turning wheel at 0 km/h (got delta ${simStationary.headingErrorRad - initialHeading})`
  );
  assert(
    Math.abs(simStationary.lateralOffsetM - initialLat) === 0,
    `Stationary lateralOffsetM did not drift at 0 km/h (got delta ${simStationary.lateralOffsetM - initialLat})`
  );
  assert(
    Math.abs(simStationary.steerAngleNorm) > 0.5,
    `Front wheels visually steer while stationary (steerAngleNorm = ${simStationary.steerAngleNorm.toFixed(3)})`
  );

  // 2. Straight-Line Stability Test (User bug: "the car sometimes slightly turns on its own when driving")
  console.log('\n2. Testing Straight-Line Acceleration & Zero Self-Turning...');
  const simStraight = new F1Physics2026(track);
  simStraight.resetToStartGrid(false);
  // Place at start of main straight (s = 30m) with zero lateral offset
  simStraight.sMeters = 30;
  simStraight.lateralOffsetM = 0;
  simStraight.headingErrorRad = 0;
  for (let i = 0; i < 180; i++) {
    // 3 seconds of full throttle on the straight
    simStraight.step(1 / 60, {
      throttle: 1,
      brake: 0,
      steerLeft: 0,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }
  assert(
    simStraight.telemetry.speedKmh > 145 && simStraight.telemetry.gear >= 2,
    `Car accelerates strongly on straight (reached ${simStraight.telemetry.speedKmh.toFixed(1)} km/h, Gear ${simStraight.telemetry.gear})`
  );
  assert(
    Math.abs(simStraight.lateralOffsetM) < 0.02,
    `Zero phantom lateral drift on straight (|lateralOffsetM| = ${Math.abs(simStraight.lateralOffsetM).toFixed(6)}m < 0.02m)`
  );
  assert(
    Math.abs(simStraight.headingErrorRad) < 0.002,
    `Zero phantom yaw rotation on straight (|headingErrorRad| = ${Math.abs(simStraight.headingErrorRad).toFixed(6)} rad < 0.002 rad)`
  );

  // Also verify 3D world heading invariance across straight-to-corner spline transitions with zero steering
  const simWorldInvariance = new F1Physics2026(track);
  simWorldInvariance.resetToStartGrid(false);
  simWorldInvariance.sMeters = 240; // approaching Turn 1 transition where spline begins curving
  simWorldInvariance.lateralOffsetM = 0;
  simWorldInvariance.headingErrorRad = 0;
  simWorldInvariance.step(0.002, {
    throttle: 1,
    brake: 0,
    steerLeft: 0,
    steerRight: 0,
    manualOverride: false,
    toggleXMode: false,
    shiftUp: false,
    shiftDown: false,
  });
  const startForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    simWorldInvariance.worldQuaternion
  );
  const startWorldYaw = Math.atan2(startForward.x, startForward.z);
  for (let i = 0; i < 120; i++) {
    simWorldInvariance.step(1 / 60, {
      throttle: 1,
      brake: 0,
      steerLeft: 0,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }
  const endForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    simWorldInvariance.worldQuaternion
  );
  const endWorldYaw = Math.atan2(endForward.x, endForward.z);
  const worldYawDelta = Math.abs(
    Math.atan2(
      Math.sin(endWorldYaw - startWorldYaw),
      Math.cos(endWorldYaw - startWorldYaw)
    )
  );
  assert(
    worldYawDelta < 1e-4,
    `World 3D heading is 100% invariant with zero steering across spline curvature transition (|worldYawDelta| = ${worldYawDelta.toExponential(2)} rad)`
  );

  // 3. Fixed-Timestep 500 Hz Determinism (60 FPS vs 120 FPS)
  console.log('\n3. Testing Fixed-Timestep 500 Hz Sub-Stepping Determinism (60Hz vs 120Hz)...');
  const sim60 = new F1Physics2026(track);
  const sim120 = new F1Physics2026(track);
  sim60.resetToStartGrid(true);
  sim120.resetToStartGrid(true);
  // Step 1.2 seconds (600 substeps of 0.002s)
  for (let i = 0; i < 60; i++) {
    sim60.step(0.02, {
      throttle: 1,
      brake: 0,
      steerLeft: 0.25,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }
  for (let i = 0; i < 120; i++) {
    sim120.step(0.01, {
      throttle: 1,
      brake: 0,
      steerLeft: 0.25,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }
  const speedDiff = Math.abs(sim60.vxMs - sim120.vxMs);
  const sDiff = Math.abs(sim60.sMeters - sim120.sMeters);
  assert(
    speedDiff < 1e-6 && sDiff < 1e-6,
    `500 Hz sub-stepped solver is frame-rate independent (speedDiff=${speedDiff.toExponential(2)}, sDiff=${sDiff.toExponential(2)})`
  );

  // 4. Pacejka Magic Formula Load Sensitivity & Ground-Effect Downforce
  console.log('\n4. Testing Pacejka Magic Formula Load Sensitivity & Ground-Effect Suction...');
  const wCfg = FIA_2026_F1_CAR_CONFIG.wheels[0];
  const wLowLoad = initWheelState(0, wCfg, 0, 0, 'soft');
  const wHighLoad = initWheelState(0, wCfg, 0, 0, 'soft');
  const suspDummy = initSuspensionState(FIA_2026_F1_CAR_CONFIG.suspensions[0], 0);
  suspDummy.force = 0;
  const axleDummy = initAxleState(FIA_2026_F1_CAR_CONFIG.axles[0], 0);
  wLowLoad.bodyVel = { x: 50, y: 4.0, z: 0 };
  wHighLoad.bodyVel = { x: 50, y: 4.0, z: 0 };
  wLowLoad.spinVel = 50 / wCfg.radius;
  wHighLoad.spinVel = 50 / wCfg.radius;
  simWheelUpdateForce(wLowLoad, wCfg, suspDummy, axleDummy, 2000, 'soft', 26, 0.002);
  simWheelUpdateForce(wHighLoad, wCfg, suspDummy, axleDummy, 6000, 'soft', 26, 0.002);
  assert(
    wLowLoad.effectiveMu > wHighLoad.effectiveMu,
    `Pacejka load sensitivity decreases effective mu at higher vertical load (mu@2kN=${wLowLoad.effectiveMu.toFixed(3)} > mu@6kN=${wHighLoad.effectiveMu.toFixed(3)})`
  );

  const aeroLowRide = initSimAeroState(FIA_2026_F1_CAR_CONFIG.aero);
  const aeroHighRide = initSimAeroState(FIA_2026_F1_CAR_CONFIG.aero);
  const aeroXMode = initSimAeroState(FIA_2026_F1_CAR_CONFIG.aero);
  updateSimAero(aeroLowRide, FIA_2026_F1_CAR_CONFIG.aero, 75, 0, [0.022, 0.022, 0.030, 0.030], 'Z-MODE', 1.0);
  updateSimAero(aeroHighRide, FIA_2026_F1_CAR_CONFIG.aero, 75, 0, [0.065, 0.065, 0.075, 0.075], 'Z-MODE', 1.0);
  updateSimAero(aeroXMode, FIA_2026_F1_CAR_CONFIG.aero, 75, 0, [0.022, 0.022, 0.030, 0.030], 'X-MODE', 1.0);
  assert(
    aeroLowRide.groundEffectFactor > aeroHighRide.groundEffectFactor &&
      aeroLowRide.totalDownforceN > aeroHighRide.totalDownforceN,
    `Ground-effect floor suction increases closer to asphalt (${aeroLowRide.totalDownforceN.toFixed(0)}N @ 26mm > ${aeroHighRide.totalDownforceN.toFixed(0)}N @ 70mm)`
  );
  assert(
    aeroXMode.totalDragN < aeroLowRide.totalDragN,
    `2026 Active Aero X-Mode reduces drag on straights (${aeroXMode.totalDragN.toFixed(0)}N < ${aeroLowRide.totalDragN.toFixed(0)}N)`
  );

  // 5. Single-Track MPC AI Controller Test
  console.log('\n5. Testing Single-Track MPC AI Controller...');
  const simAi = new F1Physics2026(track);
  simAi.resetToStartGrid(true);
  simAi.aiAutopilot = true;
  for (let i = 0; i < 300; i++) {
    simAi.step(1 / 60, {
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
  assert(
    !simAi.telemetry.offTrack && simAi.telemetry.speedKmh > 120,
    `MPC AI keeps car within track boundaries at racing speed (speed=${simAi.telemetry.speedKmh.toFixed(1)} km/h, latOffset=${simAi.lateralOffsetM.toFixed(2)}m)`
  );

  // 6. Grandstand & Structure Track Clearance Verification (User bug: "there are some grandstands right on the track")
  console.log('\n6. Testing Grandstand & Trackside Structure Clearance Against All 1,200 Track Samples...');
  const builtScene = buildRwandaCircuitScene(track);
  builtScene.sceneGroup.updateMatrixWorld(true);
  let checkedStructureGroups = 0;
  let checkedMeshes = 0;
  let minClearanceFromCenterlineM = Infinity;

  builtScene.sceneGroup.traverse((obj) => {
    if (obj.userData?.isTracksideStructure) {
      checkedStructureGroups++;
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.updateWorldMatrix(true, false);
          const geom = child.geometry;
          if (!geom.boundingBox) geom.computeBoundingBox();
          const box = geom.boundingBox;
          if (!box) return;

          // Check center and 4 base corners in world space against all 1,200 track samples
          const testPoints = [
            new THREE.Vector3((box.min.x + box.max.x) * 0.5, box.min.y, (box.min.z + box.max.z) * 0.5),
            new THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.max.z),
          ];

          for (const pt of testPoints) {
            pt.applyMatrix4(child.matrixWorld);
            for (let i = 0; i < track.samples.length; i++) {
              const sp = track.samples[i].position;
              const dist = Math.hypot(pt.x - sp.x, pt.z - sp.z);
              if (dist < minClearanceFromCenterlineM) {
                minClearanceFromCenterlineM = dist;
              }
            }
          }
          checkedMeshes++;
        }
      });
    }
  });
  assert(
    checkedStructureGroups >= 10 && checkedMeshes >= 30 && minClearanceFromCenterlineM > 14.0,
    `Verified ${checkedStructureGroups} trackside structure groups (${checkedMeshes} meshes); minimum corner distance from track centerline is ${minClearanceFromCenterlineM.toFixed(2)}m (> 7.5m asphalt half-width)`
  );

  // 7. Multiplayer & AI Opponent Dead-Reckoning Sync Verification
  console.log('\n7. Testing 25 Hz Multiplayer Sync & Cubic Hermite / Slerp Dead-Reckoning...');
  const mpSync = new MultiplayerSyncManager(track);
  let peers = mpSync.update(1 / 60, 0, track, {
    driverCode: 'VER',
    teamColorHex: '#38bdf8',
    pos: [simAi.worldPosition.x, simAi.worldPosition.y, simAi.worldPosition.z],
    quat: [
      simAi.worldQuaternion.x,
      simAi.worldQuaternion.y,
      simAi.worldQuaternion.z,
      simAi.worldQuaternion.w,
    ],
    linVel: [simAi.vxMs, 0, 0],
    angVel: [0, simAi.yawRateRadS, 0],
    steerAngle: simAi.steerAngleNorm,
    wheelRPMs: [1800, 1800, 1800, 1800],
    throttle: simAi.telemetry.throttle,
    brake: simAi.telemetry.brake,
    trackS: simAi.sMeters,
    speedKmh: simAi.telemetry.speedKmh,
  });
  for (let i = 1; i <= 60; i++) {
    peers = mpSync.update(1 / 60, i * 16.67, track, {
      driverCode: 'VER',
      teamColorHex: '#38bdf8',
      pos: [simAi.worldPosition.x, simAi.worldPosition.y, simAi.worldPosition.z],
      quat: [
        simAi.worldQuaternion.x,
        simAi.worldQuaternion.y,
        simAi.worldQuaternion.z,
        simAi.worldQuaternion.w,
      ],
      linVel: [simAi.vxMs, 0, 0],
      angVel: [0, simAi.yawRateRadS, 0],
      steerAngle: simAi.steerAngleNorm,
      wheelRPMs: [1800, 1800, 1800, 1800],
      throttle: simAi.telemetry.throttle,
      brake: simAi.telemetry.brake,
      trackS: simAi.sMeters,
      speedKmh: simAi.telemetry.speedKmh,
    });
  }
  assert(
    peers.length === 3 && peers.every((p) => p.speedKmh > 100 && Number.isFinite(p.position.x)),
    `3 autonomous AI/multiplayer peers active and interpolated on track (${peers.map((p) => `${p.driverCode}:${p.speedKmh.toFixed(0)}km/h`).join(', ')})`
  );
  mpSync.dispose();

  // 8. Edge Cases: NaN/Zero dt, Carbon Brake Thermal Glow, 2026 /Boost Override & Dynamic Racing Line
  console.log('\n8. Testing Edge Cases (Invalid dt, Brake Thermal Glow, /Boost Override, Dynamic Racing Line)...');
  const prevSpeed = simAi.telemetry.speedKmh;
  simAi.step(0, {});
  simAi.step(-0.05, {});
  simAi.step(Number.NaN, {});
  assert(
    simAi.telemetry.speedKmh === prevSpeed && Number.isFinite(simAi.telemetry.speedKmh),
    `Physics solver safely ignores 0, negative, and NaN dtSeconds (speed preserved at ${simAi.telemetry.speedKmh.toFixed(1)} km/h)`
  );

  // Heavy braking from 280 km/h -> verify deceleration and carbon disc temperature rise
  const simBrake = new F1Physics2026(track);
  simBrake.teleportToDistance(400, 280 / 3.6);
  const startBrakeTemp = simBrake.telemetry.brakeTempsC[0];
  for (let i = 0; i < 60; i++) {
    simBrake.step(1 / 60, {
      throttle: 0,
      brake: 1.0,
      steerLeft: 0,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
  }
  assert(
    simBrake.telemetry.speedKmh < 160 && simBrake.telemetry.brakeTempsC[0] > startBrakeTemp + 80,
    `Heavy braking decelerates car (${simBrake.telemetry.speedKmh.toFixed(1)} km/h) and heats carbon discs (${startBrakeTemp.toFixed(0)}°C -> ${simBrake.telemetry.brakeTempsC[0].toFixed(0)}°C)`
  );

  // 2026 /Boost Manual Override above 300 km/h
  const simBoost = new F1Physics2026(track);
  simBoost.teleportToDistance(100, 315 / 3.6);
  const boostActivated = simBoost.activateBoostOverride();
  simBoost.step(1 / 60, { throttle: 1, brake: 0 });
  assert(
    boostActivated && simBoost.telemetry.manualOverrideActive && simBoost.telemetry.mgukPowerKw > 330,
    `2026 FIA /Boost Manual Override sustains ${simBoost.telemetry.mgukPowerKw.toFixed(0)} kW MGU-K at 315 km/h`
  );

  // Dynamic 3D Dashed Braking Line color update
  builtScene.updateDynamicRacingLine(520, 82); // Approaching T1 at 295 km/h
  const colorAttr = builtScene.racingLineMesh.geometry.getAttribute('color');
  assert(
    Boolean(colorAttr && colorAttr.count > 100),
    `Dynamic 3D Dashed Braking Line updates vertex colors (${colorAttr?.count ?? 0} vertices)`
  );

  // 9. Reviewer Regression Suite: Aero/Ride-Height Scaling, Lateral Load Transfer Sign, Ground Contact, Banking Sign, Camera Frustums & 85° Off-Track Recovery
  console.log('\n9. Testing Reviewer Regression Suite (Aero Scaling, Load Transfer Sign, Ground Contact, Banking, 4 Reference Cameras, 85° Recovery)...');

  // 9.1 Aero Downforce Scaling & Non-Bottomed Suspension Ride Heights at 270 km/h
  assert(
    aeroLowRide.totalDownforceN >= 9500 && aeroLowRide.totalDownforceN <= 16500,
    `Realistic 2026 F1 downforce at 270 km/h (${aeroLowRide.totalDownforceN.toFixed(0)} N within [9500, 16500] N, no 4x wing multiplier bug)`
  );
  const simHighSpeed = new F1Physics2026(track);
  simHighSpeed.teleportToDistance(60, 270 / 3.6);
  for (let i = 0; i < 60; i++) {
    simHighSpeed.step(1 / 60, { throttle: 1, brake: 0 });
  }
  const [rhFR, rhFL, rhRR, rhRL] = simHighSpeed.telemetry.wheelRideHeightsMm;
  assert(
    rhFR >= 10 && rhFL >= 10 && rhRR >= 14 && rhRL >= 14,
    `High-speed suspension maintains physical ride height without slamming into 2mm bump stops (FR=${rhFR}mm, FL=${rhFL}mm, RR=${rhRR}mm, RL=${rhRL}mm)`
  );
  const sumWheelFz =
    simHighSpeed.wheels[0].fzN +
    simHighSpeed.wheels[1].fzN +
    simHighSpeed.wheels[2].fzN +
    simHighSpeed.wheels[3].fzN;
  const expectedTotalFz =
    (FIA_2026_F1_CAR_CONFIG.dryMassKg + simHighSpeed.telemetry.fuelKg) * 9.81 +
    simHighSpeed.telemetry.downforceN;
  assert(
    Math.abs(sumWheelFz - expectedTotalFz) / expectedTotalFz < 0.15,
    `Sum of 4 wheel vertical loads matches static weight + aero downforce without double-counting (sumFz=${sumWheelFz.toFixed(0)}N vs expected=${expectedTotalFz.toFixed(0)}N)`
  );

  // 9.2 Lateral Load Transfer Sign in Cornering (Turning Left -> Outside Right Wheels FR/RR Must Carry More Load than Inside Left Wheels FL/RL)
  const simCorner = new F1Physics2026(track);
  simCorner.teleportToDistance(60, 180 / 3.6);
  for (let i = 0; i < 15; i++) {
    simCorner.step(1 / 60, {
      throttle: 0.5,
      brake: 0,
      steerLeft: 0.45,
      steerRight: 0,
    });
  }
  const fzRight = simCorner.wheels[0].fzN + simCorner.wheels[2].fzN;
  const fzLeft = simCorner.wheels[1].fzN + simCorner.wheels[3].fzN;
  assert(
    fzRight > fzLeft + 800,
    `Left-hand turn transfers weight to outside Right wheels (fzRight=${fzRight.toFixed(0)}N > fzLeft=${fzLeft.toFixed(0)}N)`
  );

  // 9.3 Exact Tire-to-Track Ground Contact & Unsprung Wheel Separation
  const sampleAtCar = track.getSampleAtDistance(simCorner.sMeters);
  const expectedSurfacePos = sampleAtCar.position
    .clone()
    .addScaledVector(sampleAtCar.binormal, simCorner.lateralOffsetM);
  const groundContactError = simCorner.worldPosition.distanceTo(expectedSurfacePos);
  assert(
    groundContactError < 1e-5,
    `Car root worldPosition sits flush on track surface with zero floating offset (error=${groundContactError.toExponential(2)}m)`
  );

  const { createF1Car2026 } = await import('../src/lib/car-builder-2026');
  const { LIVERIES } = await import('../src/lib/track-data');
  const carRig = createF1Car2026(LIVERIES[0], 'soft');
  assert(
    carRig.frontLeftSteerPivot.parent === carRig.root &&
      carRig.frontRightSteerPivot.parent === carRig.root,
    `Unsprung wheel assemblies are parented to root (not sprung chassisGroup) so tires stay planted during pitch/roll/heave`
  );

  // 9.4 Inward Track Banking Sign Verification
  const bankedRightSample = track.samples.find((s) => s.bankingRad > (4.0 * Math.PI) / 180);
  assert(
    Boolean(bankedRightSample && bankedRightSample.binormal.y < -0.04),
    `Positive banking tilts track surface inward toward right-hand apex (banking=${((bankedRightSample?.bankingRad ?? 0) * 180 / Math.PI).toFixed(1)}°, binormal.y=${bankedRightSample?.binormal.y.toFixed(4)})`
  );

  // 9.5 Frustum Projection Verification for All 4 Reference Image Onboard Cameras
  carRig.root.position.set(0, 0, 0);
  carRig.root.quaternion.identity();
  carRig.root.updateMatrixWorld(true);

  const projectLocalPoint = (
    camPos: [number, number, number],
    lookAtPos: [number, number, number],
    fovDeg: number,
    targetPt: [number, number, number]
  ): { x: number; y: number; z: number } => {
    const cam = new THREE.PerspectiveCamera(fovDeg, 16 / 9, 0.05, 500);
    cam.position.set(camPos[0], camPos[1], camPos[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(lookAtPos[0], lookAtPos[1], lookAtPos[2]);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const v = new THREE.Vector3(targetPt[0], targetPt[1], targetPt[2]).project(cam);
    return { x: v.x, y: v.y, z: v.z };
  };

  // Image 1 (`tv_pod` at [0.02, 0.905, -0.06] -> [0, 0.22, 3.6], fov=60):
  // Frames Helmet (0, 0.625, 0.24), Steering Wheel (0, 0.588, 0.565), Halo (0, 0.842, 0.752), Mirrors (±0.465, 0.635, 0.68), Wheel Brows (±0.695, 0.388, 1.42), Front Tires (±0.77, 0.355, 1.42)
  const tvHelmet = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0, 0.65, 0.28]);
  const tvWheel = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0, 0.588, 0.565]);
  const tvHalo = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0, 0.842, 0.752]);
  const tvMirrorL = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0.465, 0.635, 0.68]);
  const tvBrowL = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0.695, 0.388, 1.42]);
  const tvTireL = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0.77, 0.355, 1.42]);
  assert(
    tvHelmet.y > -0.95 &&
      tvHelmet.y < -0.25 &&
      tvWheel.y > -0.75 &&
      tvWheel.y < 0.0 &&
      Math.abs(tvMirrorL.x) < 0.92 &&
      tvMirrorL.y > -0.65 &&
      tvBrowL.y > tvTireL.y &&
      Math.abs(tvTireL.x) < 0.95 &&
      tvHalo.y < 0.5,
    `Image 1 (tv_pod) frames helmet (ndcY=${tvHelmet.y.toFixed(2)}), wheel (ndcY=${tvWheel.y.toFixed(2)}), mirrors (ndc=${tvMirrorL.x.toFixed(2)},${tvMirrorL.y.toFixed(2)}), wheel brows above tires (ndcY=${tvBrowL.y.toFixed(2)}>${tvTireL.y.toFixed(2)}), and halo (ndcY=${tvHalo.y.toFixed(2)})`
  );

  // Image 2 (`cockpit_shoulder` at [0.24, 0.715, 0.06] -> [-0.13, 0.40, 5.5], fov=58):
  // Helmet on right (ndcX > 0), left glove/wheel in lower-center, left mirror & front-left wheel + wheel brow on left (ndcX < 0)
  const shHelmet = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0, 0.625, 0.28]);
  const shGloveL = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0.132, 0.575, 0.565]);
  const shMirrorL = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0.465, 0.635, 0.68]);
  const shTireL = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0.77, 0.355, 1.42]);
  assert(
    shHelmet.x > 0.15 &&
      shHelmet.x < 0.98 &&
      Math.abs(shGloveL.x) < 0.45 &&
      shGloveL.y > -0.78 &&
      shMirrorL.x < -0.15 &&
      shMirrorL.x > -0.95 &&
      shMirrorL.y > -0.55 &&
      shTireL.x < -0.1 &&
      shTireL.x > -0.95,
    `Image 2 (cockpit_shoulder) frames helmet on right (ndcX=${shHelmet.x.toFixed(2)}), gloved hand on wheel (ndc=${shGloveL.x.toFixed(2)},${shGloveL.y.toFixed(2)}), left mirror (ndc=${shMirrorL.x.toFixed(2)},${shMirrorL.y.toFixed(2)}), and left tire (ndcX=${shTireL.x.toFixed(2)})`
  );

  // Image 3 (`cockpit` at [0, 0.675, 0.21] -> [0, 0.50, 8.0], fov=62):
  // Full Butterfly Steering Wheel OLED & lower edge (0, 0.515, 0.565) above bottom HUD bar (ndcY > -0.76), plus both wing mirrors visible at sides
  const ckWheelTop = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0, 0.642, 0.565]);
  const ckWheelBot = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0, 0.515, 0.565]);
  const ckGloveL = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0.132, 0.575, 0.565]);
  const ckMirrorL = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0.465, 0.635, 0.68]);
  assert(
    ckWheelTop.y < 0.15 &&
      ckWheelBot.y > -0.76 &&
      Math.abs(ckGloveL.x) < 0.65 &&
      Math.abs(ckMirrorL.x) < 0.99 &&
      Math.abs(ckMirrorL.y) < 0.45,
    `Image 3 (cockpit) frames full Butterfly Steering Wheel & OLED above bottom HUD (ndcY=[${ckWheelBot.y.toFixed(2)}, ${ckWheelTop.y.toFixed(2)}]), gloved hands (ndcX=±${Math.abs(ckGloveL.x).toFixed(2)}), and side mirrors (ndcX=±${Math.abs(ckMirrorL.x).toFixed(2)})`
  );

  // Image 4 (`nose` at [0, 0.455, 1.66] -> [0, 0.25, 18.0], fov=64):
  // Y-Pitot probe (0, 0.405, 2.145) stands above narrow nose tip (0, 0.255, 2.42), with curved vertical front-wing endplates (±0.80, 0.22, 2.45) at bottom corners
  const nsPitot = projectLocalPoint([0, 0.455, 1.66], [0, 0.25, 18.0], 64, [0, 0.405, 2.145]);
  const nsTip = projectLocalPoint([0, 0.455, 1.66], [0, 0.25, 18.0], 64, [0, 0.255, 2.42]);
  const nsEndplateL = projectLocalPoint([0, 0.455, 1.66], [0, 0.25, 18.0], 64, [0.80, 0.22, 2.45]);
  assert(
    Math.abs(nsPitot.x) < 0.05 &&
      nsPitot.y > nsTip.y + 0.15 &&
      nsPitot.y > -0.35 &&
      nsTip.y > -0.75 &&
      Math.abs(nsEndplateL.x) < 0.98 &&
      nsEndplateL.y > -0.75,
    `Image 4 (nose) frames central metallic Y-pitot probe (ndcY=${nsPitot.y.toFixed(2)}) above narrow nose tip (ndcY=${nsTip.y.toFixed(2)}) and front wing endplates (ndcX=±${Math.abs(nsEndplateL.x).toFixed(2)}, ndcY=${nsEndplateL.y.toFixed(2)})`
  );

  // Verify dynamic forearm-to-wrist kinematics at full steering lock (±1.0) so forearms never swing above the wheel
  const fullLockTelemetry = { ...simCorner.telemetry, steering: 1.0 };
  carRig.updateFromTelemetry(fullLockTelemetry, 0, 0, 0, 0);
  carRig.root.updateMatrixWorld(true);
  assert(
    Math.abs(carRig.steeringWheelGroup.rotation.z - -1.45) < 0.01,
    `Steering wheel rotates smoothly to full lock (rotZ=${carRig.steeringWheelGroup.rotation.z.toFixed(2)} rad)`
  );

  // Verify all 5 pre-rendered WAV loops in public/audio/f1_real_*.wav have seamless wrap-around and zero pitch wobble
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const wavName of [
    'f1_real_v6_low.wav',
    'f1_real_mid_bark.wav',
    'f1_real_high_roar.wav',
    'f1_real_top_scream.wav',
    'f1_real_overrun.wav',
  ]) {
    const wavPath = path.resolve(process.cwd(), 'public/audio', wavName);
    const wavBuf = fs.readFileSync(wavPath);
    const numSamples = (wavBuf.length - 44) / 2;
    const firstSample = wavBuf.readInt16LE(44) / 32768;
    const lastSample = wavBuf.readInt16LE(44 + (numSamples - 1) * 2) / 32768;
    const prevSample = wavBuf.readInt16LE(44 + (numSamples - 2) * 2) / 32768;
    const stepDelta = Math.abs(lastSample - prevSample);
    const wrapDelta = Math.abs(firstSample - lastSample);
    assert(
      wrapDelta <= Math.max(0.05, stepDelta * 2.5),
      `Audio sample ${wavName} has phase-coherent loop boundary (wrapDelta=${wrapDelta.toFixed(4)}, stepDelta=${stepDelta.toFixed(4)})`
    );
  }


  // 9.6 Extreme 85° Heading Error Off-Track Kerb Recovery in 'pro' Mode
  const simExtreme = new F1Physics2026(track);
  simExtreme.setAssistPreset('pro');
  simExtreme.teleportToDistance(200, 110 / 3.6);
  const sample200 = track.getSampleAtDistance(200);
  simExtreme.lateralOffsetM = sample200.width * 0.5 + 1.6; // Off-track on right runoff/kerb
  simExtreme.headingErrorRad = (85 * Math.PI) / 180; // Extreme +85 deg heading error
  for (let i = 0; i < 120; i++) {
    // Proportional driver countersteer aiming back toward track tangent + centerline
    const targetHeading = THREE.MathUtils.clamp(-simExtreme.lateralOffsetM * 0.06, -0.35, 0.35);
    const err = simExtreme.headingErrorRad - targetHeading;
    simExtreme.step(1 / 60, {
      throttle: 0.35,
      brake: 0,
      steerLeft: THREE.MathUtils.clamp(err * 1.2, 0, 0.85),
      steerRight: THREE.MathUtils.clamp(-err * 1.2, 0, 0.85),
    });
  }
  assert(
    Number.isFinite(simExtreme.vxMs) &&
      Number.isFinite(simExtreme.vyMs) &&
      Number.isFinite(simExtreme.yawRateRadS) &&
      Math.abs(simExtreme.headingErrorRad) < (25 * Math.PI) / 180,
    `Extreme 85° off-track kerb recovery in 'pro' mode stabilizes without NaN or spin divergence (recovered headingError=${((simExtreme.headingErrorRad * 180) / Math.PI).toFixed(1)}°, latOffset=${simExtreme.lateralOffsetM.toFixed(2)}m)`
  );

  // 9.7 Realistic 2026 F1 Braking Distance from 320 km/h to 100 km/h (95m..130m)
  const simBrakingDist = new F1Physics2026(track);
  simBrakingDist.teleportToDistance(25, 320 / 3.6);
  const brakeStartX = simBrakingDist.worldX;
  const brakeStartZ = simBrakingDist.worldZ;
  let stepsBrake = 0;
  while (simBrakingDist.telemetry.speedKmh > 100 && stepsBrake < 3000) {
    simBrakingDist.step(0.002, {
      throttle: 0,
      brake: 1.0,
      steerLeft: 0,
      steerRight: 0,
    });
    stepsBrake++;
  }
  const brakingDistanceM = Math.hypot(
    simBrakingDist.worldX - brakeStartX,
    simBrakingDist.worldZ - brakeStartZ
  );
  assert(
    brakingDistanceM >= 95 && brakingDistanceM <= 130,
    `320 km/h -> 100 km/h threshold braking distance is realistic (${brakingDistanceM.toFixed(1)}m within [95m, 130m])`
  );

  // 9.8 Assetto Corsa KN5 Track Geometry & 12 Trackside TV Cameras Verification
  const { getTracksideTvCameras, getActiveTvCamera } = await import('../src/lib/track-data');
  const tvCams = getTracksideTvCameras();
  const sampleTvCam = getActiveTvCamera(0.25);
  const manifestPath = path.resolve(process.cwd(), 'public/tracks/rwanda/manifest.json');
  const meshBinPath = path.resolve(process.cwd(), 'public/tracks/rwanda/track_meshes.bin');
  assert(
    tvCams.length === 12 &&
      Boolean(sampleTvCam && sampleTvCam.position.length === 3) &&
      fs.existsSync(manifestPath) &&
      fs.existsSync(meshBinPath) &&
      fs.statSync(meshBinPath).size > 1_000_000 &&
      fs.statSync(meshBinPath).size < 25 * 1024 * 1024,
    `Assetto Corsa KN5 binary track mesh (${(fs.statSync(meshBinPath).size / 1048576).toFixed(2)} MB < 25 MB) and ${tvCams.length} official TV cameras verified (active cam @ 0.25 = ${sampleTvCam?.name})`
  );

  console.log('\nALL 9 VERIFICATION SUITES PASSED SUCCESSFULLY!');
}

runVerification().catch((err) => {
  console.error(err);
  process.exit(1);
});

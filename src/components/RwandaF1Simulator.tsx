"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { getActiveTvCamera, getRwandaTrackData, LIVERIES } from "@/lib/track-data";
import { F1Physics2026, type ControlInputs } from "@/lib/f1-physics-2026";
import { F1AudioEngine2026 } from "@/lib/f1-audio-2026";
import { createF1Car2026, type F1Car2026Rig } from "@/lib/car-builder-2026";
import { buildRwandaCircuitScene } from "@/lib/scene-builder";
import { SimVisualFxManager } from "@/lib/sim/visual-fx";
import {
  MultiplayerSyncManager,
  type P2PConnectionStatus,
} from "@/lib/sim/multiplayer-sync";
import { F1TelemetryHud } from "@/components/F1TelemetryHud";
import type {
  AeroSetupPreset,
  AssistPreset,
  CameraMode,
  CarTelemetry,
  LiveryConfig,
  TireCompound,
} from "@/types/f1";

/** Matches the aero package the track's target speeds / braking markers are computed for */
const DEFAULT_AERO_PRESET: AeroSetupPreset = "balanced";
const DEFAULT_ASSIST_PRESET: AssistPreset = "semi_pro";

// Keyboard-only input shaping: a key press becomes a pedal squeeze, not a step
const KB_THROTTLE_RISE_S = 0.25;
const KB_THROTTLE_FALL_S = 0.1;
const KB_BRAKE_RISE_S = 0.17;
const KB_BRAKE_FALL_S = 0.08;
/** Time for keyboard steering to reach its speed-dependent limit, and to recentre */
// Rotates a camera (which looks down -Z) to look along the car's +Z forward axis
const CAM_FORWARD_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const CAM_X_AXIS = new THREE.Vector3(1, 0, 0);
const KB_STEER_RISE_S = 0.3;
const KB_STEER_RETURN_S = 0.18;
/** Keyboard steering limit: road-wheel angle for this lateral acceleration (m/s²) plus a peak slip allowance (rad) */
const KB_STEER_LIMIT_ACCEL = 38;
const KB_STEER_LIMIT_SLIP_RAD = 0.12;

const approach = (value: number, target: number, maxStep: number) =>
  value + Math.max(-maxStep, Math.min(maxStep, target - value));

export const RwandaF1Simulator: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const track = useMemo(() => getRwandaTrackData(1200), []);
  const physicsRef = useRef<F1Physics2026 | null>(null);
  const audioRef = useRef<F1AudioEngine2026 | null>(null);
  const carRigRef = useRef<F1Car2026Rig | null>(null);
  const racingLineMeshRef = useRef<THREE.Mesh | null>(null);
  const multiplayerRef = useRef<MultiplayerSyncManager | null>(null);

  const [telemetry, setTelemetry] = useState<CarTelemetry>(() => {
    const tempPhys = new F1Physics2026(track);
    return { ...tempPhys.telemetry };
  });

  const [aeroPreset, setAeroPreset] =
    useState<AeroSetupPreset>(DEFAULT_AERO_PRESET);
  const [assistPreset, setAssistPreset] = useState<AssistPreset>(
    DEFAULT_ASSIST_PRESET
  );
  const [cameraMode, setCameraMode] = useState<CameraMode>("chase");
  const [tireCompound, setTireCompound] = useState<TireCompound>("soft");
  const [selectedLivery, setSelectedLivery] = useState<LiveryConfig>(
    LIVERIES[0]
  );
  const [showRacingLine, setShowRacingLine] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [boostLatch, setBoostLatch] = useState(false);
  const [mouseSteerEnabled, setMouseSteerEnabled] = useState(false);
  const [gamepadAssist, setGamepadAssist] = useState(true);
  const [p2pStatus, setP2pStatus] = useState<P2PConnectionStatus>({
    mode: "local",
    roomCode: "",
    state: "idle",
    connectedWebRtcPeers: 0,
    statusText: "BroadcastChannel Active (Same-Browser) • Ready for WebRTC P2P",
  });

  const cameraModeRef = useRef<CameraMode>("chase");
  cameraModeRef.current = cameraMode;

  const boostLatchRef = useRef<boolean>(false);
  boostLatchRef.current = boostLatch;

  const mouseSteerEnabledRef = useRef<boolean>(false);
  mouseSteerEnabledRef.current = mouseSteerEnabled;
  const mouseSteerValueRef = useRef<number>(0);
  const slashCommandBufferRef = useRef<string>("");

  const keysRef = useRef<{
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    boostHold: boolean;
    shiftUp: boolean;
    shiftDown: boolean;
    toggleX: boolean;
  }>({
    up: false,
    down: false,
    left: false,
    right: false,
    boostHold: false,
    shiftUp: false,
    shiftDown: false,
    toggleX: false,
  });
  /** Shaped keyboard inputs (pedals 0..1, steering -1..1, + = right) */
  const kbInputRef = useRef({ throttle: 0, brake: 0, steer: 0 });

  const unlockAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new F1AudioEngine2026();
    }
    if (!audioRef.current.isInitialized) {
      audioRef.current.init();
      audioRef.current.setMuted(isMuted);
      setAudioUnlocked(true);
    } else {
      audioRef.current.resume();
    }
  }, [isMuted]);

  const handleAeroPresetChange = useCallback((preset: AeroSetupPreset) => {
    setAeroPreset(preset);
    if (physicsRef.current) {
      physicsRef.current.aeroPreset = preset;
    }
  }, []);

  const handleAssistPresetChange = useCallback((preset: AssistPreset) => {
    setAssistPreset(preset);
    if (physicsRef.current) {
      physicsRef.current.assistPreset = preset;
    }
  }, []);

  const handleToggleGamepadAssist = useCallback(() => {
    setGamepadAssist((prev) => {
      const next = !prev;
      if (physicsRef.current) {
        physicsRef.current.gamepadAssistEnabled = next;
      }
      return next;
    });
  }, []);

  const handleTireCompoundChange = useCallback((compound: TireCompound) => {
    setTireCompound(compound);
    if (physicsRef.current) {
      physicsRef.current.tireCompound = compound;
    }
    carRigRef.current?.setTireCompound(compound);
  }, []);

  const handleLiveryChange = useCallback((livery: LiveryConfig) => {
    setSelectedLivery(livery);
    carRigRef.current?.setLivery(livery);
  }, []);

  const handleToggleRacingLine = useCallback(() => {
    setShowRacingLine((prev) => {
      const next = !prev;
      if (racingLineMeshRef.current) {
        racingLineMeshRef.current.visible = next;
      }
      return next;
    });
  }, []);

  const handleToggleMute = useCallback(() => {
    unlockAudio();
    setIsMuted((prev) => {
      const next = !prev;
      audioRef.current?.setMuted(next);
      return next;
    });
  }, [unlockAudio]);

  const handleToggleAiAutopilot = useCallback(() => {
    unlockAudio();
    if (physicsRef.current) {
      physicsRef.current.aiAutopilot = !physicsRef.current.aiAutopilot;
      if (physicsRef.current.aiAutopilot && physicsRef.current.vxMs < 5) {
        physicsRef.current.vxMs = 45;
      }
    }
  }, [unlockAudio]);

  const handleToggleXMode = useCallback(() => {
    unlockAudio();
    if (physicsRef.current) {
      physicsRef.current.autoXMode = false;
      physicsRef.current.activeAeroMode =
        physicsRef.current.activeAeroMode === "Z_MODE" ? "X_MODE" : "Z_MODE";
    }
  }, [unlockAudio]);

  const handleToggleBoostLatch = useCallback(() => {
    unlockAudio();
    setBoostLatch((prev) => !prev);
  }, [unlockAudio]);

  const handleToggleMouseSteer = useCallback(() => {
    unlockAudio();
    setMouseSteerEnabled((prev) => {
      const next = !prev;
      if (!next) {
        mouseSteerValueRef.current = 0;
      }
      return next;
    });
  }, [unlockAudio]);

  const handleResetCar = useCallback(
    (flyingStart: boolean) => {
      unlockAudio();
      if (physicsRef.current) {
        physicsRef.current.aiAutopilot = false;
        physicsRef.current.resetToStartGrid(flyingStart);
      }
    },
    [unlockAudio]
  );

  const handleSelectTurn = useCallback(
    (turnNumber: number) => {
      unlockAudio();
      if (physicsRef.current) {
        physicsRef.current.aiAutopilot = false;
        physicsRef.current.teleportToTurn(turnNumber);
      }
    },
    [unlockAudio]
  );

  const handleHostP2PRoom = useCallback((customCode?: string) => {
    return multiplayerRef.current?.hostRoom(customCode) ?? "";
  }, []);

  const handleJoinP2PRoom = useCallback((roomCode: string) => {
    multiplayerRef.current?.joinRoom(roomCode);
  }, []);

  const handleCreateManualOffer = useCallback(async () => {
    if (!multiplayerRef.current) return "";
    return multiplayerRef.current.createManualOffer();
  }, []);

  const handleAcceptManualOffer = useCallback(async (offerToken: string) => {
    if (!multiplayerRef.current) return "";
    return multiplayerRef.current.acceptManualOfferAndCreateAnswer(offerToken);
  }, []);

  const handleAcceptManualAnswer = useCallback(async (answerToken: string) => {
    if (!multiplayerRef.current) return false;
    await multiplayerRef.current.acceptManualAnswer(answerToken);
    return true;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const physics = new F1Physics2026(track);
    physics.aiAutopilot = false;
    physics.assistPreset = DEFAULT_ASSIST_PRESET;
    physics.aeroPreset = DEFAULT_AERO_PRESET;
    physics.resetToStartGrid(false);
    physicsRef.current = physics;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x6ea8d9);
    scene.fog = new THREE.FogExp2(0x8ec2e6, 0.00024);

    const camera = new THREE.PerspectiveCamera(
      62,
      container.clientWidth / Math.max(1, container.clientHeight),
      0.12,
      5500
    );

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    container.innerHTML = "";
    container.appendChild(renderer.domElement);

    // Procedural Sky/Horizon PMREM Environment Map for PBR clearcoat, carbon, and metallic reflections
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(
      new THREE.SphereGeometry(60, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0xbae6fd,
        side: THREE.BackSide,
      })
    );
    envScene.add(envSky);
    const envGround = new THREE.Mesh(
      new THREE.SphereGeometry(
        58,
        24,
        12,
        0,
        Math.PI * 2,
        Math.PI * 0.5,
        Math.PI * 0.5
      ),
      new THREE.MeshBasicMaterial({
        color: 0x334155,
        side: THREE.BackSide,
      })
    );
    envScene.add(envGround);
    const envSun = new THREE.Mesh(
      new THREE.SphereGeometry(7, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfffbeb })
    );
    envSun.position.set(22, 34, 18);
    envScene.add(envSun);
    const envRenderTarget = pmremGenerator.fromScene(envScene, 0.04);
    scene.environment = envRenderTarget.texture;
    scene.environmentIntensity = 0.85;
    pmremGenerator.dispose();

    // East African Golden Sunlight & Sky Dome
    const hemiLight = new THREE.HemisphereLight(0xbae6fd, 0x3f6212, 1.05);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff4d6, 2.5);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 5;
    sunLight.shadow.camera.far = 260;
    const shadowSpan = 42;
    sunLight.shadow.camera.left = -shadowSpan;
    sunLight.shadow.camera.right = shadowSpan;
    sunLight.shadow.camera.top = shadowSpan;
    sunLight.shadow.camera.bottom = -shadowSpan;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);
    scene.add(sunLight.target);

    // Atmospheric Sky Gradient Sphere
    const skyGeom = new THREE.SphereGeometry(4200, 32, 16);
    const skyVertCount = skyGeom.attributes.position.count;
    const skyColors = new Float32Array(skyVertCount * 3);
    for (let i = 0; i < skyVertCount; i++) {
      const y = skyGeom.attributes.position.getY(i);
      const t = THREE.MathUtils.clamp((y + 400) / 3600, 0, 1);
      const col = new THREE.Color().lerpColors(
        new THREE.Color(0xdbeafe),
        new THREE.Color(0x0284c7),
        Math.pow(t, 0.65)
      );
      skyColors[i * 3] = col.r;
      skyColors[i * 3 + 1] = col.g;
      skyColors[i * 3 + 2] = col.b;
    }
    skyGeom.setAttribute("color", new THREE.BufferAttribute(skyColors, 3));
    const skyMesh = new THREE.Mesh(
      skyGeom,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    scene.add(skyMesh);

    const builtCircuit = buildRwandaCircuitScene(track);
    scene.add(builtCircuit.sceneGroup);
    racingLineMeshRef.current = builtCircuit.racingLineMesh;

    const carRig = createF1Car2026(LIVERIES[0], "soft");
    scene.add(carRig.root);
    carRigRef.current = carRig;

    // Persistent 4-Wheel Skidmarks, Instanced Tire Smoke/Gravel & Multiplayer/AI Opponent Renderer
    const visualFx = new SimVisualFxManager();
    scene.add(visualFx.group);
    const multiplayerSync = new MultiplayerSyncManager(track);
    multiplayerSync.onStatusChange = (st) => {
      setP2pStatus(st);
    };
    multiplayerRef.current = multiplayerSync;

    // Underbody Titanium Skid-Block Sparks
    const sparkCount = 48;
    const sparkGeom = new THREE.BufferGeometry();
    const sparkPositions = new Float32Array(sparkCount * 3);
    const sparkVelocities: THREE.Vector3[] = [];
    const sparkLives = new Float32Array(sparkCount);

    for (let i = 0; i < sparkCount; i++) {
      sparkVelocities.push(new THREE.Vector3());
      sparkLives[i] = 0;
    }
    sparkGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(sparkPositions, 3)
    );
    const sparkPoints = new THREE.Points(
      sparkGeom,
      new THREE.PointsMaterial({
        color: 0xfbbf24,
        size: 0.22,
        transparent: true,
        opacity: 0.9,
      })
    );
    scene.add(sparkPoints);
    let nextSparkIdx = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!mouseSteerEnabledRef.current) return;
      const w = Math.max(1, window.innerWidth);
      // Center 65% of screen maps smoothly to [-1, 1] steering lock with slight precision curve
      const rawNorm = ((e.clientX / w) * 2 - 1) / 0.65;
      const clamped = THREE.MathUtils.clamp(rawNorm, -1, 1);
      mouseSteerValueRef.current =
        Math.sign(clamped) * Math.pow(Math.abs(clamped), 1.18);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      unlockAudio();
      const code = e.code;

      // Support typing "/boost" anywhere to latch 350kW MGU-K + 425kW ICE Overboost
      if (e.key && e.key.length === 1) {
        if (e.key === "/") {
          slashCommandBufferRef.current = "/";
          return;
        } else if (slashCommandBufferRef.current.startsWith("/")) {
          slashCommandBufferRef.current = (
            slashCommandBufferRef.current + e.key.toLowerCase()
          ).slice(-6);
          if (slashCommandBufferRef.current === "/boost") {
            physics.activateBoostOverride();
            setBoostLatch((prev) => !prev);
            slashCommandBufferRef.current = "";
            return;
          }
          if ("/boost".startsWith(slashCommandBufferRef.current)) {
            return;
          } else {
            slashCommandBufferRef.current = "";
          }
        }
      }

      if (code === "KeyW" || code === "ArrowUp") {
        keysRef.current.up = true;
        if (physics.aiAutopilot) physics.aiAutopilot = false;
      } else if (code === "KeyS" || code === "ArrowDown") {
        keysRef.current.down = true;
        if (physics.aiAutopilot) physics.aiAutopilot = false;
      } else if (code === "KeyA" || code === "ArrowLeft") {
        keysRef.current.left = true;
        if (physics.aiAutopilot) physics.aiAutopilot = false;
      } else if (code === "KeyD" || code === "ArrowRight") {
        keysRef.current.right = true;
        if (physics.aiAutopilot) physics.aiAutopilot = false;
      } else if (
        code === "Space" ||
        code === "ShiftLeft" ||
        code === "ShiftRight"
      ) {
        keysRef.current.boostHold = true;
      } else if (code === "KeyB") {
        setBoostLatch((prev) => !prev);
      } else if (code === "KeyV") {
        setMouseSteerEnabled((prev) => {
          const next = !prev;
          if (!next) mouseSteerValueRef.current = 0;
          return next;
        });
      } else if (code === "KeyX") {
        keysRef.current.toggleX = true;
      } else if (code === "KeyE") {
        keysRef.current.shiftUp = true;
      } else if (code === "KeyQ") {
        keysRef.current.shiftDown = true;
      } else if (code === "KeyC") {
        const modes: CameraMode[] = [
          "chase",
          "tv_pod",
          "cockpit_shoulder",
          "cockpit",
          "nose",
          "helicopter",
          "tv_side",
        ];
        const next =
          modes[(modes.indexOf(cameraModeRef.current) + 1) % modes.length];
        setCameraMode(next);
      } else if (code === "KeyR") {
        handleToggleRacingLine();
      } else if (code === "KeyM") {
        handleToggleMute();
      } else if (code === "KeyP") {
        physics.aiAutopilot = !physics.aiAutopilot;
        if (physics.aiAutopilot && physics.vxMs < 5) {
          physics.vxMs = 45;
        }
      } else if (code === "Backspace") {
        physics.aiAutopilot = false;
        physics.resetToStartGrid(true);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const code = e.code;
      if (code === "KeyW" || code === "ArrowUp") keysRef.current.up = false;
      else if (code === "KeyS" || code === "ArrowDown")
        keysRef.current.down = false;
      else if (code === "KeyA" || code === "ArrowLeft")
        keysRef.current.left = false;
      else if (code === "KeyD" || code === "ArrowRight")
        keysRef.current.right = false;
      else if (
        code === "Space" ||
        code === "ShiftLeft" ||
        code === "ShiftRight"
      ) {
        keysRef.current.boostHold = false;
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const onResize = () => {
      if (!container) return;
      camera.aspect =
        container.clientWidth / Math.max(1, container.clientHeight);
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", onResize);

    let animFrameId = 0;
    let lastTimeMs = performance.now();
    let lastHudSyncMs = 0;

    // iRacing / Assetto Corsa Horizon-Stabilized Sim Camera State
    let smoothedCamSlipYaw = 0;
    let smoothedCamDist = 5.35;
    let smoothedApexLookYaw = 0;
    const smoothedCamUp = new THREE.Vector3(0, 1, 0);
    const smoothedHeliPos = new THREE.Vector3();
    const smoothedHeliLook = new THREE.Vector3();
    const smoothedTvLook = new THREE.Vector3();
    let lastTvCamName = "";

    const animate = (nowMs: number) => {
      animFrameId = requestAnimationFrame(animate);
      const dtSeconds = Math.min((nowMs - lastTimeMs) / 1000, 0.05);
      lastTimeMs = nowMs;

      // Optional Gamepad / Sim Racing Wheel Polling. Controllers with the standard mapping (Xbox,
      // DualShock, DualSense …) send the raw thumbstick through the physics' gamepad steering
      // assist every frame (also when centred: it self-aligns); other devices (wheels) drive the
      // rack directly.
      let gamepadThrottle = 0;
      let gamepadBrake = 0;
      let gamepadSteer: number | undefined = undefined;
      let gamepadStick: number | undefined = undefined;
      let gamepadBoost = false;
      if (typeof navigator !== "undefined" && navigator.getGamepads) {
        const pads = navigator.getGamepads();
        const pad = pads && pads[0];
        if (pad) {
          const rawStickX = pad.axes[0] || 0;
          if (pad.mapping === "standard") {
            gamepadStick = rawStickX;
          } else if (Math.abs(rawStickX) > 0.04) {
            gamepadSteer = rawStickX;
          }
          if (pad.buttons[7]?.value) gamepadThrottle = pad.buttons[7].value;
          if (pad.buttons[6]?.value) gamepadBrake = pad.buttons[6].value;
          if (pad.buttons[0]?.pressed) gamepadBoost = true;
        }
      }

      // Keyboard-only input shaping: keys become ramped pedals and a rate- and speed-limited
      // steering angle (about what keeps the front tyres near peak slip at this speed).
      // Wheel and mouse inputs are passed through untouched.
      const keys = keysRef.current;
      const kb = kbInputRef.current;
      kb.throttle = approach(
        kb.throttle,
        keys.up ? 1 : 0,
        dtSeconds / (keys.up ? KB_THROTTLE_RISE_S : KB_THROTTLE_FALL_S)
      );
      kb.brake = approach(
        kb.brake,
        keys.down ? 1 : 0,
        dtSeconds / (keys.down ? KB_BRAKE_RISE_S : KB_BRAKE_FALL_S)
      );
      const vFwd = Math.max(0, physics.vxMs);
      const kbSteerLimit = Math.min(
        1,
        ((physics.wheelbaseM * KB_STEER_LIMIT_ACCEL) / Math.max(1, vFwd * vFwd) +
          KB_STEER_LIMIT_SLIP_RAD) /
          physics.maxSteerAngleRad
      );
      const kbSteerTarget =
        ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * kbSteerLimit;
      const kbRecentring =
        kbSteerTarget === 0 || kbSteerTarget * kb.steer < 0;
      kb.steer = approach(
        kb.steer,
        kbSteerTarget,
        (kbSteerLimit / (kbRecentring ? KB_STEER_RETURN_S : KB_STEER_RISE_S)) *
          dtSeconds
      );
      const kbSteerActive = keys.left || keys.right || Math.abs(kb.steer) > 1e-3;
      const activeAnalogSteer = mouseSteerEnabledRef.current
        ? mouseSteerValueRef.current
        : gamepadSteer;

      const inputs: ControlInputs = {
        throttle: Math.max(kb.throttle, gamepadThrottle),
        brake: Math.max(kb.brake, gamepadBrake),
        steerLeft: 0,
        steerRight: 0,
        analogSteer: kbSteerActive ? kb.steer : activeAnalogSteer,
        padSteer:
          kbSteerActive || mouseSteerEnabledRef.current ? undefined : gamepadStick,
        manualOverride:
          keysRef.current.boostHold || boostLatchRef.current || gamepadBoost,
        toggleXMode: keysRef.current.toggleX,
        shiftUp: keysRef.current.shiftUp,
        shiftDown: keysRef.current.shiftDown,
      };
      keysRef.current.toggleX = false;
      keysRef.current.shiftUp = false;
      keysRef.current.shiftDown = false;

      physics.step(dtSeconds, inputs);

      // Update 3D Dashed Dynamic Braking Line colors (green/yellow/red) ahead of the car (Reference Image 4)
      builtCircuit.updateDynamicRacingLine(physics.sMeters, physics.vxMs);

      // Update 25 Hz BroadcastChannel + Cubic Hermite/Slerp Multiplayer & AI Opponents
      const carVelocityWorld = new THREE.Vector3(
        physics.vyMs,
        0,
        physics.vxMs
      ).applyQuaternion(physics.worldQuaternion);
      const interpolatedPeers = multiplayerSync.update(
        dtSeconds,
        nowMs,
        track,
        {
          driverCode: "RWA",
          teamColorHex: "#E10600",
          pos: [
            physics.worldPosition.x,
            physics.worldPosition.y,
            physics.worldPosition.z,
          ],
          quat: [
            physics.worldQuaternion.x,
            physics.worldQuaternion.y,
            physics.worldQuaternion.z,
            physics.worldQuaternion.w,
          ],
          linVel: [carVelocityWorld.x, carVelocityWorld.y, carVelocityWorld.z],
          angVel: [0, physics.yawRateRadS, 0],
          steerAngle: physics.steerAngleNorm * 0.36,
          wheelRPMs: [
            physics.wheels[0].spinVel * 9.549296,
            physics.wheels[1].spinVel * 9.549296,
            physics.wheels[2].spinVel * 9.549296,
            physics.wheels[3].spinVel * 9.549296,
          ],
          throttle: physics.telemetry.throttle,
          brake: physics.telemetry.brake,
          trackS: physics.sMeters,
          speedKmh: physics.telemetry.speedKmh,
        }
      );

      physics.telemetry.peers = interpolatedPeers.map((p) => {
        let deltaS = p.trackS - physics.sMeters;
        if (deltaS > track.totalLengthM * 0.5) deltaS -= track.totalLengthM;
        if (deltaS < -track.totalLengthM * 0.5) deltaS += track.totalLengthM;
        const refSpeedMs = Math.max(25, physics.vxMs, p.speedKmh / 3.6);
        return {
          peerId: p.peerId,
          driverCode: p.driverCode,
          teamColorHex: p.teamColorHex,
          trackDistanceM: p.trackS,
          speedKmh: p.speedKmh,
          gapSeconds: Number((deltaS / refSpeedMs).toFixed(2)),
          isAiPeer: p.isAiPeer,
        };
      });

      // Keep mouseSteerValueRef synchronized with actual steering angle while keyboard A/D override is held
      // so releasing A/D mid-corner at 300+ km/h transitions seamlessly without a step jump
      if (mouseSteerEnabledRef.current && kbSteerActive) {
        mouseSteerValueRef.current = kb.steer;
      }

      // Auto-disengage latched /boost if ERS battery is completely depleted
      if (boostLatchRef.current && physics.ersEnergyJ <= 2_500) {
        boostLatchRef.current = false;
        setBoostLatch(false);
      }

      const mode = cameraModeRef.current;
      const vf26Cams = carRig.getVf26CameraAnchors();
      // Hide driver helmet mesh only when inside first-person cockpit view so it never clips the camera
      // (the procedural driver is hidden entirely once the VF26 model has replaced the procedural car)
      carRig.helmetGroup.visible = mode !== "cockpit" && !vf26Cams;
      carRig.setCockpitView(mode === "cockpit");

      carRig.root.position.copy(physics.worldPosition);
      carRig.root.quaternion.copy(physics.worldQuaternion);
      carRig.chassisGroup.position.y = physics.rideHeightOffsetM;
      carRig.updateFromTelemetry(
        physics.telemetry,
        physics.pitchRad,
        physics.rollRad,
        physics.wheelRotationRad,
        dtSeconds
      );

      // Update persistent 4-wheel skidmark ribbons, tire smoke/gravel particles & opponent 3D cars
      visualFx.update(
        dtSeconds,
        physics.worldQuaternion,
        physics.vxMs,
        physics.wheels,
        interpolatedPeers
      );

      sunLight.position.set(
        physics.worldPosition.x + 85,
        physics.worldPosition.y + 115,
        physics.worldPosition.z - 65
      );
      sunLight.target.position.copy(physics.worldPosition);

      // Titanium Floor Sparks
      if (
        (physics.telemetry.speedKmh > 280 &&
          (physics.telemetry.verticalG ?? 1.0) > 1.15) ||
        physics.telemetry.onKerbLeft ||
        physics.telemetry.onKerbRight
      ) {
        const carForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
          physics.worldQuaternion
        );
        const carRight = new THREE.Vector3(-1, 0, 0).applyQuaternion(
          physics.worldQuaternion
        );
        for (let s = 0; s < 2; s++) {
          const idx = nextSparkIdx % sparkCount;
          nextSparkIdx++;
          const spawnPos = physics.worldPosition
            .clone()
            .addScaledVector(carForward, -1.9)
            .addScaledVector(carRight, (Math.random() - 0.5) * 0.7)
            .add(new THREE.Vector3(0, 0.08, 0));

          sparkPositions[idx * 3] = spawnPos.x;
          sparkPositions[idx * 3 + 1] = spawnPos.y;
          sparkPositions[idx * 3 + 2] = spawnPos.z;

          sparkVelocities[idx]
            .copy(carForward)
            .multiplyScalar(-physics.vxMs * 0.35)
            .add(
              new THREE.Vector3(
                (Math.random() - 0.5) * 6,
                1.8 + Math.random() * 3.5,
                (Math.random() - 0.5) * 6
              )
            );
          sparkLives[idx] = 0.25 + Math.random() * 0.2;
        }
      }

      for (let i = 0; i < sparkCount; i++) {
        if (sparkLives[i] > 0) {
          sparkLives[i] -= dtSeconds;
          sparkPositions[i * 3] += sparkVelocities[i].x * dtSeconds;
          sparkPositions[i * 3 + 1] += sparkVelocities[i].y * dtSeconds;
          sparkPositions[i * 3 + 2] += sparkVelocities[i].z * dtSeconds;
          sparkVelocities[i].y -= 9.81 * dtSeconds;
        } else {
          sparkPositions[i * 3 + 1] = -999;
        }
      }
      sparkGeom.attributes.position.needsUpdate = true;

      // Right-handed car basis: +X is carLeft, -X is carRight, +Y is carUp, +Z is carForward
      const carRight = new THREE.Vector3(-1, 0, 0).applyQuaternion(
        physics.worldQuaternion
      );
      const carUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
        physics.worldQuaternion
      );
      const carForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
        physics.worldQuaternion
      );

      const speedNorm = THREE.MathUtils.clamp(
        physics.telemetry.speedKmh / 350,
        0,
        1
      );
      const kerbShake =
        physics.telemetry.onKerbLeft || physics.telemetry.onKerbRight
          ? Math.sin(nowMs * 0.095) * 0.018
          : 0;
      const highSpeedBuffet =
        speedNorm > 0.72
          ? Math.sin(nowMs * 0.07) * 0.007 * (speedNorm - 0.72)
          : 0;

      // True vehicle chassis slip angle beta = atan2(vy, vx) (+X is left, so -vy is rightward slip)
      const bodySlipAngleRad =
        physics.vxMs > 3
          ? Math.atan2(-physics.vyMs, Math.max(3, physics.vxMs))
          : 0;

      const vf26Cam =
        vf26Cams &&
        (mode === "cockpit"
          ? vf26Cams.cockpit
          : mode === "cockpit_shoulder"
            ? vf26Cams.shoulder
            : mode === "tv_pod"
              ? vf26Cams.tcam
              : mode === "nose"
                ? vf26Cams.bumper
                : null);
      if (vf26Cam) {
        // AC EVO onboard cameras from the mod (gp_2026_vf26.actor): bolted to the sprung chassis at the
        // mod's position, pitch and field of view
        carRig.chassisGroup.updateWorldMatrix(true, false);
        camera.position.copy(vf26Cam.pos).applyMatrix4(carRig.chassisGroup.matrixWorld);
        carRig.chassisGroup.getWorldQuaternion(camera.quaternion);
        camera.quaternion
          .multiply(CAM_FORWARD_FLIP)
          .multiply(new THREE.Quaternion().setFromAxisAngle(CAM_X_AXIS, vf26Cam.pitchRad));
        camera.up.copy(carUp);
        if (camera.fov !== vf26Cam.fovDeg) {
          camera.fov = vf26Cam.fovDeg;
          camera.updateProjectionMatrix();
        }
      } else if (mode === "chase") {
        // iRacing / Assetto Corsa Horizon-Stabilized Sim Chase Rig:
        // Camera boom trails the car's true velocity & yaw trajectory
        const targetSlipYaw = THREE.MathUtils.clamp(
          -physics.yawRateRadS * 0.085 + bodySlipAngleRad * 0.65,
          -0.22,
          0.22
        );
        smoothedCamSlipYaw = THREE.MathUtils.lerp(
          smoothedCamSlipYaw,
          targetSlipYaw,
          Math.min(1, dtSeconds * 14)
        );

        const boostExtraDist = physics.telemetry.manualOverrideActive ? 0.24 : 0;
        const targetDist =
          5.25 +
          THREE.MathUtils.clamp(
            physics.telemetry.longitudinalG * 0.11,
            -0.22,
            0.26
          ) +
          boostExtraDist;
        smoothedCamDist = THREE.MathUtils.lerp(
          smoothedCamDist,
          targetDist,
          Math.min(1, dtSeconds * 12)
        );

        const camBoomDir = carForward
          .clone()
          .applyAxisAngle(carUp, smoothedCamSlipYaw)
          .normalize();

        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(camBoomDir, -smoothedCamDist)
          .addScaledVector(
            carUp,
            1.78 + physics.rideHeightOffsetM * 0.5 + kerbShake
          );

        const horizonBlendedUp = new THREE.Vector3(0, 1, 0)
          .lerp(carUp, 0.55)
          .normalize();
        smoothedCamUp
          .lerp(horizonBlendedUp, Math.min(1, dtSeconds * 14))
          .normalize();
        camera.up.copy(smoothedCamUp);

        const targetApexLook = THREE.MathUtils.clamp(
          physics.yawRateRadS * 0.45,
          -0.55,
          0.55
        );
        smoothedApexLookYaw = THREE.MathUtils.lerp(
          smoothedApexLookYaw,
          targetApexLook,
          Math.min(1, dtSeconds * 10)
        );

        const lookPoint = physics.worldPosition
          .clone()
          .addScaledVector(carForward, 14.5)
          .addScaledVector(carRight, -smoothedApexLookYaw)
          .addScaledVector(
            carUp,
            0.52 - physics.pitchRad * 3.2 + highSpeedBuffet
          );
        camera.lookAt(lookPoint);

        const boostFovKick = physics.telemetry.manualOverrideActive ? 3.5 : 0;
        camera.fov = THREE.MathUtils.lerp(
          camera.fov,
          57 + speedNorm * 13 + boostFovKick,
          Math.min(1, dtSeconds * 10)
        );
        camera.updateProjectionMatrix();
      } else if (mode === "tv_pod") {
        // Reference Image 1: High F1TV Roll-Hoop T-Cam mounted at front lens of T-Cam pod looking down over painted helmet #16, butterfly wheel + gloved hand, Halo arch, mirrors, wheel brows & nose cone
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, -0.06)
          .addScaledVector(carRight, -0.02 - physics.rollRad * 0.3)
          .addScaledVector(
            carUp,
            0.905 + physics.rideHeightOffsetM + kerbShake * 0.4
          );
        camera.up
          .copy(carUp)
          .addScaledVector(carRight, -physics.rollRad * 0.25)
          .normalize();
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 3.6)
            .addScaledVector(carRight, -physics.yawRateRadS * 0.12)
            .addScaledVector(
              carUp,
              0.22 - physics.pitchRad * 2.2 + highSpeedBuffet
            )
        );
        camera.fov = 60 + speedNorm * 5;
        camera.updateProjectionMatrix();
      } else if (mode === "cockpit_shoulder") {
        // Reference Image 2: Left Over-the-Shoulder Cockpit Bolster Camera showing helmet on right, yellow gloved hand on butterfly steering wheel, Halo arch & left mirror/wheel brow
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, 0.06)
          .addScaledVector(carRight, -0.24 - physics.rollRad * 0.22)
          .addScaledVector(
            carUp,
            0.715 + physics.rideHeightOffsetM + kerbShake * 0.35
          );
        camera.up
          .copy(carUp)
          .addScaledVector(carRight, -physics.rollRad * 0.22)
          .normalize();
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 5.5)
            .addScaledVector(carRight, 0.13 - physics.yawRateRadS * 0.25)
            .addScaledVector(
              carUp,
              0.40 - physics.pitchRad * 2.8 + highSpeedBuffet
            )
        );
        camera.fov = 58 + speedNorm * 5;
        camera.updateProjectionMatrix();
      } else if (mode === "cockpit") {
        // Reference Image 3: Driver Eye-Point Camera inside cockpit framing full Butterfly Steering Wheel OLED, Labeled Buttons, Rotary Dials, 3D Gloved Hands, Wing Mirrors & Wheel Brows under Halo
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, 0.21 - physics.pitchRad * 0.2)
          .addScaledVector(carRight, -physics.rollRad * 0.22)
          .addScaledVector(
            carUp,
            0.675 + physics.rideHeightOffsetM + kerbShake * 0.32
          );
        camera.up
          .copy(carUp)
          .addScaledVector(carRight, -physics.rollRad * 0.2)
          .normalize();
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 8.0)
            .addScaledVector(
              carUp,
              0.50 - physics.pitchRad * 3.5 + highSpeedBuffet
            )
            .addScaledVector(carRight, -physics.yawRateRadS * 0.3)
        );
        camera.fov = 62 + speedNorm * 4;
        camera.updateProjectionMatrix();
      } else if (mode === "nose") {
        // Reference Image 4: Forward Nose-Cone Camera showing narrow Nose Tip, delicate Y-Pitot Probe, curved vertical Front Wing Endplates at bottom corners & 3D Dashed Braking Line
        camera.position
          .copy(physics.worldPosition)
          .addScaledVector(carForward, 1.66)
          .addScaledVector(
            carUp,
            0.455 + physics.rideHeightOffsetM + kerbShake * 0.32
          );
        camera.up.copy(carUp);
        camera.lookAt(
          physics.worldPosition
            .clone()
            .addScaledVector(carForward, 18.0)
            .addScaledVector(carUp, 0.25 - physics.pitchRad * 5.0)
        );
        camera.fov = 64 + speedNorm * 4;
        camera.updateProjectionMatrix();
      } else if (mode === "helicopter") {
        const heliTarget = physics.worldPosition
          .clone()
          .addScaledVector(carForward, -28)
          .add(new THREE.Vector3(14, 24, 14));
        if (smoothedHeliPos.distanceTo(heliTarget) > 80) {
          smoothedHeliPos.copy(heliTarget);
          smoothedHeliLook.copy(physics.worldPosition);
        } else {
          smoothedHeliPos.lerp(heliTarget, Math.min(1, dtSeconds * 6));
        }
        smoothedHeliLook.lerp(
          physics.worldPosition.clone().addScaledVector(carForward, 14),
          Math.min(1, dtSeconds * 12)
        );
        camera.position.copy(smoothedHeliPos);
        camera.up.set(0, 1, 0);
        camera.lookAt(smoothedHeliLook);
        camera.fov = 52;
        camera.updateProjectionMatrix();
      } else if (mode === "tv_side") {
        // Official Assetto Corsa Trackside TV Broadcast Cameras (CAM0..CAM11 from layout_2026/data/cameras.ini)
        const tvCam = getActiveTvCamera(physics.telemetry.trackProgress);
        camera.position.set(
          tvCam.position[0],
          tvCam.position[1],
          tvCam.position[2]
        );
        camera.up.set(0, 1, 0);

        const targetLook = physics.worldPosition
          .clone()
          .addScaledVector(carForward, 1.8)
          .add(new THREE.Vector3(0, 0.45, 0));

        const distToCar = camera.position.distanceTo(physics.worldPosition);
        const zoomAlpha = THREE.MathUtils.clamp((distToCar - 18) / 260, 0, 1);
        const targetFov = THREE.MathUtils.lerp(
          Math.max(tvCam.maxFov, 24),
          Math.max(tvCam.minFov, 10),
          zoomAlpha
        );

        if (lastTvCamName !== tvCam.name) {
          lastTvCamName = tvCam.name;
          smoothedTvLook.copy(targetLook);
          camera.fov = targetFov;
        } else {
          smoothedTvLook.lerp(targetLook, Math.min(1, dtSeconds * 22));
          camera.fov = THREE.MathUtils.lerp(
            camera.fov,
            targetFov,
            Math.min(1, dtSeconds * 8)
          );
        }
        camera.lookAt(smoothedTvLook);
        camera.updateProjectionMatrix();
      }

      builtCircuit.updateEnvironment(nowMs * 0.001);
      audioRef.current?.setCameraMode(cameraModeRef.current);
      audioRef.current?.update(physics.telemetry, dtSeconds);

      renderer.render(scene, camera);

      if (nowMs - lastHudSyncMs > 33) {
        lastHudSyncMs = nowMs;
        setTelemetry({
          ...physics.telemetry,
          tireTempsC: [...physics.telemetry.tireTempsC],
          brakeTempsC: [...physics.telemetry.brakeTempsC],
          wheelSlipRatios: [...physics.telemetry.wheelSlipRatios],
          wheelSlipAnglesDeg: [...physics.telemetry.wheelSlipAnglesDeg],
          wheelLoadsN: [...physics.telemetry.wheelLoadsN],
          wheelRideHeightsMm: [...physics.telemetry.wheelRideHeightsMm],
          suspensionTravelMm: [...physics.telemetry.suspensionTravelMm],
          tireWearPct: [...physics.telemetry.tireWearPct],
          tireGripFactor: [...physics.telemetry.tireGripFactor],
          wheelSurfaces: [...physics.telemetry.wheelSurfaces],
          peers: [...(physics.telemetry.peers ?? [])],
        });
      }
    };

    animFrameId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animFrameId);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      multiplayerSync.dispose();
      renderer.dispose();
      audioRef.current?.dispose();
    };
  }, [track, unlockAudio, handleToggleMute, handleToggleRacingLine]);

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-[#0B0B10]"
      onPointerDown={unlockAudio}
    >
      <div ref={containerRef} className="h-full w-full" />

      {!audioUnlocked ? (
        <div className="pointer-events-none fixed top-28 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap f1-panel border-l-4 border-l-[#E10600] px-4 py-1.5 font-f1-italic text-xs uppercase tracking-wider text-white shadow-2xl">
          PRESS W / ↑ TO LAUNCH • REAL F1 ENGINE SOUND • SPACE / B / &quot;/BOOST&quot; FOR 350KW BOOST • V FOR MOUSE STEER
        </div>
      ) : null}

      {mouseSteerEnabled ? (
        <div className="pointer-events-none fixed top-28 left-1/2 z-30 -translate-x-1/2 flex flex-col items-center gap-1 f1-panel rounded px-3 py-1.5 border border-[#00D26A]/50">
          <div className="font-f1-mono text-[10px] font-bold uppercase text-[#00D26A]">
            1:1 IRACING MOUSE STEERING ACTIVE (PRESS V TO EXIT)
          </div>
          <div className="relative h-2 w-44 rounded bg-zinc-900 border border-white/15 overflow-hidden">
            <div className="absolute inset-y-0 left-1/2 w-0.5 bg-white/40" />
            <div
              className="absolute top-0 bottom-0 w-2.5 -translate-x-1/2 rounded bg-[#00D26A] shadow-[0_0_8px_#00D26A]"
              style={{
                left: `${50 + telemetry.steering * 48}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {telemetry.offTrack ? (
        <div className="pointer-events-none fixed top-40 left-1/2 z-30 -translate-x-1/2 bg-[#E10600] px-4 py-1 font-f1-italic text-xs uppercase tracking-wider text-white shadow-xl">
          FIA STEWARDS: TRACK LIMITS EXCEEDED — PAINTED RUNOFF
        </div>
      ) : null}

      <F1TelemetryHud
        track={track}
        telemetry={telemetry}
        aeroPreset={aeroPreset}
        assistPreset={assistPreset}
        cameraMode={cameraMode}
        tireCompound={tireCompound}
        selectedLivery={selectedLivery}
        showRacingLine={showRacingLine}
        isMuted={isMuted}
        boostLatch={boostLatch}
        mouseSteerEnabled={mouseSteerEnabled}
        gamepadAssist={gamepadAssist}
        onToggleGamepadAssist={handleToggleGamepadAssist}
        p2pStatus={p2pStatus}
        onChangeAeroPreset={handleAeroPresetChange}
        onChangeAssistPreset={handleAssistPresetChange}
        onChangeCameraMode={setCameraMode}
        onChangeTireCompound={handleTireCompoundChange}
        onChangeLivery={handleLiveryChange}
        onToggleRacingLine={handleToggleRacingLine}
        onToggleMute={handleToggleMute}
        onToggleAiAutopilot={handleToggleAiAutopilot}
        onToggleXMode={handleToggleXMode}
        onToggleBoostLatch={handleToggleBoostLatch}
        onToggleMouseSteer={handleToggleMouseSteer}
        onResetCar={handleResetCar}
        onSelectTurn={handleSelectTurn}
        onHostP2PRoom={handleHostP2PRoom}
        onJoinP2PRoom={handleJoinP2PRoom}
        onCreateManualOffer={handleCreateManualOffer}
        onAcceptManualOffer={handleAcceptManualOffer}
        onAcceptManualAnswer={handleAcceptManualAnswer}
      />
    </div>
  );
};

"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Copy,
  Cpu,
  Flag,
  Gauge,
  HelpCircle,
  MapPin,
  Radio,
  RotateCcw,
  Settings2,
  Volume2,
  VolumeX,
  Wind,
  Zap,
} from "lucide-react";
import type {
  AeroSetupPreset,
  CameraMode,
  CarTelemetry,
  DriverAssistPreset,
  LiveryConfig,
  TireCompound,
} from "@/types/f1";
import type { P2PConnectionStatus } from "@/lib/sim/multiplayer-sync";
import {
  type BuiltTrackData,
  LIVERIES,
  TURN_METADATA,
} from "@/lib/track-data";
import { TrackMinimap } from "./TrackMinimap";

interface F1TelemetryHudProps {
  track: BuiltTrackData;
  telemetry: CarTelemetry;
  aeroPreset: AeroSetupPreset;
  assistPreset: DriverAssistPreset;
  cameraMode: CameraMode;
  tireCompound: TireCompound;
  selectedLivery: LiveryConfig;
  showRacingLine: boolean;
  isMuted: boolean;
  boostLatch: boolean;
  mouseSteerEnabled?: boolean;
  p2pStatus?: P2PConnectionStatus;
  onChangeAeroPreset: (preset: AeroSetupPreset) => void;
  onChangeAssistPreset: (preset: DriverAssistPreset) => void;
  onChangeCameraMode: (mode: CameraMode) => void;
  onChangeTireCompound: (compound: TireCompound) => void;
  onChangeLivery: (livery: LiveryConfig) => void;
  onToggleRacingLine: () => void;
  onToggleMute: () => void;
  onToggleAiAutopilot: () => void;
  onToggleXMode: () => void;
  onToggleBoostLatch: () => void;
  onToggleMouseSteer?: () => void;
  onResetCar: (flyingStart: boolean) => void;
  onSelectTurn: (turnNumber: number) => void;
  onHostP2PRoom?: (customCode?: string) => string;
  onJoinP2PRoom?: (roomCode: string) => void;
  onCreateManualOffer?: () => Promise<string>;
  onAcceptManualOffer?: (offerToken: string) => Promise<string>;
  onAcceptManualAnswer?: (answerToken: string) => Promise<boolean>;
}

function formatLapTime(ms: number | null): string {
  if (ms === null || ms <= 0) return "--:--.---";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const millis = Math.floor(ms % 1000);
  return `${mins}:${secs.toString().padStart(2, "0")}.${millis
    .toString()
    .padStart(3, "0")}`;
}

const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "CHASE",
  tv_pod: "T-CAM",
  cockpit_shoulder: "SHOULDER",
  cockpit: "COCKPIT",
  nose: "NOSE",
  helicopter: "HELI TV",
  tv_side: "TRACK TV",
};

const TIRE_BADGE: Record<
  TireCompound,
  { letter: string; ringColor: string; label: string }
> = {
  soft: { letter: "S", ringColor: "#E10600", label: "SOFT C5" },
  medium: { letter: "M", ringColor: "#FFD700", label: "MED C4" },
  hard: { letter: "H", ringColor: "#FFFFFF", label: "HARD C3" },
};

export const F1TelemetryHud: React.FC<F1TelemetryHudProps> = ({
  track,
  telemetry,
  aeroPreset,
  assistPreset,
  cameraMode,
  tireCompound,
  selectedLivery,
  showRacingLine,
  isMuted,
  boostLatch,
  mouseSteerEnabled = false,
  p2pStatus,
  onChangeAeroPreset,
  onChangeAssistPreset,
  onChangeCameraMode,
  onChangeTireCompound,
  onChangeLivery,
  onToggleRacingLine,
  onToggleMute,
  onToggleAiAutopilot,
  onToggleXMode,
  onToggleBoostLatch,
  onToggleMouseSteer,
  onResetCar,
  onSelectTurn,
  onHostP2PRoom,
  onJoinP2PRoom,
  onCreateManualOffer,
  onAcceptManualOffer,
  onAcceptManualAnswer,
}) => {
  const [setupOpen, setSetupOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [p2pOpen, setP2pOpen] = useState(false);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [sdpInput, setSdpInput] = useState("");
  const [generatedToken, setGeneratedToken] = useState("");
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [sdpBusy, setSdpBusy] = useState(false);

  const traceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const traceHistoryRef = useRef<
    Array<{ thr: number; brk: number; clt: number; ffb: number }>
  >([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    if (roomParam && roomParam.trim().length >= 3) {
      const normalized = roomParam
        .trim()
        .replace(/^RWA-/i, "")
        .toUpperCase()
        .slice(0, 6);
      if (normalized.length >= 3) {
        setRoomCodeInput(normalized);
        setP2pOpen(true);
        onJoinP2PRoom?.(normalized);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hist = traceHistoryRef.current;
    hist.push({
      thr: telemetry.throttle,
      brk: telemetry.brake,
      clt: telemetry.clutch ?? 0,
      ffb: Math.abs(telemetry.ffbTorqueNorm ?? 0),
    });
    if (hist.length > 72) hist.shift();

    const canvas = traceCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Subtle horizontal grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (const gy of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, h * gy);
      ctx.lineTo(w, h * gy);
      ctx.stroke();
    }

    const drawLine = (
      key: "thr" | "brk" | "clt" | "ffb",
      color: string,
      width: number
    ) => {
      if (hist.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const x = (i / 71) * w;
        const y = h - 2 - hist[i][key] * (h - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    drawLine("clt", "#38bdf8", 1.2);
    drawLine("ffb", "#a855f7", 1.2);
    drawLine("brk", "#E10600", 1.8);
    drawLine("thr", "#00D26A", 1.8);
  }, [telemetry.throttle, telemetry.brake, telemetry.clutch, telemetry.ffbTorqueNorm]);

  const currentTurnMeta =
    TURN_METADATA.find((t) => t.number === telemetry.currentTurnNumber) || null;

  const rpmFraction = Math.min(
    1,
    Math.max(0, (telemetry.rpm - 4500) / (12800 - 4500))
  );
  const activeLedCount = Math.round(rpmFraction * 15);
  const tireInfo = TIRE_BADGE[tireCompound];

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-3 sm:p-4 select-none">
      {/* =====================================================================
          TOP ROW: Official F1TV Timing Tower (Left) | F1TV Race Control Bar (Center) | F1.com Circuit Map (Right)
      ===================================================================== */}
      <div className="flex flex-nowrap items-start justify-between gap-2.5">
        {/* TOP-LEFT: OFFICIAL F1TV TIMING TOWER & EVENT GRAPHIC */}
        <div className="pointer-events-auto f1-panel f1-corner-tr flex flex-col w-[292px] shrink-0 rounded-tl-md rounded-bl-md rounded-br-md overflow-hidden">
          {/* Official F1 Crimson Header Bar */}
          <div className="flex items-center justify-between bg-[#E10600] px-3 py-1.5 text-white">
            <div className="flex items-center gap-2">
              {/* Iconic F1 Speed-Mark SVG */}
              <svg
                viewBox="0 0 64 24"
                className="h-4 w-10 fill-current text-white"
                aria-hidden="true"
              >
                <path d="M4 20 L18 4 H36 L31 9.5 H20.5 L17.5 13 H28 L23.5 18 H13 L11.2 20 Z" />
                <path d="M35 20 L49 4 H55 L41 20 Z" />
                <path d="M51 20 L59 11 H63 L55 20 Z" />
              </svg>
              <div className="leading-none">
                <div className="font-f1-italic text-xs tracking-wider uppercase">
                  RWANDA GP 2029
                </div>
                <div className="font-f1-mono text-[9px] font-bold text-white/90">
                  FIA 2026 REGS • BUGESERA
                </div>
              </div>
            </div>
            <div className="bg-[#15151E] px-2 py-0.5 font-f1-display text-[11px] font-black tracking-wider text-white">
              LAP {telemetry.lapCount}
            </div>
          </div>

          {/* F1TV Driver Leaderboard Strip */}
          <div className="flex items-center justify-between border-b border-white/10 bg-[#15151E] px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center bg-white font-f1-italic text-xs font-black text-[#15151E]">
                1
              </span>
              <span
                className="h-5 w-1.5"
                style={{ backgroundColor: selectedLivery.primary }}
              />
              <span className="font-f1-display text-sm font-black tracking-wider text-white">
                RWA
              </span>
              <span className="font-f1-mono text-xs font-bold text-zinc-400">
                #{selectedLivery.number}
              </span>
            </div>

            <div className="flex items-center gap-2.5">
              {/* Official Pirelli Compound Circle */}
              <div
                className="flex h-5 w-5 items-center justify-center rounded-full border-2 bg-[#0B0B10] font-f1-display text-[10px] font-black text-white"
                style={{ borderColor: tireInfo.ringColor }}
                title={tireInfo.label}
              >
                {tireInfo.letter}
              </div>
              <span className="font-f1-mono text-sm font-extrabold text-white">
                {formatLapTime(telemetry.currentLapTimeMs)}
              </span>
            </div>
          </div>

          {/* Live Multiplayer / AI Opponent Standings Strip */}
          {(telemetry.peers ?? []).length > 0 ? (
            <div className="flex flex-col divide-y divide-white/5 border-b border-white/10 bg-[#0B0B10]/95 px-3 py-1">
              {(telemetry.peers ?? []).slice(0, 3).map((peer, idx) => (
                <div
                  key={peer.peerId}
                  className="flex items-center justify-between py-0.5 text-[10px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-4 w-4 items-center justify-center bg-zinc-800 font-f1-italic text-[9px] font-bold text-zinc-300">
                      {idx + 2}
                    </span>
                    <span
                      className="h-3.5 w-1"
                      style={{ backgroundColor: peer.teamColorHex }}
                    />
                    <span className="font-f1-display text-[11px] font-extrabold tracking-wider text-zinc-100">
                      {peer.driverCode}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-f1-mono text-[10px]">
                    <span className="text-zinc-500">
                      {Math.round(peer.speedKmh)} km/h
                    </span>
                    <span
                      className={`font-bold ${
                        peer.gapSeconds >= 0
                          ? "text-[#FFD700]"
                          : "text-[#00D26A]"
                      }`}
                    >
                      {peer.gapSeconds >= 0
                        ? `+${peer.gapSeconds.toFixed(2)}s`
                        : `${peer.gapSeconds.toFixed(2)}s`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {/* F1TV 3-Sector Status Bars + Last / Best Lap */}
          <div className="grid grid-cols-3 gap-1 border-b border-white/10 bg-[#0B0B10] px-3 py-1.5">
            {[1, 2, 3].map((sec) => {
              const isCurrent = telemetry.currentSector === sec;
              const hasBest = (telemetry.bestSectorTimesMs?.[sec - 1] ?? null) !== null;
              return (
                <div key={sec} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between font-f1-mono text-[9px] font-bold">
                    <span className="text-zinc-400">S{sec}</span>
                    <span
                      className={
                        isCurrent
                          ? "text-[#00D26A]"
                          : hasBest
                            ? "text-[#B138FF]"
                            : "text-zinc-500"
                      }
                    >
                      {isCurrent ? "LIVE" : hasBest ? "FAST" : "---"}
                    </span>
                  </div>
                  <div
                    className={`h-1.5 w-full ${
                      isCurrent
                        ? "bg-[#00D26A]"
                        : hasBest
                          ? "bg-[#B138FF]"
                          : "bg-zinc-800"
                    }`}
                  />
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-1.5 border-b border-white/10 bg-[#15151E]/90 px-3 py-1.5 text-center">
            <div className="flex items-center justify-between bg-[#0B0B10] px-2 py-1">
              <span className="font-f1-italic text-[9px] uppercase text-zinc-400">
                LAST
              </span>
              <span className="font-f1-mono text-[11px] font-bold text-zinc-200">
                {formatLapTime(telemetry.lastLapTimeMs)}
              </span>
            </div>
            <div className="flex items-center justify-between bg-[#B138FF]/20 border border-[#B138FF]/50 px-2 py-1">
              <span className="font-f1-italic text-[9px] uppercase text-[#d896ff]">
                BEST
              </span>
              <span className="font-f1-mono text-[11px] font-extrabold text-white">
                {formatLapTime(telemetry.bestLapTimeMs)}
              </span>
            </div>
          </div>

          {/* 1,400m Altitude & Top Speed Telemetry Strip */}
          <div className="flex items-center justify-between border-b border-white/10 bg-[#0B0B10] px-3 py-1.5 text-[10px]">
            <div>
              <span className="block font-f1-italic text-[9px] uppercase text-zinc-400">
                ALTITUDE / AIR DENSITY
              </span>
              <span className="font-f1-mono font-bold text-[#FFD700]">
                {(telemetry.altitudeM ?? 1400).toFixed(0)}m (ρ=
                {(telemetry.airDensityKgM3 ?? 1.045).toFixed(3)})
              </span>
            </div>
            <div className="text-right">
              <span className="block font-f1-italic text-[9px] uppercase text-zinc-400">
                TOP SPEED / AERO LOAD
              </span>
              <span className="font-f1-mono font-bold text-[#00D2BE]">
                {(telemetry.allTimeTopSpeedKmh ?? telemetry.speedKmh).toFixed(0)} km/h •{" "}
                {telemetry.downforceKgf.toFixed(0)} kgf
              </span>
            </div>
          </div>

          {/* Live Corner / Complex Broadcast Callout */}
          <div className="bg-[#15151E] px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="font-f1-italic text-[10px] uppercase tracking-wider text-[#E10600]">
                {currentTurnMeta
                  ? `SECTOR ${currentTurnMeta.sector} • ${currentTurnMeta.complexName}`
                  : `SECTOR ${telemetry.currentSector} • X-MODE ZONE`}
              </span>
              {Math.abs(telemetry.bankingDeg ?? 0) > 1.2 ? (
                <span className="bg-[#FFD700] px-1.5 py-0.2 font-f1-mono text-[9px] font-black text-[#15151E]">
                  {Math.abs(telemetry.bankingDeg ?? 0).toFixed(1)}° BANKED
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 font-f1-display text-xs font-extrabold uppercase text-white truncate">
              {telemetry.currentTurnName ?? "Main Straight"}
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-zinc-400 line-clamp-2">
              {currentTurnMeta
                ? currentTurnMeta.description
                : "Thin 1,400m altitude air (ρ≈1.07, −13% drag) lets the VF26 reach ≈330 km/h in 2026 X-Mode."}
            </p>
          </div>
        </div>

        {/* TOP-CENTER: F1TV PRO RACE CONTROL & SETUP BAR */}
        <div className="pointer-events-auto flex max-w-[740px] flex-1 flex-col items-center gap-2">
          <div className="f1-panel flex flex-wrap items-center justify-center gap-1.5 rounded-md border-t-2 border-t-[#E10600] px-2.5 py-1.5">
            {/* Manual Drive vs AI Hotlap Toggle */}
            <button
              type="button"
              onClick={onToggleAiAutopilot}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                !telemetry.aiAutopilot
                  ? "bg-[#00D26A] text-[#0B0B10] font-black shadow-[0_0_12px_rgba(0,210,106,0.45)]"
                  : "bg-amber-500/20 text-amber-300 border border-amber-400/50 hover:bg-amber-500/30"
              }`}
              title="Toggle Pure Manual Driving vs AI Demo Hotlap (Key: P)"
            >
              <Cpu className="h-3.5 w-3.5" />
              {telemetry.aiAutopilot ? "AI DEMO (CLICK FOR MANUAL)" : "MANUAL SIM"}
            </button>

            {/* Overtake Boost Latch Button */}
            <button
              type="button"
              onClick={onToggleBoostLatch}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                telemetry.manualOverrideActive || boostLatch
                  ? "bg-[#B138FF] text-white font-black shadow-[0_0_14px_rgba(177,56,255,0.65)]"
                  : "bg-white/10 text-white hover:bg-[#B138FF]/40"
              }`}
              title="Toggle 350kW MGU-K Overtake Boost (Hold SPACE / SHIFT, Press B, or Type /boost)"
            >
              <Zap className="h-3.5 w-3.5 text-[#FFD700]" />
              /BOOST (SPACE/B)
            </button>

            {/* 1:1 Analog Mouse Steer Toggle */}
            {onToggleMouseSteer ? (
              <button
                type="button"
                onClick={onToggleMouseSteer}
                className={`flex items-center gap-1 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                  mouseSteerEnabled
                    ? "bg-[#00D26A] text-[#0B0B10] font-black shadow-[0_0_12px_rgba(0,210,106,0.45)]"
                    : "bg-white/10 text-white hover:bg-white/20"
                }`}
                title="Toggle 1:1 iRacing Analog Mouse Steering (Key: V)"
              >
                <Gauge className="h-3.5 w-3.5 text-[#00D26A]" />
                {mouseSteerEnabled ? "MOUSE STEER ON (V)" : "MOUSE STEER (V)"}
              </button>
            ) : null}

            {/* Camera Mode Cycle */}
            <button
              type="button"
              onClick={() => {
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
                  modes[(modes.indexOf(cameraMode) + 1) % modes.length];
                onChangeCameraMode(next);
              }}
              className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider text-white hover:bg-[#E10600] transition-all cursor-pointer"
              title="Cycle F1TV & Assetto Corsa Trackside Broadcast Cameras (Key: C)"
            >
              <Camera className="h-3.5 w-3.5 text-[#E10600]" />
              CAM: {CAMERA_LABELS[cameraMode]} (C)
            </button>

            {/* Ideal Racing Line Toggle */}
            <button
              type="button"
              onClick={onToggleRacingLine}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                showRacingLine
                  ? "bg-[#00D2BE]/20 text-[#00D2BE] border border-[#00D2BE]/50"
                  : "bg-white/10 text-zinc-400 hover:bg-white/20"
              }`}
              title="Toggle 3D Ideal Racing Line (Key: R)"
            >
              <Compass className="h-3.5 w-3.5" />
              LINE (R)
            </button>

            {/* Real F1 Audio Toggle */}
            <button
              type="button"
              onClick={onToggleMute}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                !isMuted
                  ? "bg-[#E10600] text-white"
                  : "bg-white/10 text-zinc-400 hover:bg-white/20"
              }`}
              title="Toggle Real Recorded F1 Engine Audio (Key: M)"
            >
              {isMuted ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
              {isMuted ? "MUTED (M)" : "REAL F1 SOUND (M)"}
            </button>

            {/* Standing Grid Start */}
            <button
              type="button"
              onClick={() => onResetCar(false)}
              className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider text-white hover:bg-white/20 transition-all cursor-pointer"
              title="Standing Grid Start (0 km/h on Main Straight)"
            >
              <Flag className="h-3.5 w-3.5 text-[#FFD700]" />
              Grid Start
            </button>

            {/* Flying Lap Reset */}
            <button
              type="button"
              onClick={() => onResetCar(true)}
              className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider text-white hover:bg-white/20 transition-all cursor-pointer"
              title="Reset to 270 km/h Flying Start on Main Straight (Key: Backspace)"
            >
              <RotateCcw className="h-3.5 w-3.5 text-[#00D26A]" />
              Flying Lap
            </button>

            {/* 2026 Garage Setup Drawer */}
            <button
              type="button"
              onClick={() => {
                setSetupOpen((prev) => !prev);
                setGuideOpen(false);
                setP2pOpen(false);
              }}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                setupOpen
                  ? "bg-[#E10600] text-white"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              <Settings2 className="h-3.5 w-3.5" />
              2026 Setup
              {setupOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>

            {/* Track Corner Teleport Menu */}
            <button
              type="button"
              onClick={() => {
                setGuideOpen((prev) => !prev);
                setSetupOpen(false);
                setP2pOpen(false);
              }}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                guideOpen
                  ? "bg-[#FFD700] text-[#15151E]"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              <MapPin className="h-3.5 w-3.5" />
              Corners
            </button>

            {/* Serverless WebRTC P2P Multiplayer Modal Button */}
            <button
              type="button"
              onClick={() => {
                setP2pOpen((prev) => !prev);
                setSetupOpen(false);
                setGuideOpen(false);
              }}
              className={`flex items-center gap-1 rounded px-2.5 py-1 font-f1-italic text-xs uppercase tracking-wider transition-all cursor-pointer ${
                p2pOpen
                  ? "bg-[#00D2BE] text-[#0B0B10] font-black"
                  : p2pStatus?.state === "connected"
                    ? "bg-[#00D26A]/25 text-[#00D26A] border border-[#00D26A]/60"
                    : "bg-white/10 text-white hover:bg-white/20"
              }`}
              title="Serverless WebRTC Peer-to-Peer Multiplayer (Room Code + Manual SDP + BroadcastChannel)"
            >
              <Radio className="h-3.5 w-3.5 text-[#00D2BE]" />
              P2P MULTIPLAYER
              {p2pStatus && p2pStatus.connectedWebRtcPeers > 0 ? (
                <span className="ml-0.5 rounded bg-[#00D26A] px-1 text-[9px] font-black text-[#0B0B10]">
                  {p2pStatus.connectedWebRtcPeers}
                </span>
              ) : null}
            </button>
          </div>

          {/* COLLAPSIBLE 2026 GARAGE & AERO SETUP PANEL */}
          {setupOpen ? (
            <div className="f1-panel f1-corner-tr w-[360px] sm:w-[460px] rounded-md p-4 text-xs text-white">
              <div className="mb-3 flex items-center justify-between border-b border-white/15 pb-2">
                <span className="font-f1-italic text-sm uppercase tracking-wider text-[#E10600] flex items-center gap-1.5">
                  <Wind className="h-4 w-4" />
                  2026 F1 AERO & POWERTRAIN SETUP (1,400M)
                </span>
                <span className="font-f1-mono text-[10px] text-zinc-400">
                  768 KG • ~540KW ICE + 350KW MGU-K
                </span>
              </div>

              <div className="mb-3">
                <label className="mb-1 block font-f1-italic text-[11px] uppercase text-zinc-300">
                  Aerodynamic Downforce Package:
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      {
                        id: "low_downforce",
                        title: "Low Downforce",
                        sub: "≈338 km/h X-Mode • Low Drag",
                      },
                      {
                        id: "balanced",
                        title: "Balanced ★",
                        sub: "≈331 km/h X-Mode",
                      },
                      {
                        id: "high_downforce",
                        title: "High Downforce",
                        sub: "≈324 km/h X-Mode • Max Grip",
                      },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onChangeAeroPreset(item.id)}
                      className={`rounded border p-2 text-left transition-all cursor-pointer ${
                        aeroPreset === item.id
                          ? "border-[#E10600] bg-[#E10600]/20 text-white"
                          : "border-white/10 bg-[#0B0B10] text-zinc-400 hover:bg-white/5"
                      }`}
                    >
                      <div className="font-f1-italic text-[11px] uppercase">
                        {item.title}
                      </div>
                      <div className="font-f1-mono text-[9px] opacity-80">
                        {item.sub}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block font-f1-italic text-[11px] uppercase text-zinc-300">
                    Pirelli Tire Compound:
                  </label>
                  <div className="grid grid-cols-3 gap-1">
                    {(["soft", "medium", "hard"] as const).map((comp) => (
                      <button
                        key={comp}
                        type="button"
                        onClick={() => onChangeTireCompound(comp)}
                        className={`rounded border py-1.5 font-f1-italic text-[10px] uppercase cursor-pointer ${
                          tireCompound === comp
                            ? "border-[#E10600] bg-[#E10600] text-white"
                            : "border-white/10 bg-[#0B0B10] text-zinc-400"
                        }`}
                      >
                        {comp}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block font-f1-italic text-[11px] uppercase text-zinc-300">
                    Traction & ABS (No Auto-Steer):
                  </label>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { id: "pro", label: "Sim Raw" },
                        { id: "semi_pro", label: "TC+ABS" },
                        { id: "assisted", label: "Full" },
                      ] as const
                    ).map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => onChangeAssistPreset(a.id)}
                        className={`rounded border py-1.5 font-f1-italic text-[10px] uppercase cursor-pointer ${
                          assistPreset === a.id
                            ? "border-[#00D26A] bg-[#00D26A]/25 text-white"
                            : "border-white/10 bg-[#0B0B10] text-zinc-400"
                        }`}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-1 block font-f1-italic text-[11px] uppercase text-zinc-300">
                  2026 Showcar Team Livery:
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {LIVERIES.map((liv) => (
                    <button
                      key={liv.id}
                      type="button"
                      onClick={() => onChangeLivery(liv)}
                      className={`flex flex-col items-center rounded p-1.5 border font-f1-mono text-[9px] font-bold cursor-pointer ${
                        selectedLivery.id === liv.id
                          ? "border-[#E10600] bg-white/15 text-white"
                          : "border-white/10 bg-[#0B0B10] text-zinc-400"
                      }`}
                    >
                      <span
                        className="mb-1 h-3 w-full"
                        style={{
                          background: `linear-gradient(90deg, ${liv.primary} 50%, ${liv.secondary} 50%)`,
                        }}
                      />
                      <span>#{liv.number}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {/* COLLAPSIBLE CORNER TELEPORT & CIRCUIT GUIDE */}
          {guideOpen ? (
            <div className="f1-panel f1-corner-tr w-[360px] sm:w-[460px] rounded-md p-3.5 text-xs">
              <div className="mb-2 flex items-center justify-between border-b border-white/15 pb-1.5">
                <span className="font-f1-italic text-xs uppercase tracking-wider text-[#FFD700]">
                  TELEPORT TO RWANDA GP SIGNATURE SECTORS
                </span>
                <span className="font-f1-mono text-[10px] text-zinc-400">
                  INSTANT PRACTICE
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {[
                  {
                    title: "Main Straight (Flying)",
                    sub: "+35m • X-Mode Zone",
                    action: () => onResetCar(true),
                  },
                  {
                    title: "Rwanda Sling (T1–T3)",
                    sub: "+35m • 6° Banked Exit",
                    action: () => onSelectTurn(1),
                  },
                  {
                    title: "The Arena (T4–T6)",
                    sub: "+0m Lowest • 6° Banked",
                    action: () => onSelectTurn(4),
                  },
                  {
                    title: "1000 Hills (T7–T12)",
                    sub: "+36m Technical Infield",
                    action: () => onSelectTurn(7),
                  },
                  {
                    title: "Bugesera Hairpin (T15)",
                    sub: "+33m Trail-Brake Test",
                    action: () => onSelectTurn(15),
                  },
                  {
                    title: "Summit Crest (T16–T18)",
                    sub: "+50m Peak • RwandAir Esses",
                    action: () => onSelectTurn(16),
                  },
                ].map((sec) => (
                  <button
                    key={sec.title}
                    type="button"
                    onClick={() => {
                      sec.action();
                      setGuideOpen(false);
                    }}
                    className="rounded border border-white/10 bg-[#0B0B10] p-2 text-left hover:border-[#E10600] hover:bg-[#15151E] transition-all cursor-pointer"
                  >
                    <div className="font-f1-italic text-white text-[11px]">
                      {sec.title}
                    </div>
                    <div className="font-f1-mono text-[9px] text-zinc-400">
                      {sec.sub}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* COLLAPSIBLE SERVERLESS WEBRTC P2P MULTIPLAYER PANEL */}
          {p2pOpen ? (
            <div className="f1-panel f1-corner-tr w-[370px] sm:w-[480px] rounded-md p-3.5 text-xs text-white">
              <div className="mb-2 flex items-center justify-between border-b border-white/15 pb-1.5">
                <span className="font-f1-italic text-xs uppercase tracking-wider text-[#00D2BE] flex items-center gap-1.5">
                  <Radio className="h-3.5 w-3.5" />
                  SERVERLESS WEBRTC P2P MULTIPLAYER (100% FREE FOREVER)
                </span>
                <span className="font-f1-mono text-[10px] text-[#00D26A]">
                  STUN: Google 19302 • 25 Hz UDP
                </span>
              </div>

              {/* Live P2P Status Banner */}
              <div className="mb-2.5 flex items-center justify-between rounded border border-white/10 bg-[#0B0B10] px-2.5 py-1.5 font-f1-mono text-[10px]">
                <span className="text-zinc-300 truncate">
                  {p2pStatus?.statusText ??
                    "BroadcastChannel Active (Same-Browser) • Ready for WebRTC P2P"}
                </span>
                <span
                  className={`ml-2 shrink-0 rounded px-1.5 py-0.5 font-bold uppercase ${
                    p2pStatus?.state === "connected"
                      ? "bg-[#00D26A]/25 text-[#00D26A]"
                      : p2pStatus?.state === "signaling"
                        ? "bg-[#FFD700]/25 text-[#FFD700]"
                        : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {p2pStatus?.connectedWebRtcPeers ?? 0} WEBRTC PEERS
                </span>
              </div>

              {/* 1. 6-Character Room Code Mode */}
              <div className="mb-2.5 rounded border border-white/10 bg-[#15151E]/90 p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-f1-italic text-[11px] uppercase text-white">
                    1. 6-Character Room Code (Public WebRTC Broker)
                  </span>
                  {p2pStatus?.roomCode ? (
                    <span className="rounded bg-[#E10600] px-2 py-0.5 font-f1-mono text-[11px] font-black tracking-widest text-white">
                      ROOM: {p2pStatus.roomCode}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const code = onHostP2PRoom?.(roomCodeInput || undefined);
                      if (code) setRoomCodeInput(code);
                    }}
                    className="rounded bg-[#E10600] px-2.5 py-1.5 font-f1-italic text-[10px] uppercase tracking-wider text-white hover:bg-[#ff1e18] cursor-pointer shrink-0"
                  >
                    Host Room
                  </button>
                  <input
                    type="text"
                    maxLength={6}
                    value={roomCodeInput}
                    onChange={(e) =>
                      setRoomCodeInput(e.target.value.toUpperCase())
                    }
                    placeholder="6-CHAR CODE"
                    className="w-28 rounded border border-white/20 bg-[#0B0B10] px-2 py-1 font-f1-mono text-xs font-bold uppercase tracking-widest text-white placeholder:text-zinc-600 focus:border-[#00D2BE] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (roomCodeInput.trim().length >= 3) {
                        onJoinP2PRoom?.(roomCodeInput.trim());
                      }
                    }}
                    className="rounded bg-[#00D2BE] px-2.5 py-1.5 font-f1-italic text-[10px] font-black uppercase tracking-wider text-[#0B0B10] hover:opacity-90 cursor-pointer shrink-0"
                  >
                    Join Room
                  </button>
                  <button
                    type="button"
                    disabled={!(p2pStatus?.roomCode || roomCodeInput.trim())}
                    onClick={() => {
                      const activeCode = (
                        p2pStatus?.roomCode || roomCodeInput.trim()
                      )
                        .replace(/^RWA-/i, "")
                        .toUpperCase();
                      if (!activeCode || typeof window === "undefined") return;
                      const url = `${window.location.origin}${window.location.pathname}?room=RWA-${activeCode}`;
                      navigator.clipboard?.writeText(url);
                      setCopiedLink(true);
                      setTimeout(() => setCopiedLink(false), 2000);
                    }}
                    className="rounded border border-white/20 bg-white/10 px-2 py-1.5 font-f1-italic text-[10px] uppercase tracking-wider text-white hover:bg-white/20 disabled:opacity-40 cursor-pointer shrink-0"
                  >
                    {copiedLink ? "Link Copied!" : "Copy Invite"}
                  </button>
                </div>
              </div>

              {/* 2. Manual Copy-Paste SDP Offer/Answer Fallback */}
              <div className="rounded border border-white/10 bg-[#15151E]/90 p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-f1-italic text-[11px] uppercase text-[#FFD700]">
                    2. Zero-Broker Manual SDP Copy-Paste Fallback
                  </span>
                  <span className="font-f1-mono text-[9px] text-zinc-400">
                    100% SERVERLESS
                  </span>
                </div>

                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={sdpBusy}
                    onClick={async () => {
                      if (!onCreateManualOffer) return;
                      setSdpBusy(true);
                      try {
                        const offer = await onCreateManualOffer();
                        if (offer) setGeneratedToken(offer);
                      } finally {
                        setSdpBusy(false);
                      }
                    }}
                    className="rounded border border-[#00D2BE]/50 bg-[#00D2BE]/15 px-2 py-1 font-f1-italic text-[10px] uppercase text-[#00D2BE] hover:bg-[#00D2BE]/25 cursor-pointer"
                  >
                    Step 1: Generate Offer (Host)
                  </button>

                  <button
                    type="button"
                    disabled={sdpBusy || !sdpInput.trim()}
                    onClick={async () => {
                      if (!onAcceptManualOffer || !sdpInput.trim()) return;
                      setSdpBusy(true);
                      try {
                        const ans = await onAcceptManualOffer(sdpInput.trim());
                        if (ans) setGeneratedToken(ans);
                      } finally {
                        setSdpBusy(false);
                      }
                    }}
                    className="rounded border border-[#FFD700]/50 bg-[#FFD700]/15 px-2 py-1 font-f1-italic text-[10px] uppercase text-[#FFD700] hover:bg-[#FFD700]/25 cursor-pointer"
                  >
                    Step 2: Paste Offer → Get Answer
                  </button>

                  <button
                    type="button"
                    disabled={sdpBusy || !sdpInput.trim()}
                    onClick={async () => {
                      if (!onAcceptManualAnswer || !sdpInput.trim()) return;
                      setSdpBusy(true);
                      try {
                        await onAcceptManualAnswer(sdpInput.trim());
                      } finally {
                        setSdpBusy(false);
                      }
                    }}
                    className="rounded border border-[#00D26A]/50 bg-[#00D26A]/20 px-2 py-1 font-f1-italic text-[10px] uppercase text-[#00D26A] hover:bg-[#00D26A]/30 cursor-pointer"
                  >
                    Step 3: Accept Answer (Host)
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-1.5">
                  <input
                    type="text"
                    value={sdpInput}
                    onChange={(e) => setSdpInput(e.target.value)}
                    placeholder="Paste remote SDP Offer or Answer token here..."
                    className="w-full rounded border border-white/15 bg-[#0B0B10] px-2 py-1 font-f1-mono text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-[#00D2BE] focus:outline-none"
                  />

                  {generatedToken ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        readOnly
                        value={generatedToken}
                        className="flex-1 rounded border border-[#00D26A]/50 bg-[#0B0B10] px-2 py-1 font-f1-mono text-[10px] text-[#00D26A]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(generatedToken);
                          setCopiedToken(true);
                          setTimeout(() => setCopiedToken(false), 1800);
                        }}
                        className="flex items-center gap-1 rounded bg-[#00D26A] px-2 py-1 font-f1-italic text-[10px] font-black uppercase text-[#0B0B10] cursor-pointer"
                      >
                        {copiedToken ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        {copiedToken ? "Copied" : "Copy SDP"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* TOP-RIGHT: OFFICIAL F1.COM CIRCUIT MAP & ELEVATION PROFILE */}
        <div className="pointer-events-auto hidden md:block">
          <TrackMinimap
            track={track}
            telemetry={telemetry}
            onSelectTurn={onSelectTurn}
          />
        </div>
      </div>

      {/* =====================================================================
          BOTTOM ROW: Controls Legend (Left) | Official F1TV Onboard Halo Telemetry Pod (Center) | Tire & G-Force Matrix (Right)
      ===================================================================== */}
      <div className="flex flex-nowrap items-end justify-between gap-2">
        {/* BOTTOM-LEFT: F1TV CONTROLS & 2026 REGULATIONS LEGEND */}
        <div className="pointer-events-auto hidden lg:flex flex-col gap-1 f1-panel f1-corner-tr rounded-tl-md rounded-bl-md rounded-br-md p-2.5 w-[250px] shrink-0 text-[11px]">
          <div className="flex items-center gap-1.5 font-f1-italic text-xs uppercase tracking-wider text-white border-b border-white/15 pb-1">
            <HelpCircle className="h-3.5 w-3.5 text-[#E10600]" />
            SIM CONTROLS & BOOST
          </div>
          <div className="grid grid-cols-2 gap-y-0.5 font-f1-mono text-[9.5px] text-zinc-300 whitespace-nowrap">
            <span className="text-zinc-400">THROTTLE / BRAKE:</span>
            <span className="font-bold text-white text-right">
              W / S or ↑ / ↓
            </span>
            <span className="text-zinc-400">STEER L / R:</span>
            <span className="font-bold text-white text-right">
              A / D or ← / →
            </span>
            <span className="text-zinc-400">1:1 MOUSE STEER:</span>
            <span className="font-bold text-[#00D26A] text-right">
              V KEY (SIM)
            </span>
            <span className="text-zinc-400">350KW /BOOST:</span>
            <span className="font-bold text-[#B138FF] text-right">
              SPACE / B / /BOOST
            </span>
            <span className="text-zinc-400">ACTIVE AERO X/Z:</span>
            <span className="font-bold text-[#00D26A] text-right">X KEY</span>
            <span className="text-zinc-400">SHIFT UP / DOWN:</span>
            <span className="font-bold text-[#00D2BE] text-right">E / Q</span>
            <span className="text-zinc-400">CAMERA / FLYING:</span>
            <span className="font-bold text-white text-right">C / BKSP</span>
          </div>
        </div>

        {/* BOTTOM-CENTER: AUTHENTIC F1TV ONBOARD HALO TELEMETRY CLUSTER */}
        <div className="pointer-events-auto mx-auto flex flex-col items-center shrink-0">
          <div className="f1-panel relative flex flex-col gap-1.5 rounded-t-2xl rounded-b-lg border-t-3 border-t-[#E10600] px-4 py-2.5 shadow-2xl w-[516px]">
            {/* 15-LED F1 Steering Wheel RPM Shift Light Bar */}
            <div className="flex items-center justify-between gap-1">
              {Array.from({ length: 15 }).map((_, i) => {
                const active = i < activeLedCount;
                const colorClass =
                  i < 5
                    ? active
                      ? "bg-[#00D26A] shadow-[0_0_8px_#00D26A]"
                      : "bg-zinc-800/80"
                    : i < 10
                      ? active
                        ? "bg-[#E10600] shadow-[0_0_8px_#E10600]"
                        : "bg-zinc-800/80"
                      : active
                        ? "bg-[#B138FF] shadow-[0_0_10px_#B138FF]"
                        : "bg-zinc-800/80";
                return (
                  <div
                    key={i}
                    className={`h-2 flex-1 rounded-xs transition-all duration-75 ${colorClass}`}
                  />
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2.5 whitespace-nowrap">
              {/* LEFT WING: F1TV Throttle & Brake Telemetry Bars + 2026 Active Aero Badge */}
              <div className="flex items-center gap-2">
                <div className="flex items-end gap-1 h-12">
                  {/* Brake Bar (#E10600) */}
                  <div className="flex flex-col items-center gap-0.5 h-full">
                    <div className="relative w-2.5 flex-1 overflow-hidden bg-zinc-900 border border-white/10">
                      <div
                        className="absolute bottom-0 left-0 right-0 bg-[#E10600] transition-all duration-75"
                        style={{
                          height: `${Math.round(telemetry.brake * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="font-f1-display text-[8px] font-black text-[#E10600]">
                      BRK
                    </span>
                  </div>

                  {/* Throttle Bar (#00D26A) */}
                  <div className="flex flex-col items-center gap-0.5 h-full">
                    <div className="relative w-2.5 flex-1 overflow-hidden bg-zinc-900 border border-white/10">
                      <div
                        className="absolute bottom-0 left-0 right-0 bg-[#00D26A] transition-all duration-75"
                        style={{
                          height: `${Math.round(telemetry.throttle * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="font-f1-display text-[8px] font-black text-[#00D26A]">
                      THR
                    </span>
                  </div>
                </div>

                {/* 2026 Active Aerodynamics X-Mode / Z-Mode */}
                <button
                  type="button"
                  onClick={onToggleXMode}
                  className={`flex flex-col justify-center rounded border px-2 py-1 text-left transition-all cursor-pointer w-[166px] ${
                    telemetry.activeAeroMode === "X_MODE"
                      ? "border-[#00D26A] bg-[#00D26A]/20 text-white"
                      : "border-white/20 bg-[#0B0B10] text-zinc-200"
                  }`}
                >
                  <div className="flex items-center gap-1 font-f1-italic text-[8.5px] uppercase tracking-wider text-zinc-300">
                    <Gauge className="h-3 w-3 text-[#00D26A]" />
                    2026 ACTIVE AERO
                  </div>
                  <div className="font-f1-display text-[11px] font-black tracking-wide truncate">
                    {telemetry.activeAeroMode === "X_MODE"
                      ? "X-MODE (DRS LOW DRAG)"
                      : "Z-MODE (HIGH DOWNFORCE)"}
                  </div>
                  <div className="font-f1-mono text-[8.5px] text-zinc-400">
                    DF: {telemetry.downforceKgf.toFixed(0)}kg • DRG:{" "}
                    {telemetry.dragN.toFixed(0)}N
                  </div>
                </button>
              </div>

              {/* CENTER: GIANT F1TV SPEEDOMETER, RPM & GEAR BOX */}
              <div className="flex items-center gap-2.5">
                <div className="text-center w-[98px]">
                  <div className="font-f1-display text-4xl font-black leading-none tracking-tight text-white">
                    {Math.round(telemetry.speedKmh)}
                  </div>
                  <div className="mt-1 flex items-center justify-center gap-1 font-f1-mono text-[9.5px]">
                    <span className="font-bold text-zinc-400">KM/H</span>
                    <span className="text-zinc-600">•</span>
                    <span className="font-bold text-[#00D2BE]">
                      {telemetry.rpm.toLocaleString()} RPM
                    </span>
                  </div>
                </div>

                <div className="flex h-12 w-11 flex-col items-center justify-center rounded border-2 border-[#E10600] bg-[#0B0B10]">
                  <span className="font-f1-italic text-[8px] uppercase text-zinc-400">
                    GEAR
                  </span>
                  <span className="font-f1-display text-2xl font-black leading-none text-white">
                    {telemetry.gear}
                  </span>
                </div>
              </div>

              {/* RIGHT WING: 350kW MGU-K ERS BATTERY & MANUAL OVERRIDE BOOST */}
              <div className="hidden sm:flex flex-col justify-center gap-1 w-[144px]">
                <div className="flex items-center justify-between font-f1-italic text-[9.5px] uppercase">
                  <span className="flex items-center gap-1 text-[#00D2BE]">
                    <Zap className="h-3 w-3" />
                    MGU-K 350KW
                  </span>
                  <span
                    className={`font-f1-mono font-bold ${
                      telemetry.mgukPowerKw < 0
                        ? "text-[#FFD700]"
                        : "text-white"
                    }`}
                  >
                    {telemetry.mgukPowerKw >= 0
                      ? `+${telemetry.mgukPowerKw.toFixed(0)}kW`
                      : `${telemetry.mgukPowerKw.toFixed(0)}kW`}
                  </span>
                </div>

                {/* ERS Battery State of Charge Bar */}
                <div className="h-2.5 w-full overflow-hidden bg-zinc-900 border border-white/15 p-0.5">
                  <div
                    className={`h-full transition-all duration-150 ${
                      telemetry.manualOverrideActive || boostLatch
                        ? "bg-[#B138FF]"
                        : telemetry.mgukPowerKw < 0
                          ? "bg-[#FFD700]"
                          : "bg-[#00D26A]"
                    }`}
                    style={{
                      width: `${Math.round(telemetry.ersBatteryPercent)}%`,
                    }}
                  />
                </div>

                <div className="flex items-center justify-between text-[8.5px]">
                  <span className="font-f1-mono font-bold text-zinc-400">
                    SOC {telemetry.ersBatteryPercent.toFixed(0)}%
                  </span>
                  <button
                    type="button"
                    onClick={onToggleBoostLatch}
                    className={`px-1.5 py-0.5 font-f1-display text-[8px] font-black uppercase cursor-pointer transition-all ${
                      telemetry.manualOverrideActive || boostLatch
                        ? "bg-[#B138FF] text-white shadow-[0_0_10px_#B138FF]"
                        : "bg-zinc-800 text-zinc-300 hover:bg-[#B138FF]/40"
                    }`}
                  >
                    {telemetry.manualOverrideActive || boostLatch
                      ? "BOOST ON 350KW"
                      : "/BOOST (SPACE/B)"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* BOTTOM-RIGHT: SIM TELEMETRY POD — PEDAL TRACE, FFB CLIPPING, G-FORCE & 4-WHEEL CAR DIAGRAM */}
        <div className="pointer-events-auto hidden md:flex items-center gap-2.5 f1-panel f1-corner-tr rounded-tl-md rounded-bl-md rounded-br-md p-2.5 shrink-0">
          {/* Scrolling Pedal Input Trace (THR/BRK/CLT) + FFB Clipping Meter */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between font-f1-mono text-[8px] font-bold">
              <span className="text-[#00D26A]">THR</span>
              <span className="text-[#E10600]">BRK</span>
              <span className="text-[#38bdf8]">CLT</span>
              <span
                className={
                  telemetry.ffbClipping
                    ? "bg-[#E10600] px-1 text-white animate-pulse"
                    : "text-[#a855f7]"
                }
              >
                {telemetry.ffbClipping ? "FFB CLIP!" : "FFB"}
              </span>
            </div>
            <canvas
              ref={traceCanvasRef}
              width={116}
              height={46}
              className="rounded border border-white/15 bg-[#0B0B10]"
            />
            {/* Force-Feedback Self-Aligning Torque Bar */}
            <div className="flex items-center gap-1.5">
              <span className="font-f1-mono text-[8px] text-zinc-400">SAT</span>
              <div className="relative h-1.5 flex-1 overflow-hidden rounded bg-zinc-900 border border-white/10">
                <div
                  className={`h-full transition-all duration-75 ${
                    telemetry.ffbClipping
                      ? "bg-[#E10600]"
                      : Math.abs(telemetry.ffbTorqueNorm ?? 0) > 0.75
                        ? "bg-[#FFD700]"
                        : "bg-[#a855f7]"
                  }`}
                  style={{
                    width: `${Math.min(100, Math.round(Math.abs(telemetry.ffbTorqueNorm ?? 0) * 100))}%`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* G-Force & Pacejka Slip-Angle Meter */}
          <div className="flex flex-col items-center">
            <div className="relative h-14 w-14 rounded-full border border-white/20 bg-[#0B0B10]">
              <div className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
              <div className="absolute inset-y-0 left-1/2 w-px bg-white/10" />
              <div className="absolute inset-2.5 rounded-full border border-white/10" />
              <div
                className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#E10600] shadow-[0_0_8px_#E10600]"
                style={{
                  left: `${50 + Math.max(-42, Math.min(42, telemetry.lateralG * 9.5))}%`,
                  top: `${50 + Math.max(-42, Math.min(42, -telemetry.longitudinalG * 9.5))}%`,
                }}
              />
            </div>
            <span className="mt-1 font-f1-mono text-[9px] font-bold text-zinc-300">
              {Math.hypot(telemetry.lateralG, telemetry.longitudinalG).toFixed(1)}
              G • {(telemetry.verticalG ?? 1.0).toFixed(1)}Gz
            </span>
            <span className="font-f1-mono text-[8px] text-[#00D2BE]">
              αF:{(telemetry.frontSlipAngleDeg ?? 0).toFixed(1)}° αR:
              {(telemetry.rearSlipAngleDeg ?? 0).toFixed(1)}°
            </span>
          </div>

          {/* 4-Wheel Car Diagram with Live Tire Grip/Slip Color, Temp °C, Vertical Load Fz & Wear % (Reference Image 4) */}
          <div className="relative flex items-center gap-1.5 rounded border border-white/10 bg-[#0B0B10] px-2.5 py-1.5">
            {/* Left Wheels (FL / RL) */}
            <div className="flex flex-col justify-between gap-2 font-f1-mono text-[8px]">
              {([0, 2] as const).map((idx) => {
                const label = idx === 0 ? "FL" : "RL";
                const tTemp = Math.round(telemetry.tireTempsC[idx] || 92);
                const slip = Math.hypot(
                  telemetry.wheelSlipRatios?.[idx] ?? 0,
                  (telemetry.wheelSlipAnglesDeg?.[idx] ?? 0) / 8
                );
                const fzKn = ((telemetry.wheelLoadsN?.[idx] ?? 3200) / 1000).toFixed(1);
                const wear = Math.max(0, 100 - (telemetry.tireWearPct?.[idx] ?? 0)).toFixed(0);
                const boxColor =
                  slip > 0.85 || tTemp > 112
                    ? "border-[#E10600] bg-[#E10600]/25"
                    : slip > 0.45 || tTemp > 103
                      ? "border-[#FFD700] bg-[#FFD700]/20"
                      : "border-[#00D26A] bg-[#00D26A]/20";
                return (
                  <div
                    key={label}
                    className={`w-[62px] rounded border px-1.5 py-0.5 ${boxColor}`}
                  >
                    <div className="flex items-center justify-between font-bold text-white">
                      <span>{label}</span>
                      <span>{tTemp}°C</span>
                    </div>
                    <div className="flex items-center justify-between text-[7.5px] text-zinc-300">
                      <span>{fzKn}kN</span>
                      <span className="text-[#00D26A]">{wear}%</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Central F1 Chassis Silhouette (Reference Image 4) */}
            <div className="flex flex-col items-center justify-between h-14 w-5 py-0.5 opacity-85">
              <div className="h-1.5 w-4 rounded-xs bg-[#E10600]" />
              <div className="h-8 w-2.5 rounded-t-full bg-zinc-400" />
              <div className="h-2 w-4 rounded-xs bg-[#E10600]" />
            </div>

            {/* Right Wheels (FR / RR) */}
            <div className="flex flex-col justify-between gap-2 font-f1-mono text-[8px]">
              {([1, 3] as const).map((idx) => {
                const label = idx === 1 ? "FR" : "RR";
                const tTemp = Math.round(telemetry.tireTempsC[idx] || 92);
                const slip = Math.hypot(
                  telemetry.wheelSlipRatios?.[idx] ?? 0,
                  (telemetry.wheelSlipAnglesDeg?.[idx] ?? 0) / 8
                );
                const fzKn = ((telemetry.wheelLoadsN?.[idx] ?? 3200) / 1000).toFixed(1);
                const wear = Math.max(0, 100 - (telemetry.tireWearPct?.[idx] ?? 0)).toFixed(0);
                const boxColor =
                  slip > 0.85 || tTemp > 112
                    ? "border-[#E10600] bg-[#E10600]/25"
                    : slip > 0.45 || tTemp > 103
                      ? "border-[#FFD700] bg-[#FFD700]/20"
                      : "border-[#00D26A] bg-[#00D26A]/20";
                return (
                  <div
                    key={label}
                    className={`w-[62px] rounded border px-1.5 py-0.5 ${boxColor}`}
                  >
                    <div className="flex items-center justify-between font-bold text-white">
                      <span>{label}</span>
                      <span>{tTemp}°C</span>
                    </div>
                    <div className="flex items-center justify-between text-[7.5px] text-zinc-300">
                      <span>{fzKn}kN</span>
                      <span className="text-[#00D26A]">{wear}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

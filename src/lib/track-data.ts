import * as THREE from "three";
import {
  LiveryConfig,
  RunoffStyle,
  TrackControlPoint,
  TrackSamplePoint,
  TurnMetadata,
} from "@/types/f1";
import rawTrackJson from "../../public/tracks/rwanda/track_data.json";

export const BASE_ALTITUDE_M = 1385; // Bugesera baseline altitude (m ASL)
export const RWANDA_BASE_ALTITUDE_M = BASE_ALTITUDE_M;

export const TRACK_TOTAL_LENGTH_M = rawTrackJson.metadata.lengthMeters;
export const RWANDA_TARGET_LENGTH_M = TRACK_TOTAL_LENGTH_M;

export interface DrsZoneDef {
  id: string;
  detection: number;
  start: number;
  end: number;
}

export interface TracksideTvCameraDef {
  name: string;
  position: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  minFov: number;
  maxFov: number;
  inPoint: number;
  outPoint: number;
}

export interface BuiltTrackData {
  samples: TrackSamplePoint[];
  totalLengthM: number;
  totalLength: number;
  spline: THREE.CatmullRomCurve3;
  getSampleAtDistance: (s: number) => TrackSamplePoint;
  projectWorldToTrack: (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => {
    sample: TrackSamplePoint;
    s: number;
    lateralOffset: number;
    distSq: number;
  };
}

export const RWANDA_TRACK_METADATA = rawTrackJson.metadata;
export const RWANDA_DRS_ZONES: DrsZoneDef[] =
  rawTrackJson.drsZones as DrsZoneDef[];
export const RWANDA_TV_CAMERAS: TracksideTvCameraDef[] =
  rawTrackJson.cameras as TracksideTvCameraDef[];

export const LIVERIES: LiveryConfig[] = [
  {
    id: "rwanda_2026",
    name: "Visit Rwanda #26",
    team: "Kigali Apex Racing",
    primary: "#00a1de",
    secondary: "#0f172a",
    accent: "#fad201",
    number: "26",
  },
  {
    id: "scuderia_red",
    name: "Scuderia Corsa #16",
    team: "Maranello Works",
    primary: "#dc2626",
    secondary: "#18181b",
    accent: "#facc15",
    number: "16",
  },
  {
    id: "silver_arrow",
    name: "Silver Star #44",
    team: "Brackley Aero",
    primary: "#e2e8f0",
    secondary: "#0f172a",
    accent: "#06b6d4",
    number: "44",
  },
  {
    id: "papaya_apex",
    name: "Papaya Velocity #4",
    team: "Woking Motorsport",
    primary: "#f97316",
    secondary: "#1e293b",
    accent: "#38bdf8",
    number: "4",
  },
  {
    id: "carbon_stealth",
    name: "Stealth Bull #1",
    team: "Milton Keynes Racing",
    primary: "#1e1b4b",
    secondary: "#090d16",
    accent: "#ef4444",
    number: "1",
  },
];

export const TURN_METADATA: TurnMetadata[] = [
  {
    number: 1,
    name: "Turn 1 — Kigali Gateway",
    complexName: "Rwanda Sling (T1–T3)",
    sector: 1,
    elevationM: 35,
    bankingDeg: 2,
    apexSpeedKmh: 162,
    gear: 4,
    description:
      "Heavy braking from 340+ km/h at the end of the main straight into a tightening right-hander.",
    sApprox: 610,
  },
  {
    number: 2,
    name: "Turn 2 — Sling Switchback",
    complexName: "Rwanda Sling (T1–T3)",
    sector: 1,
    elevationM: 32,
    bankingDeg: 3,
    apexSpeedKmh: 188,
    gear: 4,
    description:
      "Quick left-hand direction change that sets up side-by-side racing lines into Turn 3.",
    sApprox: 820,
  },
  {
    number: 3,
    name: "Turn 3 — Banked Sling",
    complexName: "Rwanda Sling (T1–T3)",
    sector: 1,
    elevationM: 24,
    bankingDeg: 6,
    apexSpeedKmh: 242,
    gear: 6,
    description:
      "Sweeping 6° banked right-hander launching cars downhill toward The Arena at full throttle.",
    sApprox: 1050,
  },
  {
    number: 4,
    name: "Turn 4 — Arena Bowl",
    complexName: "The Arena (T4–T6)",
    sector: 1,
    elevationM: 4,
    bankingDeg: 6,
    apexSpeedKmh: 175,
    gear: 4,
    description:
      "At the lowest point of the track, a 6° banked right-hander after a fast downhill plunge.",
    sApprox: 1640,
  },
  {
    number: 5,
    name: "Turn 5 — Arena Infield",
    complexName: "The Arena (T4–T6)",
    sector: 1,
    elevationM: 8,
    bankingDeg: 2,
    apexSpeedKmh: 122,
    gear: 3,
    description:
      "Tight left-hand pivot inside the stadium section encouraging late-braking switchbacks.",
    sApprox: 1890,
  },
  {
    number: 6,
    name: "Turn 6 — Arena Exit",
    complexName: "The Arena (T4–T6)",
    sector: 1,
    elevationM: 12,
    bankingDeg: 6,
    apexSpeedKmh: 148,
    gear: 3,
    description:
      "Banked 6° right-hand exit critical for traction up the steep climb toward Sector 2.",
    sApprox: 2050,
  },
  {
    number: 7,
    name: "Turn 7 — Hills Gate",
    complexName: "Land of a Thousand Hills (T7–T12)",
    sector: 2,
    elevationM: 32,
    bankingDeg: 2,
    apexSpeedKmh: 205,
    gear: 5,
    description:
      "Blind uphill arrival into a fast right-hander opening the technical infield complex.",
    sApprox: 2480,
  },
  {
    number: 8,
    name: "Turn 8 — Savannah Curve",
    complexName: "Land of a Thousand Hills (T7–T12)",
    sector: 2,
    elevationM: 36,
    bankingDeg: 2,
    apexSpeedKmh: 195,
    gear: 5,
    description:
      "Flowing left-hander wrapping around the central hill where car placement is paramount.",
    sApprox: 2820,
  },
  {
    number: 9,
    name: "Turn 9 — Kigali Kink",
    complexName: "Land of a Thousand Hills (T7–T12)",
    sector: 2,
    elevationM: 34,
    bankingDeg: 1,
    apexSpeedKmh: 215,
    gear: 5,
    description:
      "High-commitment right-hand kink linking the infield switchbacks toward the paddock loop.",
    sApprox: 3040,
  },
  {
    number: 10,
    name: "Turn 10 — Paddock Loop",
    complexName: "Land of a Thousand Hills (T7–T12)",
    sector: 2,
    elevationM: 30,
    bankingDeg: 3,
    apexSpeedKmh: 145,
    gear: 3,
    description:
      "Long double-apex right-hander curling toward the downhill valley.",
    sApprox: 3250,
  },
  {
    number: 11,
    name: "Turn 11 — Ridge Left",
    complexName: "Land of a Thousand Hills (T7–T12)",
    sector: 2,
    elevationM: 22,
    bankingDeg: 2,
    apexSpeedKmh: 165,
    gear: 4,
    description:
      "Off-camber left-hand transition beginning the descent out of the infield.",
    sApprox: 3460,
  },
  {
    number: 12,
    name: "Turn 12 — Valley Launch",
    complexName: "Land of a Thousand Hills (T7–T12)",
    sector: 2,
    elevationM: 14,
    bankingDeg: 2,
    apexSpeedKmh: 158,
    gear: 4,
    description:
      "Right-hand exit corner dropping into the fast valley toward Lake Bugesera.",
    sApprox: 3660,
  },
  {
    number: 13,
    name: "Turn 13 — Valley Dip",
    complexName: "Lake Approach (T13–T14)",
    sector: 3,
    elevationM: 18,
    bankingDeg: 2,
    apexSpeedKmh: 285,
    gear: 7,
    description:
      "High-G compression through a fast sweeping left-hander.",
    sApprox: 3920,
  },
  {
    number: 14,
    name: "Turn 14 — Shoreline Bend",
    complexName: "Lake Approach (T13–T14)",
    sector: 3,
    elevationM: 25,
    bankingDeg: 1,
    apexSpeedKmh: 250,
    gear: 6,
    description:
      "Curved uphill approach that forces drivers to trail-brake while turning into Turn 15.",
    sApprox: 4100,
  },
  {
    number: 15,
    name: "Turn 15 — Bugesera Hairpin",
    complexName: "Bugesera Hairpin (T15)",
    sector: 3,
    elevationM: 35,
    bankingDeg: 3,
    apexSpeedKmh: 98,
    gear: 2,
    description:
      "The signature corner: a tight lakeside hairpin after a high-speed braking zone.",
    sApprox: 4380,
  },
  {
    number: 16,
    name: "Turn 16 — Summit Crest (+50m)",
    complexName: "Summit Sweepers (T16–T18)",
    sector: 3,
    elevationM: 49,
    bankingDeg: 2,
    apexSpeedKmh: 295,
    gear: 7,
    description:
      "Blind 295 km/h right-hand kink over the highest point of the circuit (+50m elevation).",
    sApprox: 4780,
  },
  {
    number: 17,
    name: "Turn 17 — Rwandan Flag Esses",
    complexName: "Summit Sweepers (T16–T18)",
    sector: 3,
    elevationM: 44,
    bankingDeg: 2,
    apexSpeedKmh: 258,
    gear: 6,
    description:
      "Fast downhill sweeper framed by iconic cyan, yellow, and green Rwandan runoff art.",
    sApprox: 4990,
  },
  {
    number: 18,
    name: "Turn 18 — RwandAir Corner",
    complexName: "Summit Sweepers (T16–T18)",
    sector: 3,
    elevationM: 40,
    bankingDeg: 3,
    apexSpeedKmh: 235,
    gear: 5,
    description:
      "Fast final right-hander onto the main straight; carry maximum momentum for the 340+ km/h slipstream.",
    sApprox: 5160,
  },
];

export const RWANDA_TURN_METADATA = TURN_METADATA;

function isInDrsZone(t: number): boolean {
  const normT = ((t % 1) + 1) % 1;
  for (const z of RWANDA_DRS_ZONES) {
    if (z.start <= z.end) {
      if (normT >= z.start && normT <= z.end) return true;
    } else {
      if (normT >= z.start || normT <= z.end) return true;
    }
  }
  return false;
}

function getTurnInfoAtS(
  s: number,
  totalLen: number
): {
  sector: 1 | 2 | 3;
  turnNumber: number;
  turnName: string;
  runoffStyle: RunoffStyle;
  minBankRad: number;
} {
  const t = s / totalLen;
  const sector: 1 | 2 | 3 = t < 0.36 ? 1 : t < 0.69 ? 2 : 3;

  let closestTurn: TurnMetadata | null = null;
  let minDiff = Infinity;
  for (const tm of TURN_METADATA) {
    const diff = Math.abs(s - tm.sApprox);
    if (diff < minDiff) {
      minDiff = diff;
      closestTurn = tm;
    }
  }

  if (closestTurn && minDiff <= 95) {
    const styles: RunoffStyle[] = [
      "qatar_maroon",
      "visit_rwanda_blue",
      "hills_yellow_green",
      "bugesera_cyan",
      "rwandair_blue_yellow",
    ];
    const envelope = Math.cos((minDiff / 95) * Math.PI * 0.5);
    return {
      sector,
      turnNumber: closestTurn.number,
      turnName: closestTurn.name,
      runoffStyle: styles[(closestTurn.number - 1) % styles.length],
      minBankRad: THREE.MathUtils.degToRad(closestTurn.bankingDeg) * envelope,
    };
  }

  return {
    sector,
    turnNumber: 0,
    turnName:
      sector === 1
        ? "Start / Finish Straight"
        : sector === 2
          ? "Thousand Hills Straight"
          : "Bugesera Back Straight",
    runoffStyle: "main_straight",
    minBankRad: 0,
  };
}

export const RWANDA_CONTROL_POINTS: TrackControlPoint[] = rawTrackJson.samples
  .filter((_, idx) => idx % 24 === 0)
  .map((raw) => {
    const totalLen = rawTrackJson.metadata.lengthMeters;
    const t = raw.s / totalLen;
    const info = getTurnInfoAtS(raw.s, totalLen);
    return {
      x: raw.p[0],
      y: raw.p[1],
      z: raw.p[2],
      bankingDeg: THREE.MathUtils.radToDeg(raw.b),
      width: raw.w,
      sector: info.sector,
      turnNumber: info.turnNumber,
      turnName: info.turnName,
      runoffStyle: info.runoffStyle,
      kerbLeft: Math.abs(raw.ro) > 1.2,
      kerbRight: Math.abs(raw.ro) > 1.2,
      drsZone: isInDrsZone(t),
      racingLineOffset: THREE.MathUtils.clamp(
        raw.ro / (raw.w * 0.34),
        -0.92,
        0.92
      ),
    };
  });

let cachedBuiltTrack: BuiltTrackData | null = null;

export function getRwandaTrackData(numSamples = 1200): BuiltTrackData {
  if (cachedBuiltTrack && cachedBuiltTrack.samples.length === numSamples) {
    return cachedBuiltTrack;
  }

  const rawSamples = rawTrackJson.samples;
  const rawCount = rawSamples.length;
  const totalLength = rawTrackJson.metadata.lengthMeters;

  const splinePts = rawSamples.map(
    (s) => new THREE.Vector3(s.p[0], s.p[1], s.p[2])
  );
  const spline = new THREE.CatmullRomCurve3(splinePts, true, "centripetal", 0.5);

  const NUM_SAMPLES = numSamples;
  const ds = totalLength / NUM_SAMPLES;

  const positions: THREE.Vector3[] = [];
  const racingPositions: THREE.Vector3[] = [];
  const widths: number[] = [];
  const bankings: number[] = [];
  const grips: number[] = [];

  let rawIdx = 0;
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const targetS = i * ds;
    while (
      rawIdx < rawCount - 1 &&
      rawSamples[(rawIdx + 1) % rawCount].s <= targetS
    ) {
      rawIdx++;
    }
    const r0 = rawSamples[rawIdx];
    const r1 = rawSamples[(rawIdx + 1) % rawCount];
    const s0 = r0.s;
    const s1 = rawIdx + 1 < rawCount ? r1.s : totalLength;
    const span = Math.max(0.001, s1 - s0);
    const alpha = THREE.MathUtils.clamp((targetS - s0) / span, 0, 1);

    positions.push(
      new THREE.Vector3(
        THREE.MathUtils.lerp(r0.p[0], r1.p[0], alpha),
        THREE.MathUtils.lerp(r0.p[1], r1.p[1], alpha),
        THREE.MathUtils.lerp(r0.p[2], r1.p[2], alpha)
      )
    );
    racingPositions.push(
      new THREE.Vector3(
        THREE.MathUtils.lerp(r0.r[0], r1.r[0], alpha),
        THREE.MathUtils.lerp(r0.r[1], r1.r[1], alpha),
        THREE.MathUtils.lerp(r0.r[2], r1.r[2], alpha)
      )
    );
    widths.push(THREE.MathUtils.lerp(r0.w, r1.w, alpha));

    const turnInfo = getTurnInfoAtS(targetS, totalLength);
    const meshBank = THREE.MathUtils.lerp(r0.b, r1.b, alpha);
    bankings.push(Math.max(meshBank, turnInfo.minBankRad));
    grips.push(THREE.MathUtils.lerp(r0.g ?? 1.0, r1.g ?? 1.0, alpha));
  }

  // Ensure the starting grid straight (s = 0..195m, already collinear within 1.2 cm in the KN5 road mesh)
  // has an exact collinear horizontal chord so pure 3D Cartesian straight-line acceleration has zero sub-millimeter lateral/heading noise
  const idxStart = Math.round(15 / ds);
  const idxEnd = Math.round(195 / ds);
  const pStart = positions[idxStart].clone();
  const pEnd = positions[idxEnd].clone();
  const straightDirX = pEnd.x - pStart.x;
  const straightDirZ = pEnd.z - pStart.z;
  const straightLen = Math.hypot(straightDirX, straightDirZ) || 1;
  const ux = straightDirX / straightLen;
  const uz = straightDirZ / straightLen;

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const s = i * ds;
    if (s <= 230) {
      const blend = s <= 195 ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(s, 195, 230);
      const dx = positions[i].x - pStart.x;
      const dz = positions[i].z - pStart.z;
      const projDist = dx * ux + dz * uz;
      const lineX = pStart.x + projDist * ux;
      const lineZ = pStart.z + projDist * uz;
      positions[i].x = THREE.MathUtils.lerp(positions[i].x, lineX, blend);
      positions[i].z = THREE.MathUtils.lerp(positions[i].z, lineZ, blend);
      bankings[i] *= 1.0 - blend;
    }
  }

  const tangents: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  const curvatures: number[] = [];
  const verticalCurvatures: number[] = [];
  const slopeSins: number[] = [];
  const racingOffsetsNorm: number[] = [];

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const prev2 = positions[(i - 2 + NUM_SAMPLES) % NUM_SAMPLES];
    const next2 = positions[(i + 2) % NUM_SAMPLES];
    const curr = positions[i];

    const tangentRaw = next2.clone().sub(prev2);
    const segLen = Math.max(0.01, tangentRaw.length());
    const slopeSin = THREE.MathUtils.clamp(tangentRaw.y / segLen, -0.28, 0.28);
    slopeSins.push(slopeSin);

    const tangent = tangentRaw.clone().normalize();
    // Horizontal right-hand unit vector in XZ plane: (tangent.x, 0, tangent.z) x (0, 1, 0) = (-tangent.z, 0, tangent.x)
    const rightFlat = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const upFlat = new THREE.Vector3()
      .crossVectors(rightFlat, tangent)
      .normalize();

    const bankRad = bankings[i];
    // Rotate surface normal around forward tangent by +bankRad so positive banking tilts right edge (binormal.y < 0) inward toward right-hand apex
    const normal = upFlat.clone().applyAxisAngle(tangent, bankRad).normalize();
    const binormal = new THREE.Vector3()
      .crossVectors(tangent, normal)
      .normalize();

    tangents.push(tangent);
    normals.push(normal);
    binormals.push(binormal);

    // Measure horizontal curvature along the optimal racing line over a ±4 sample (±17.7m) chord
    const rPrev = racingPositions[(i - 4 + NUM_SAMPLES) % NUM_SAMPLES];
    const rCurr = racingPositions[i];
    const rNext = racingPositions[(i + 4) % NUM_SAMPLES];
    const vIn = new THREE.Vector2(
      rCurr.x - rPrev.x,
      rCurr.z - rPrev.z
    ).normalize();
    const vOut = new THREE.Vector2(
      rNext.x - rCurr.x,
      rNext.z - rCurr.z
    ).normalize();
    const cross = vIn.x * vOut.y - vIn.y * vOut.x;
    const dot = THREE.MathUtils.clamp(vIn.dot(vOut), -1, 1);
    const dTheta = Math.atan2(cross, dot);
    const chordLen = Math.max(
      1.0,
      Math.hypot(rNext.x - rPrev.x, rNext.z - rPrev.z)
    );
    curvatures.push(dTheta / (0.5 * chordLen));

    const prevSlope =
      (curr.y - prev2.y) / Math.max(0.5, prev2.distanceTo(curr));
    const nextSlope =
      (next2.y - curr.y) / Math.max(0.5, curr.distanceTo(next2));
    verticalCurvatures.push((nextSlope - prevSlope) / (4 * ds));

    // Lateral offset of fast_lane.ai racing line relative to centerline along binormal (+right)
    const relX = rCurr.x - curr.x;
    const relZ = rCurr.z - curr.z;
    const offsetMeters = relX * rightFlat.x + relZ * rightFlat.z;
    const halfUsable = Math.max(3.5, widths[i] * 0.34);
    racingOffsetsNorm.push(
      THREE.MathUtils.clamp(offsetMeters / halfUsable, -0.95, 0.95)
    );
  }

  // Compute physically grounded optimal speed profile (km/h) along the racing line
  const rawSpeedsMs: number[] = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const absK = Math.abs(curvatures[i]);
    const bankBonus = Math.max(0, Math.tan(Math.abs(bankings[i]))) * 9.81;
    const maxLatAccel = 36.5 + bankBonus * 1.4;
    if (absK < 0.0012) {
      rawSpeedsMs.push(98.5);
    } else {
      const vMax = Math.sqrt(maxLatAccel / absK);
      rawSpeedsMs.push(THREE.MathUtils.clamp(vMax, 25.0, 98.5));
    }
  }

  const optSpeedsMs = [...rawSpeedsMs];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < NUM_SAMPLES; i++) {
      const next = (i + 1) % NUM_SAMPLES;
      const v = optSpeedsMs[i];
      const maxAccel = v > 70 ? 7.5 : 13.5;
      optSpeedsMs[next] = Math.min(
        optSpeedsMs[next],
        Math.sqrt(v * v + 2 * maxAccel * ds)
      );
    }
    for (let i = NUM_SAMPLES - 1; i >= 0; i--) {
      const prev = (i - 1 + NUM_SAMPLES) % NUM_SAMPLES;
      const v = optSpeedsMs[i];
      const maxBrakeDecel = 27.0 + 19.0 * Math.min(1.0, (v / 88.0) ** 2);
      optSpeedsMs[prev] = Math.min(
        optSpeedsMs[prev],
        Math.sqrt(v * v + 2 * maxBrakeDecel * ds)
      );
    }
  }

  const samples: TrackSamplePoint[] = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const s = i * ds;
    const t = i / NUM_SAMPLES;
    const nextIdx = (i + 3) % NUM_SAMPLES;
    const speedDrop = optSpeedsMs[i] - optSpeedsMs[nextIdx];
    const brakingZone =
      speedDrop > 4.2 ? 1.0 : speedDrop > 1.6 ? 0.5 : 0.0;

    const turnInfo = getTurnInfoAtS(s, totalLength);
    const absK = Math.abs(curvatures[i]);

    samples.push({
      index: i,
      s,
      t,
      position: positions[i],
      racingLinePos: racingPositions[i],
      tangent: tangents[i],
      normal: normals[i],
      binormal: binormals[i],
      bankingRad: bankings[i],
      width: widths[i],
      curvature: curvatures[i],
      verticalCurvature: verticalCurvatures[i],
      slopeSin: slopeSins[i],
      sector: turnInfo.sector,
      turnNumber: turnInfo.turnNumber,
      turnName: turnInfo.turnName,
      runoffStyle: turnInfo.runoffStyle,
      kerbLeft: absK > 0.004 || Math.abs(racingOffsetsNorm[i]) > 0.35,
      kerbRight: absK > 0.004 || Math.abs(racingOffsetsNorm[i]) > 0.35,
      drsZone: isInDrsZone(t),
      racingLineOffset: racingOffsetsNorm[i],
      optimalSpeedKmh: optSpeedsMs[i] * 3.6,
      brakingZone,
      gripMultiplier: grips[i],
    });
  }

  const getSampleAtDistance = (s: number): TrackSamplePoint => {
    const n = samples.length;
    const wrappedS = ((s % totalLength) + totalLength) % totalLength;
    const exactIdx = (wrappedS / totalLength) * n;
    const idx0 = Math.floor(exactIdx) % n;
    const idx1 = (idx0 + 1) % n;
    const alpha = exactIdx - Math.floor(exactIdx);

    const s0 = samples[idx0];
    const s1 = samples[idx1];

    return {
      ...s0,
      s: wrappedS,
      t: wrappedS / totalLength,
      position: s0.position.clone().lerp(s1.position, alpha),
      racingLinePos:
        s0.racingLinePos && s1.racingLinePos
          ? s0.racingLinePos.clone().lerp(s1.racingLinePos, alpha)
          : undefined,
      tangent: s0.tangent.clone().lerp(s1.tangent, alpha).normalize(),
      normal: s0.normal.clone().lerp(s1.normal, alpha).normalize(),
      binormal: s0.binormal.clone().lerp(s1.binormal, alpha).normalize(),
      bankingRad: THREE.MathUtils.lerp(s0.bankingRad, s1.bankingRad, alpha),
      width: THREE.MathUtils.lerp(s0.width, s1.width, alpha),
      curvature: THREE.MathUtils.lerp(s0.curvature, s1.curvature, alpha),
      verticalCurvature: THREE.MathUtils.lerp(
        s0.verticalCurvature,
        s1.verticalCurvature,
        alpha
      ),
      slopeSin: THREE.MathUtils.lerp(s0.slopeSin, s1.slopeSin, alpha),
      racingLineOffset: THREE.MathUtils.lerp(
        s0.racingLineOffset,
        s1.racingLineOffset,
        alpha
      ),
      optimalSpeedKmh: THREE.MathUtils.lerp(
        s0.optimalSpeedKmh,
        s1.optimalSpeedKmh,
        alpha
      ),
      gripMultiplier: THREE.MathUtils.lerp(
        s0.gripMultiplier ?? 1.0,
        s1.gripMultiplier ?? 1.0,
        alpha
      ),
    };
  };

  const projectWorldToTrackFn = (
    worldX: number,
    worldZ: number,
    hintS?: number
  ) => {
    const n = samples.length;
    let bestIdx = 0;
    let bestDistSq = Infinity;

    if (hintS !== undefined && Number.isFinite(hintS)) {
      const wrappedHint = ((hintS % totalLength) + totalLength) % totalLength;
      const centerIdx = Math.floor((wrappedHint / totalLength) * n) % n;
      const searchRadius = 40;
      for (let offset = -searchRadius; offset <= searchRadius; offset++) {
        const idx = (centerIdx + offset + n) % n;
        const p = samples[idx].position;
        const dx = worldX - p.x;
        const dz = worldZ - p.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = idx;
        }
      }
    }

    if (bestDistSq > 1225) {
      bestDistSq = Infinity;
      for (let i = 0; i < n; i++) {
        const p = samples[i].position;
        const dx = worldX - p.x;
        const dz = worldZ - p.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = i;
        }
      }
    }

    const prevIdx = (bestIdx - 1 + n) % n;
    const nextIdx = (bestIdx + 1) % n;

    const projectSeg = (idxA: number, idxB: number) => {
      const pA = samples[idxA].position;
      const pB = samples[idxB].position;
      const vx = pB.x - pA.x;
      const vz = pB.z - pA.z;
      const lenSq = vx * vx + vz * vz;
      const alpha =
        lenSq > 1e-6
          ? THREE.MathUtils.clamp(
              ((worldX - pA.x) * vx + (worldZ - pA.z) * vz) / lenSq,
              0,
              1
            )
          : 0;
      const projX = pA.x + alpha * vx;
      const projZ = pA.z + alpha * vz;
      const dSq = (worldX - projX) ** 2 + (worldZ - projZ) ** 2;
      const sVal =
        (((idxA * ds + alpha * ds) % totalLength) + totalLength) % totalLength;
      return { dSq, sVal };
    };

    const segPrev = projectSeg(prevIdx, bestIdx);
    const segNext = projectSeg(bestIdx, nextIdx);
    const chosen = segPrev.dSq < segNext.dSq ? segPrev : segNext;

    const sample = getSampleAtDistance(chosen.sVal);
    const relX = worldX - sample.position.x;
    const relZ = worldZ - sample.position.z;
    const bHorizLen = Math.hypot(sample.binormal.x, sample.binormal.z) || 1;
    const bx = sample.binormal.x / bHorizLen;
    const bz = sample.binormal.z / bHorizLen;
    // Account for binormal 3D tilt (cos(bankingRad)) so position + binormal * lateralOffset matches XZ
    const cosBank = Math.max(0.85, bHorizLen);
    const lateralOffset = (relX * bx + relZ * bz) / cosBank;

    return {
      sample,
      s: chosen.sVal,
      lateralOffset,
      distSq: chosen.dSq,
    };
  };

  cachedBuiltTrack = {
    samples,
    totalLengthM: totalLength,
    totalLength,
    spline,
    getSampleAtDistance,
    projectWorldToTrack: projectWorldToTrackFn,
  };

  return cachedBuiltTrack;
}

export function getTrackData(): BuiltTrackData {
  return getRwandaTrackData(1200);
}

export function sampleTrackAtDistance(s: number): TrackSamplePoint {
  return getRwandaTrackData(1200).getSampleAtDistance(s);
}

export function projectWorldToTrack(
  worldX: number,
  worldZ: number,
  hintS?: number
) {
  return getRwandaTrackData(1200).projectWorldToTrack(worldX, worldZ, hintS);
}

export function findClosestTrackSample(
  worldPos: THREE.Vector3,
  hintS?: number
): { sample: TrackSamplePoint; lateralOffset: number } {
  const proj = projectWorldToTrack(worldPos.x, worldPos.z, hintS);
  return {
    sample: proj.sample,
    lateralOffset: proj.lateralOffset,
  };
}

export function getTracksideTvCameras(): TracksideTvCameraDef[] {
  return RWANDA_TV_CAMERAS;
}

export function getActiveTvCamera(progress01: number): TracksideTvCameraDef {
  const p = ((progress01 % 1) + 1) % 1;
  for (const cam of RWANDA_TV_CAMERAS) {
    if (p >= cam.inPoint && p <= cam.outPoint) {
      return cam;
    }
  }
  return RWANDA_TV_CAMERAS[0];
}

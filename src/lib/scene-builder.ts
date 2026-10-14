import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import { withBasePath } from "@/lib/base-path";
import { evaluateDynamicBrakingUrgency } from "@/lib/sim/track-occupancy";
import type { RunoffStyle, TrackSamplePoint } from "@/types/f1";
import rwandaManifest from "../../public/tracks/rwanda/manifest.json";

export interface BuiltRwandaScene {
  sceneGroup: THREE.Group;
  racingLineMesh: THREE.Mesh;
  waterMesh: THREE.Mesh;
  startLightMeshes: THREE.Mesh[];
  updateEnvironment: (elapsedSeconds: number) => void;
  updateDynamicRacingLine: (carS: number, carSpeedMs: number) => void;
}

interface Kn5BatchEntry {
  key: string;
  materialName: string;
  shader: string;
  texture: string | null;
  alphaBlend: boolean;
  alphaTest: boolean;
  isFoliage: boolean;
  isRoadSurface: boolean;
  isTerrain: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  vCount: number;
  iCount: number;
  useUint32: boolean;
  posOffset: number;
  normOffset: number;
  uvOffset: number;
  idxOffset: number;
}

function loadAssettoCorsaKn5Meshes(
  kn5Group: THREE.Group,
  fallbackGroup: THREE.Group
): void {
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    return;
  }

  const binUrl = withBasePath("/tracks/rwanda/track_meshes.bin");
  const texLoader = new THREE.TextureLoader();
  const textureCache = new Map<string, THREE.Texture>();

  const getTexture = (texFile: string): THREE.Texture => {
    const cached = textureCache.get(texFile);
    if (cached) return cached;
    const tex = texLoader.load(
      withBasePath(`/tracks/rwanda/textures/${texFile}`)
    );
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    textureCache.set(texFile, tex);
    return tex;
  };

  fetch(binUrl)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} loading ${binUrl}`);
      }
      return res.arrayBuffer();
    })
    .then((buffer) => {
      const batches = rwandaManifest.batches as Kn5BatchEntry[];
      for (const batch of batches) {
        const geom = new THREE.BufferGeometry();
        const posArr = new Float32Array(
          buffer,
          batch.posOffset,
          batch.vCount * 3
        );
        const normArr = new Int8Array(
          buffer,
          batch.normOffset,
          batch.vCount * 3
        );
        const uvArr = new Float32Array(
          buffer,
          batch.uvOffset,
          batch.vCount * 2
        );
        const idxArr = batch.useUint32
          ? new Uint32Array(buffer, batch.idxOffset, batch.iCount)
          : new Uint16Array(buffer, batch.idxOffset, batch.iCount);

        geom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
        geom.setAttribute("normal", new THREE.BufferAttribute(normArr, 3, true));
        geom.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
        geom.setIndex(new THREE.BufferAttribute(idxArr, 1));

        const matLower = batch.materialName.toLowerCase();
        const isSurfaceMarking =
          batch.materialName === "Lines" ||
          batch.materialName === "Gridboxyellow" ||
          batch.materialName === "Box yellow" ||
          matLower.includes("trans") ||
          matLower.includes("symbol") ||
          matLower.includes("welcome to text") ||
          batch.materialName === "AMEX 2";
        const isKerbMat =
          matLower.includes("kerb") ||
          batch.materialName === "Rwanda gold" ||
          batch.materialName === "Rwanda yellow" ||
          batch.materialName === "Rwanda green" ||
          batch.materialName === "Rwanda blue";

        const mapTex = batch.texture ? getTexture(batch.texture) : null;

        const mat = new THREE.MeshStandardMaterial({
          map: mapTex,
          color: mapTex ? 0xffffff : 0xcccccc,
          roughness: batch.isRoadSurface
            ? 0.68
            : batch.isTerrain
              ? 0.9
              : batch.isFoliage
                ? 0.82
                : 0.48,
          metalness: batch.materialName.toLowerCase().includes("metal")
            ? 0.45
            : 0.06,
          transparent: batch.alphaBlend || matLower.includes("trans") || matLower.includes("symbol"),
          alphaTest:
            batch.alphaTest ||
            batch.isFoliage ||
            matLower.includes("trans") ||
            matLower.includes("symbol")
              ? 0.18
              : 0,
          depthWrite: !(batch.alphaBlend || matLower.includes("trans")),
          side:
            batch.isFoliage ||
            batch.alphaTest ||
            isSurfaceMarking ||
            matLower.includes("doubleface") ||
            matLower.includes("flag")
              ? THREE.DoubleSide
              : THREE.FrontSide,
          polygonOffset: isSurfaceMarking || isKerbMat,
          polygonOffsetFactor: isSurfaceMarking ? -2 : isKerbMat ? -1 : 0,
          polygonOffsetUnits: isSurfaceMarking ? -2 : isKerbMat ? -1 : 0,
        });

        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = `kn5_${batch.materialName}`;
        mesh.castShadow = batch.castShadow && !isSurfaceMarking;
        mesh.receiveShadow = batch.receiveShadow || batch.isRoadSurface || batch.isTerrain;
        if (isSurfaceMarking) {
          mesh.renderOrder = 1;
        }
        kn5Group.add(mesh);
      }

      // Hide fallback procedural geometry once authentic Assetto Corsa KN5 track meshes are live
      fallbackGroup.visible = false;
    })
    .catch((err) => {
      console.warn("Using fallback procedural track geometry:", err);
    });
}

function getTrackFrameQuaternion(sample: TrackSamplePoint): THREE.Quaternion {
  const left = new THREE.Vector3()
    .crossVectors(sample.normal, sample.tangent)
    .normalize();
  const up = sample.normal.clone().normalize();
  const forward = sample.tangent.clone().normalize();
  const m = new THREE.Matrix4().makeBasis(left, up, forward);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function createGrandstandSeatsTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#e2e8f0";
    ctx.fillRect(0, 0, 512, 256);

    for (let row = 0; row < 18; row++) {
      const y = 8 + row * 13;
      const tierBase =
        row < 8 ? "#00a3e0" : row < 13 ? "#fad201" : "#15803d";
      ctx.fillStyle = tierBase;
      ctx.fillRect(0, y, 512, 11);

      for (let s = 0; s < 64; s++) {
        if (s % 16 === 0 || s % 16 === 1) {
          ctx.fillStyle = "#cbd5e1";
          ctx.fillRect(s * 8, y, 8, 13);
          continue;
        }
        const hasSpectator = (row * 11 + s * 7) % 3 !== 0;
        if (hasSpectator) {
          const specCols = ["#0f172a", "#1e3a8a", "#ffffff", "#dc2626", "#0284c7"];
          ctx.fillStyle = specCols[(row * 5 + s * 3) % specCols.length];
          ctx.fillRect(s * 8 + 1, y + 2, 5, 7);
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  return tex;
}

function createAsphaltTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#282c37";
    ctx.fillRect(0, 0, 1024, 1024);

    for (let i = 0; i < 36000; i++) {
      const x = Math.random() * 1024;
      const y = Math.random() * 1024;
      const v = 32 + Math.floor(Math.random() * 28);
      ctx.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
      ctx.fillRect(x, y, 2, 2);
    }

    const grad = ctx.createLinearGradient(180, 0, 844, 0);
    grad.addColorStop(0, "rgba(12,14,18,0)");
    grad.addColorStop(0.35, "rgba(12,14,18,0.28)");
    grad.addColorStop(0.5, "rgba(12,14,18,0.42)");
    grad.addColorStop(0.65, "rgba(12,14,18,0.28)");
    grad.addColorStop(1, "rgba(12,14,18,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(180, 0, 664, 1024);

    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(16, 0, 18, 1024);
    ctx.fillRect(990, 0, 18, 1024);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

function createRunoffPatternTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#7a0b3b";
    ctx.fillRect(0, 0, 256, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 10, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(10, 0, 34, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(44, 0, 6, 512);
    ctx.fillStyle = "#5c082c";
    ctx.fillRect(210, 0, 46, 512);

    const b1 = 256;
    ctx.fillStyle = "#00a3e0";
    ctx.fillRect(b1, 0, 256, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b1, 0, 10, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(b1 + 10, 0, 24, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b1 + 34, 0, 6, 512);

    for (let y = 0; y < 512; y += 2) {
      const phase = (y / 512) * Math.PI * 2;
      const w1 = b1 + 108 + Math.sin(phase) * 22;
      const w2 = b1 + 156 + Math.sin(phase + 0.9) * 24;
      const w3 = b1 + 202 + Math.cos(phase * 2) * 18;

      ctx.fillStyle = "#00a3e0";
      ctx.fillRect(b1 + 40, y, w1 - (b1 + 40), 2);
      ctx.fillStyle = "#fad201";
      ctx.fillRect(w1, y, w2 - w1, 2);
      ctx.fillStyle = "#16a34a";
      ctx.fillRect(w2, y, w3 - w2, 2);
      ctx.fillStyle = "#1e3a8a";
      ctx.fillRect(w3, y, b1 + 256 - w3, 2);
    }

    const b2 = 512;
    ctx.fillStyle = "#d6bc94";
    ctx.fillRect(b2, 0, 256, 512);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b2, 0, 10, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(b2 + 10, 0, 22, 512);

    for (let y = 0; y < 512; y += 2) {
      const phase = (y / 512) * Math.PI * 2;
      const w1 = b2 + 78 + Math.sin(phase) * 16;
      const w2 = b2 + 114 + Math.sin(phase + 0.8) * 16;
      const w3 = b2 + 148 + Math.cos(phase * 2) * 14;

      ctx.fillStyle = "#00a3e0";
      ctx.fillRect(b2 + 32, y, w1 - (b2 + 32), 2);
      ctx.fillStyle = "#fad201";
      ctx.fillRect(w1, y, w2 - w1, 2);
      ctx.fillStyle = "#16a34a";
      ctx.fillRect(w2, y, w3 - w2, 2);
      ctx.fillStyle = "#d6bc94";
      ctx.fillRect(w3, y, b2 + 256 - w3, 2);
    }

    const b3 = 768;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(b3, 0, 12, 512);
    ctx.fillStyle = "#00a3e0";
    ctx.fillRect(b3 + 12, 0, 96, 512);
    ctx.fillStyle = "#fad201";
    ctx.fillRect(b3 + 108, 0, 68, 512);
    ctx.fillStyle = "#16a34a";
    ctx.fillRect(b3 + 176, 0, 80, 512);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

function getRunoffAtlasUVRange(style: RunoffStyle): [number, number] {
  switch (style) {
    case "qatar_maroon":
    case "main_straight":
      return [0.008, 0.242];
    case "visit_rwanda_blue":
    case "rwandair_blue_yellow":
      return [0.258, 0.492];
    case "hills_yellow_green":
    case "bugesera_cyan":
    default:
      return [0.508, 0.742];
  }
}

/**
 * Builds a realistic sloped stadium grandstand group facing the track.
 * In local track frame, -X is left (+binormal) and +X is right (-binormal).
 * When placed on `side` (-1 = left of track, +1 = right of track), the sloped seating bowl
 * faces inward toward the track centerline (`x = 0`).
 */
function buildSlopedGrandstandGroup(
  depth: number,
  height: number,
  length: number,
  side: -1 | 1,
  seatTex: THREE.Texture,
  canopyMat?: THREE.Material | THREE.Material[]
): THREE.Group {
  const group = new THREE.Group();
  group.userData.isTracksideStructure = true;
  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.65,
  });

  // Lower concrete podium base
  const baseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(depth, 2.2, length),
    concreteMat
  );
  baseMesh.position.y = 1.1;
  group.add(baseMesh);

  // Rear structural backwall
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, height, length),
    concreteMat
  );
  // In getTrackFrameQuaternion, local +X is `left = normal x tangent = -binormal`.
  // Wait: let's check getTrackFrameQuaternion:
  // `left = normal x tangent`. Since `binormal = tangent x normal = -left`,
  // a point shifted by `side * dist` along `binormal` has local X = `-side * dist`!
  // So toward the track centerline from `side * dist` along `binormal` is local X = `+side`!
  const frontSign = side; // local X direction pointing BACK toward the track centerline
  backWall.position.set(-frontSign * (depth * 0.5 - 0.8), height * 0.5, 0);
  group.add(backWall);

  // Explicit 4-vertex sloped stadium seating quad facing the track (immune to Euler rotation order)
  const frontX = frontSign * (depth * 0.5 - 0.2);
  const backX = -frontSign * (depth * 0.5 - 1.6);
  const halfL = length * 0.5;
  const seatGeom = new THREE.BufferGeometry();
  seatGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        frontX, 2.2, -halfL, // 0: Front bottom (-Z)
        frontX, 2.2, halfL,  // 1: Front bottom (+Z)
        backX, height, -halfL, // 2: Back top (-Z)
        backX, height, halfL,  // 3: Back top (+Z)
      ],
      3
    )
  );
  seatGeom.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2)
  );
  seatGeom.setIndex([0, 1, 2, 1, 3, 2]);
  seatGeom.computeVertexNormals();

  const seatPlane = new THREE.Mesh(
    seatGeom,
    new THREE.MeshStandardMaterial({
      map: seatTex,
      roughness: 0.55,
      side: THREE.DoubleSide,
    })
  );
  group.add(seatPlane);

  // Cantilevered white stadium roof overhang + support columns
  const roofMesh = new THREE.Mesh(
    new THREE.BoxGeometry(depth + 4.5, 0.9, length + 4),
    canopyMat ??
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 })
  );
  roofMesh.position.set(frontSign * 1.5, height + 2.1, 0);
  roofMesh.rotation.z = -frontSign * 0.06;
  group.add(roofMesh);

  const numCols = Math.max(3, Math.floor(length / 36));
  for (let c = 0; c < numCols; c++) {
    const cz = -length * 0.46 + (c / Math.max(1, numCols - 1)) * (length * 0.92);
    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.34, height + 2.0, 8),
      concreteMat
    );
    strut.position.set(-frontSign * (depth * 0.42), (height + 2.0) * 0.5, cz);
    group.add(strut);
  }

  return group;
}

function pushQuadUpward(
  indices: number[],
  baseVert: number,
  side: number
): void {
  if (side > 0) {
    indices.push(
      baseVert,
      baseVert + 1,
      baseVert + 2,
      baseVert + 1,
      baseVert + 3,
      baseVert + 2
    );
  } else {
    indices.push(
      baseVert,
      baseVert + 2,
      baseVert + 1,
      baseVert + 1,
      baseVert + 2,
      baseVert + 3
    );
  }
}

export function buildRwandaCircuitScene(
  track: BuiltTrackData
): BuiltRwandaScene {
  const sceneGroup = new THREE.Group();
  const kn5Group = new THREE.Group();
  kn5Group.name = "AssettoCorsaRwandaKn5Group";
  sceneGroup.add(kn5Group);

  const fallbackGroup = new THREE.Group();
  fallbackGroup.name = "FallbackProceduralGroup";
  sceneGroup.add(fallbackGroup);

  // Asynchronously load the 114 batched Assetto Corsa KN5 meshes + textures in browser
  loadAssettoCorsaKn5Meshes(kn5Group, fallbackGroup);

  const samples = track.samples;
  const n = samples.length;

  // ============================================================================
  // 1. FALLBACK ASPHALT TRACK RIBBON MESH (Active before KN5 binary finishes loading)
  // ============================================================================
  const trackGeom = new THREE.BufferGeometry();
  const trackPositions: number[] = [];
  const trackNormals: number[] = [];
  const trackUVs: number[] = [];
  const trackIndices: number[] = [];

  for (let i = 0; i <= n; i++) {
    const sample = samples[i % n];
    const halfW = sample.width * 0.5;
    const leftPt = sample.position
      .clone()
      .addScaledVector(sample.binormal, -halfW);
    const rightPt = sample.position
      .clone()
      .addScaledVector(sample.binormal, halfW);

    trackPositions.push(leftPt.x, leftPt.y, leftPt.z);
    trackPositions.push(rightPt.x, rightPt.y, rightPt.z);

    trackNormals.push(sample.normal.x, sample.normal.y, sample.normal.z);
    trackNormals.push(sample.normal.x, sample.normal.y, sample.normal.z);

    const vCoord = (i / n) * 180;
    trackUVs.push(0, vCoord);
    trackUVs.push(1, vCoord);

    if (i < n) {
      const base = i * 2;
      trackIndices.push(base, base + 1, base + 2);
      trackIndices.push(base + 1, base + 3, base + 2);
    }
  }

  trackGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(trackPositions, 3)
  );
  trackGeom.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(trackNormals, 3)
  );
  trackGeom.setAttribute("uv", new THREE.Float32BufferAttribute(trackUVs, 2));
  trackGeom.setIndex(trackIndices);

  const asphaltMat = new THREE.MeshStandardMaterial({
    map: createAsphaltTexture(),
    roughness: 0.68,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });

  const trackMesh = new THREE.Mesh(trackGeom, asphaltMat);
  trackMesh.receiveShadow = true;
  fallbackGroup.add(trackMesh);

  // ============================================================================
  // 2. FALLBACK RUNOFF APRONS & KERBS
  // ============================================================================
  const runoffGeom = new THREE.BufferGeometry();
  const runoffPositions: number[] = [];
  const runoffNormals: number[] = [];
  const runoffUVs: number[] = [];
  const runoffIndices: number[] = [];
  let runoffVertCount = 0;

  const kerbGeom = new THREE.BufferGeometry();
  const kerbPositions: number[] = [];
  const kerbNormals: number[] = [];
  const kerbColors: number[] = [];
  const kerbIndices: number[] = [];
  let kerbVertCount = 0;

  const runoffWidth = 12.5;
  const kerbWidth = 1.45;

  for (let i = 0; i < n; i++) {
    const s0 = samples[i];
    const s1 = samples[(i + 1) % n];

    const [uIn, uOut] = getRunoffAtlasUVRange(s0.runoffStyle);

    const v0 = (i / n) * 160;
    const v1 = ((i + 1) / n) * 160;

    for (const side of [-1, 1]) {
      const hw0 = s0.width * 0.5;
      const hw1 = s1.width * 0.5;

      const p0Inner = s0.position
        .clone()
        .addScaledVector(s0.binormal, side * hw0)
        .addScaledVector(s0.normal, -0.01);
      const p0Outer = s0.position
        .clone()
        .addScaledVector(s0.binormal, side * (hw0 + runoffWidth))
        .addScaledVector(s0.normal, -0.04);
      const p1Inner = s1.position
        .clone()
        .addScaledVector(s1.binormal, side * hw1)
        .addScaledVector(s1.normal, -0.01);
      const p1Outer = s1.position
        .clone()
        .addScaledVector(s1.binormal, side * (hw1 + runoffWidth))
        .addScaledVector(s1.normal, -0.04);

      runoffPositions.push(
        p0Inner.x,
        p0Inner.y,
        p0Inner.z,
        p0Outer.x,
        p0Outer.y,
        p0Outer.z,
        p1Inner.x,
        p1Inner.y,
        p1Inner.z,
        p1Outer.x,
        p1Outer.y,
        p1Outer.z
      );

      for (let k = 0; k < 4; k++) {
        runoffNormals.push(s0.normal.x, s0.normal.y, s0.normal.z);
      }

      runoffUVs.push(uIn, v0, uOut, v0, uIn, v1, uOut, v1);
      pushQuadUpward(runoffIndices, runoffVertCount, side);
      runoffVertCount += 4;

      const hasKerb = side === -1 ? s0.kerbLeft : s0.kerbRight;
      if (hasKerb) {
        const mod3 = i % 3;
        const kCol =
          mod3 === 0
            ? new THREE.Color(0x00a3e0)
            : mod3 === 1
              ? new THREE.Color(0xfad201)
              : new THREE.Color(0x16a34a);

        const k0In = s0.position
          .clone()
          .addScaledVector(s0.binormal, side * (hw0 - 0.15))
          .addScaledVector(s0.normal, 0.03);
        const k0Out = s0.position
          .clone()
          .addScaledVector(s0.binormal, side * (hw0 + kerbWidth))
          .addScaledVector(s0.normal, 0.05);
        const k1In = s1.position
          .clone()
          .addScaledVector(s1.binormal, side * (hw1 - 0.15))
          .addScaledVector(s1.normal, 0.03);
        const k1Out = s1.position
          .clone()
          .addScaledVector(s1.binormal, side * (hw1 + kerbWidth))
          .addScaledVector(s1.normal, 0.05);

        kerbPositions.push(
          k0In.x,
          k0In.y,
          k0In.z,
          k0Out.x,
          k0Out.y,
          k0Out.z,
          k1In.x,
          k1In.y,
          k1In.z,
          k1Out.x,
          k1Out.y,
          k1Out.z
        );

        for (let k = 0; k < 4; k++) {
          kerbNormals.push(s0.normal.x, s0.normal.y, s0.normal.z);
          kerbColors.push(kCol.r, kCol.g, kCol.b);
        }

        pushQuadUpward(kerbIndices, kerbVertCount, side);
        kerbVertCount += 4;
      }
    }
  }

  runoffGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(runoffPositions, 3)
  );
  runoffGeom.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(runoffNormals, 3)
  );
  runoffGeom.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(runoffUVs, 2)
  );
  runoffGeom.setIndex(runoffIndices);

  const runoffMesh = new THREE.Mesh(
    runoffGeom,
    new THREE.MeshStandardMaterial({
      map: createRunoffPatternTexture(),
      vertexColors: false,
      roughness: 0.62,
      metalness: 0.04,
    })
  );
  runoffMesh.receiveShadow = true;
  fallbackGroup.add(runoffMesh);

  kerbGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(kerbPositions, 3)
  );
  kerbGeom.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(kerbNormals, 3)
  );
  kerbGeom.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(kerbColors, 3)
  );
  kerbGeom.setIndex(kerbIndices);

  const kerbMesh = new THREE.Mesh(
    kerbGeom,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.45,
    })
  );
  fallbackGroup.add(kerbMesh);

  // ============================================================================
  // 3. DYNAMIC 3D DASHED RACING & BRAKING LINE (Along exact fast_lane.ai coordinates)
  // ============================================================================
  const rlGeom = new THREE.BufferGeometry();
  const rlPositions: number[] = [];
  const rlColors: number[] = [];
  const rlIndices: number[] = [];

  // Build crisp 3D dashed rectangular marker segments along the exact fast_lane.ai racing line
  let rlVertBase = 0;
  for (let i = 0; i < n; i++) {
    const s0 = samples[i];
    const s1 = samples[(i + 1) % n];

    const p0Base =
      s0.racingLinePos ??
      s0.position
        .clone()
        .addScaledVector(s0.binormal, s0.racingLineOffset * (s0.width * 0.34));
    const p1Base =
      s1.racingLinePos ??
      s1.position
        .clone()
        .addScaledVector(s1.binormal, s1.racingLineOffset * (s1.width * 0.34));

    const pDashEnd = p0Base.clone().lerp(p1Base, 0.72);
    const nDashEnd = s0.normal.clone().lerp(s1.normal, 0.72).normalize();
    const bDashEnd = s0.binormal.clone().lerp(s1.binormal, 0.72).normalize();

    const halfDashW = 0.44;
    const dashLiftY = 0.048;

    const c0 = p0Base.clone().addScaledVector(s0.normal, dashLiftY);
    const c1 = pDashEnd.clone().addScaledVector(nDashEnd, dashLiftY);

    const l0 = c0.clone().addScaledVector(s0.binormal, -halfDashW);
    const r0 = c0.clone().addScaledVector(s0.binormal, halfDashW);
    const l1 = c1.clone().addScaledVector(bDashEnd, -halfDashW);
    const r1 = c1.clone().addScaledVector(bDashEnd, halfDashW);

    rlPositions.push(
      l0.x,
      l0.y,
      l0.z,
      r0.x,
      r0.y,
      r0.z,
      l1.x,
      l1.y,
      l1.z,
      r1.x,
      r1.y,
      r1.z
    );

    const c = new THREE.Color();
    if (s0.brakingZone < 0.28) {
      c.setRGB(0.05, 0.92, 0.38); // Full throttle Green
    } else if (s0.brakingZone < 0.62) {
      c.setRGB(0.98, 0.76, 0.08); // Lift / Transition Yellow-Amber
    } else {
      c.setRGB(0.98, 0.12, 0.18); // Heavy Braking Zone Red
    }

    for (let k = 0; k < 4; k++) {
      rlColors.push(c.r, c.g, c.b);
    }

    rlIndices.push(
      rlVertBase,
      rlVertBase + 1,
      rlVertBase + 2,
      rlVertBase + 1,
      rlVertBase + 3,
      rlVertBase + 2
    );
    rlVertBase += 4;
  }

  const rlColorAttr = new THREE.Float32BufferAttribute(rlColors, 3);
  rlGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(rlPositions, 3)
  );
  rlGeom.setAttribute("color", rlColorAttr);
  rlGeom.setIndex(rlIndices);

  const racingLineMesh = new THREE.Mesh(
    rlGeom,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    })
  );
  racingLineMesh.renderOrder = 2;
  sceneGroup.add(racingLineMesh);

  /**
   * Real-time updater for the 3D dashed braking line: dynamically transitions dashes
   * ahead of the player between Green, Yellow, and Red based on the car's live speed
   * vs the physics-derived optimal corner speed profile.
   */
  const updateDynamicRacingLine = (carS: number, carSpeedMs: number) => {
    const stepM = track.totalLengthM / n;
    const carIdx =
      Math.floor(
        (((carS % track.totalLengthM) + track.totalLengthM) %
          track.totalLengthM) /
          stepM
      ) % n;

    // Update window from 15 samples behind to 65 samples (~288m) ahead of the car
    for (let offset = -15; offset <= 65; offset++) {
      const idx = (carIdx + offset + n) % n;
      const sp = samples[idx];
      const urgency =
        offset >= -2
          ? evaluateDynamicBrakingUrgency(
              track,
              carS,
              carSpeedMs,
              sp.s,
              sp.optimalSpeedKmh / 3.6
            )
          : sp.brakingZone;

      let r = 0.05;
      let g = 0.92;
      let b = 0.38;
      if (urgency >= 0.62) {
        const t = Math.min(1, (urgency - 0.62) / 0.38);
        r = 0.98;
        g = THREE.MathUtils.lerp(0.45, 0.08, t);
        b = THREE.MathUtils.lerp(0.08, 0.16, t);
      } else if (urgency >= 0.25) {
        const t = (urgency - 0.25) / 0.37;
        r = THREE.MathUtils.lerp(0.05, 0.98, t);
        g = THREE.MathUtils.lerp(0.92, 0.72, t);
        b = THREE.MathUtils.lerp(0.38, 0.06, t);
      }

      const vBase = idx * 4;
      for (let k = 0; k < 4; k++) {
        rlColorAttr.setXYZ(vBase + k, r, g, b);
      }
    }
    rlColorAttr.needsUpdate = true;
  };

  // ============================================================================
  // 4. SHIMMERING LAKE BUGESERA WATER PLANE & F1 STARTING LIGHTS MAST
  // ============================================================================
  const waterGeom = new THREE.PlaneGeometry(1800, 2200, 16, 16);
  waterGeom.rotateX(-Math.PI * 0.5);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x0284c7,
    roughness: 0.14,
    metalness: 0.65,
    transparent: true,
    opacity: 0.92,
  });
  const waterMesh = new THREE.Mesh(waterGeom, waterMat);
  waterMesh.position.set(-1340, -18.0, -120);
  fallbackGroup.add(waterMesh);

  // Cantilevered F1 Starting Lights Mast on Main Straight (s = 72m, ahead of car at s = 35m)
  const whiteBridgeMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.35,
    metalness: 0.12,
  });

  const startMastSample = track.getSampleAtDistance(72);
  const startMastGroup = new THREE.Group();
  startMastGroup.position.copy(startMastSample.position);
  startMastGroup.quaternion.copy(getTrackFrameQuaternion(startMastSample));

  const mastPost = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.48, 8.8, 14),
    whiteBridgeMat
  );
  mastPost.position.set(16.5, 4.4, 0);
  startMastGroup.add(mastPost);

  const mastArm = new THREE.Mesh(
    new THREE.BoxGeometry(17.5, 0.55, 0.65),
    whiteBridgeMat
  );
  mastArm.position.set(8.2, 8.4, 0);
  startMastGroup.add(mastArm);

  const lightBackboard = new THREE.Mesh(
    new THREE.BoxGeometry(6.8, 1.35, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4 })
  );
  lightBackboard.position.set(1.8, 7.6, 0);
  startMastGroup.add(lightBackboard);

  const startLightMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const lightMat = new THREE.MeshStandardMaterial({
      color: 0x16a34a,
      emissive: 0x22c55e,
      emissiveIntensity: 2.4,
    });
    const pod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 0.28, 16),
      lightMat
    );
    pod.rotation.x = Math.PI * 0.5;
    pod.position.set(1.8 + (i - 2) * 1.25, 7.55, -0.25);
    startMastGroup.add(pod);
    startLightMeshes.push(pod);
  }
  sceneGroup.add(startMastGroup);

  // ============================================================================
  // 5. COLLISION-VERIFIED TRACKSIDE STRUCTURES (In fallbackGroup for headless verification)
  // ============================================================================
  const isFootprintClearOfTrack = (
    centerPos: THREE.Vector3,
    quat: THREE.Quaternion,
    halfSizeX: number,
    halfSizeZ: number,
    minCenterlineClearanceM = 30.0
  ): boolean => {
    const minSq = minCenterlineClearanceM * minCenterlineClearanceM;
    const localPt = new THREE.Vector3();
    for (let ix = -2; ix <= 2; ix++) {
      for (let iz = -4; iz <= 4; iz++) {
        localPt
          .set((ix / 2) * halfSizeX, 0, (iz / 4) * halfSizeZ)
          .applyQuaternion(quat)
          .add(centerPos);
        for (let sIdx = 0; sIdx < n; sIdx++) {
          const sp = samples[sIdx].position;
          const dx = localPt.x - sp.x;
          const dz = localPt.z - sp.z;
          if (dx * dx + dz * dz < minSq) {
            return false;
          }
        }
      }
    }
    return true;
  };

  const findSafeTracksidePosition = (
    sample: TrackSamplePoint,
    preferredSide: -1 | 1,
    halfSizeX: number,
    halfSizeZ: number,
    startOffsetM = 44,
    minCenterlineClearanceM = 30.0
  ): { pos: THREE.Vector3; side: -1 | 1; quat: THREE.Quaternion } | null => {
    const quat = getTrackFrameQuaternion(sample);
    for (const side of [preferredSide, (preferredSide * -1) as -1 | 1]) {
      for (let dist = startOffsetM; dist <= 220; dist += 6) {
        const candidatePos = sample.position
          .clone()
          .addScaledVector(sample.binormal, side * dist)
          .add(new THREE.Vector3(0, -0.5, 0));
        if (
          isFootprintClearOfTrack(
            candidatePos,
            quat,
            halfSizeX,
            halfSizeZ,
            minCenterlineClearanceM
          )
        ) {
          return { pos: candidatePos, side, quat };
        }
      }
    }
    return null;
  };

  const grandstandSeatTex = createGrandstandSeatsTexture();
  grandstandSeatTex.repeat.set(6, 1);

  const sectorGrandstands: {
    sDist: number;
    side: -1 | 1;
    length: number;
  }[] = [
    { sDist: 140, side: -1, length: 68 },
    { sDist: 140, side: 1, length: 68 },
    { sDist: 455, side: -1, length: 64 },
    { sDist: 1580, side: -1, length: 64 },
    { sDist: 2940, side: 1, length: 68 },
    { sDist: 4240, side: -1, length: 64 },
    { sDist: 4920, side: -1, length: 68 },
  ];

  for (const sg of sectorGrandstands) {
    const sp = track.getSampleAtDistance(sg.sDist);
    const safeGs = findSafeTracksidePosition(
      sp,
      sg.side,
      14.0,
      sg.length * 0.5 + 4.0,
      48,
      32.0
    );
    if (safeGs) {
      const gGroup = buildSlopedGrandstandGroup(
        16,
        12,
        sg.length,
        safeGs.side,
        grandstandSeatTex
      );
      gGroup.position.copy(safeGs.pos);
      gGroup.quaternion.copy(safeGs.quat);
      fallbackGroup.add(gGroup);
    }
  }

  // Trackside TV Broadcast Camera Scaffold Towers
  for (const camDist of [410, 890, 1890, 3150, 4410]) {
    const sp = track.getSampleAtDistance(camDist);
    const safeCam = findSafeTracksidePosition(sp, -1, 4.0, 4.0, 38, 30.0);
    if (safeCam) {
      const camTower = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 7.5, 2.4),
        new THREE.MeshStandardMaterial({
          color: 0x94a3b8,
          metalness: 0.5,
          roughness: 0.4,
        })
      );
      camTower.userData.isTracksideStructure = true;
      camTower.position.copy(safeCam.pos).add(new THREE.Vector3(0, 4.0, 0));
      fallbackGroup.add(camTower);
    }
  }

  // Lakeside White Peaked Hospitality Tents & Pavilions
  const whiteTentMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.35,
  });
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.55,
  });

  for (const sDist of [4140, 4210, 4280, 4350, 4490, 4570, 4650]) {
    const sp = track.getSampleAtDistance(sDist);
    const safeTent = findSafeTracksidePosition(sp, -1, 12.0, 12.0, 46, 32.0);
    if (!safeTent) continue;

    const pavGroup = new THREE.Group();
    pavGroup.userData.isTracksideStructure = true;
    pavGroup.position
      .copy(safeTent.pos)
      .setY(Math.max(1.5, sp.position.y - 3.8));

    const tentWalls = new THREE.Mesh(
      new THREE.BoxGeometry(14, 3.6, 14),
      deckMat
    );
    tentWalls.position.y = 1.8;
    pavGroup.add(tentWalls);

    const tentPeak = new THREE.Mesh(
      new THREE.ConeGeometry(11.2, 5.2, 4),
      whiteTentMat
    );
    tentPeak.rotation.y = Math.PI * 0.25;
    tentPeak.position.y = 6.2;
    pavGroup.add(tentPeak);
    fallbackGroup.add(pavGroup);
  }

  // RwandAir Jetliner Banking in the Sky near Bugesera International Airport
  const jetGroup = new THREE.Group();
  const fuselageMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.25,
    metalness: 0.3,
  });
  const tailBlueMat = new THREE.MeshStandardMaterial({
    color: 0x00a3e0,
    roughness: 0.3,
  });
  const fuselage = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 1.6, 38, 12),
    fuselageMat
  );
  fuselage.rotation.x = Math.PI * 0.5;
  jetGroup.add(fuselage);

  const mainWings = new THREE.Mesh(
    new THREE.BoxGeometry(36, 0.4, 5.2),
    fuselageMat
  );
  mainWings.position.set(0, -0.2, 2);
  jetGroup.add(mainWings);

  const tailFin = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 7.5, 5.5),
    tailBlueMat
  );
  tailFin.position.set(0, 4.2, -16);
  jetGroup.add(tailFin);

  jetGroup.position.set(-420, 210, -380);
  sceneGroup.add(jetGroup);

  const updateEnvironment = (elapsedSeconds: number) => {
    waterMesh.position.y = -18.0 + Math.sin(elapsedSeconds * 1.4) * 0.08;
    // Gently circle the RwandAir jetliner across the sky near Bugesera Airport
    const jetAngle = elapsedSeconds * 0.045;
    jetGroup.position.set(
      -250 + Math.cos(jetAngle) * 680,
      205 + Math.sin(elapsedSeconds * 0.2) * 8,
      -200 + Math.sin(jetAngle) * 680
    );
    jetGroup.rotation.y = -jetAngle;
    jetGroup.rotation.z = 0.14;
  };

  return {
    sceneGroup,
    racingLineMesh,
    waterMesh,
    startLightMeshes,
    updateEnvironment,
    updateDynamicRacingLine,
  };
}


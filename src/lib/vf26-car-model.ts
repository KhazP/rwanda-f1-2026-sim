import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { withBasePath } from "@/lib/base-path";
import { VF26_CHASSIS } from "@/lib/sim/vf26-data";
import type { CarTelemetry, TireCompound } from "@/types/f1";

/**
 * Sim Dream VF26 3D model (AC EVO mod), converted locally by scripts/vf26/port_model.py into
 * public/vf26/model/vf26.glb. That folder is gitignored (the model is not ours to redistribute), so on
 * builds without it `loadVf26Template()` resolves to null and the procedural car stays in place.
 *
 * Model space (from the .mesh bone data): +X left, +Y up, +Z forward, origin on the floor plane under the
 * cockpit — the same axes as the rig, so only a translation is needed.
 *
 * With `--driver-root` the GLB also carries the AC EVO driver (base-game suit/gloves/shoes/helmet in the mod's
 * Haas livery) skinned to driver_body's skeleton, plus a "steer" clip from the mod's driver_steer animation.
 */
const MODEL_URL = "/vf26/model/vf26.glb";

export interface Vf26CameraAnchor {
  /** Rig-local position (m): +X left, +Y up, +Z forward */
  pos: THREE.Vector3;
  pitchRad: number;
  fovDeg: number;
}

export interface Vf26ModelInstance {
  bodyGroup: THREE.Group;
  cameraAnchors: Record<
    "cockpit" | "shoulder" | "tcam" | "dash" | "bumper" | "nearChase" | "farChase",
    Vf26CameraAnchor
  >;
  update: (telemetry: CarTelemetry, wheelRotationRad: number, dtSeconds: number) => void;
  /** Swap the tyre sidewall texture (the mod's per-compound .tyretextures) */
  setTireCompound: (compound: TireCompound) => void;
  /** Hide the helmet while the camera sits at the driver's eye point (AC EVO does the same) */
  setHeadVisible: (visible: boolean) => void;
  dispose: () => void;
}

interface TemplateAssets {
  tyreMaps: Partial<Record<TireCompound, THREE.Texture>>;
  animations: THREE.AnimationClip[];
}

let templatePromise: Promise<THREE.Group | null> | null = null;
// Kept out of userData: Object3D.clone() JSON-serialises userData, which would encode every texture per car
const templateAssets = new WeakMap<THREE.Object3D, TemplateAssets>();

export function loadVf26Template(): Promise<THREE.Group | null> {
  if (!templatePromise) {
    templatePromise = (async () => {
      if (typeof window === "undefined") return null;
      const url = withBasePath(MODEL_URL);
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (!head.ok) return null;
        const gltf = await new GLTFLoader().loadAsync(url);
        const scene = gltf.scene;
        // Per-compound tyre maps are stored as extra textures (index list in the root node extras)
        const tyreIdx = (scene.getObjectByName("VF26")?.userData?.tyreMaps ?? {}) as Record<string, number>;
        const tyreMaps: Partial<Record<TireCompound, THREE.Texture>> = {};
        for (const [compound, idx] of Object.entries(tyreIdx)) {
          const tex = (await gltf.parser.getDependency("texture", idx)) as THREE.Texture;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          tyreMaps[compound as TireCompound] = tex;
        }
        templateAssets.set(scene, { tyreMaps, animations: gltf.animations });
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          // bounds of skinned meshes come from the standing bind pose, not the seated one
          if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial;
            if (std.map) std.map.anisotropy = 8;
            if (std.transparent) std.depthWrite = false;
          }
        });
        scene.updateMatrixWorld(true);
        return scene;
      } catch (err) {
        console.warn("VF26 model not loaded, using the procedural car", err);
        return null;
      }
    })();
  }
  return templatePromise;
}

const WHEELS = ["WHEEL_RF", "WHEEL_LF", "WHEEL_RR", "WHEEL_LR"] as const; // physics wheel order 0..3
const SIDE = ["RF", "LF", "RR", "LR"] as const;

/** Matrix of `obj` relative to `ancestor` (both inside the same, already updated, hierarchy). */
function relativeMatrix(obj: THREE.Object3D, ancestor: THREE.Object3D): THREE.Matrix4 {
  return new THREE.Matrix4().copy(ancestor.matrixWorld).invert().multiply(obj.matrixWorld);
}

function setFromMatrix(obj: THREE.Object3D, m: THREE.Matrix4): void {
  m.decompose(obj.position, obj.quaternion, obj.scale);
}

/**
 * Fractional frame of the driver's steer clip for a steering-wheel angle. `table[i]` is the wheel angle (deg,
 * + = right) that frame i was measured to represent; it is monotonic, flat where the hands stop moving.
 */
function steerFrame(table: number[], deg: number): number {
  let lo = 0;
  let hi = table.length - 1;
  if (deg <= table[lo]) return lo;
  if (deg >= table[hi]) {
    while (hi > 0 && table[hi - 1] >= table[hi]) hi--;
    return hi;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= deg) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  return lo + (span > 1e-6 ? (deg - table[lo]) / span : 0);
}

/**
 * Attach a clone of the VF26 template to an existing car rig.
 * - body + cockpit go into `chassisGroup` (sprung: pitch / roll / heave)
 * - wheels, uprights and discs go into per-corner pivots under `root` (unsprung), steered and spun here
 */
export function attachVf26Model(
  template: THREE.Group,
  root: THREE.Group,
  chassisGroup: THREE.Group
): Vf26ModelInstance {
  const assets = templateAssets.get(template) ?? { tyreMaps: {}, animations: [] };
  const model = cloneSkinned(template) as THREE.Group;
  model.updateMatrixWorld(true);
  const vf = model.getObjectByName("VF26") ?? model;
  const extras = (vf.userData ?? {}) as {
    wheelCentres?: Record<string, [number, number, number]>;
    cameras?: Record<string, { pos: [number, number, number]; pitchDeg: number; fov: number }>;
    driver?: { steerClip: string; fps: number; steerAngleDeg: number[] };
  };
  const find = (name: string) => model.getObjectByName(name);

  // Align the model's front axle with the physics front axle (the rig origin is the CG projected on the
  // ground) and sit the tyres on the ground.
  const cgToFront = VF26_CHASSIS.wheelbase * (1 - VF26_CHASSIS.frontWeightFraction);
  const lf = extras.wheelCentres?.WHEEL_LF ?? [0.731, 0.26, 1.521];
  const tyre = find("WHEEL_LF_TYRE") as THREE.Mesh | undefined;
  tyre?.geometry.computeBoundingBox();
  const tyreRadius = tyre?.geometry.boundingBox ? tyre.geometry.boundingBox.max.y : 0.349;
  const offset = new THREE.Vector3(0, tyreRadius - lf[1], cgToFront - lf[2]);

  const bodyGroup = new THREE.Group();
  bodyGroup.name = "VF26_BODY";
  bodyGroup.position.copy(offset);

  // Per-corner pivots. Built before re-parenting so the bind matrices can be read from the clone.
  interface Corner {
    steer: THREE.Group;
    spin: THREE.Group;
    isFront: boolean;
    isLeft: boolean;
    discMat: THREE.MeshStandardMaterial | null;
  }
  const corners: Corner[] = [];
  WHEELS.forEach((wheelName, i) => {
    const wheel = find(wheelName);
    if (!wheel) return;
    const wheelBind = relativeMatrix(wheel, vf);
    const centre = new THREE.Vector3().setFromMatrixPosition(wheelBind);
    const steer = new THREE.Group();
    steer.name = `VF26_STEER_${SIDE[i]}`;
    steer.position.copy(centre).add(offset);
    const pivotBind = new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z);
    const pivotInv = pivotBind.clone().invert();

    // Upright / hub carrier: steers with the wheel, does not spin
    const upright = find(`SUSP_${SIDE[i]}`);
    if (upright) {
      const m = pivotInv.clone().multiply(relativeMatrix(upright, vf));
      steer.add(upright);
      setFromMatrix(upright, m);
    }
    // Wheel node keeps its camber rotation; rim, tyre and disc spin about its local X axis (the axle)
    const wheelLocal = pivotInv.clone().multiply(wheelBind);
    const wheelInv = wheelBind.clone().invert();
    const spin = new THREE.Group();
    spin.name = `VF26_SPIN_${SIDE[i]}`;
    for (const child of [...wheel.children]) spin.add(child);
    const disc = find(`DISC_${SIDE[i]}`);
    let discMat: THREE.MeshStandardMaterial | null = null;
    if (disc) {
      const m = wheelInv.clone().multiply(relativeMatrix(disc, vf));
      spin.add(disc);
      setFromMatrix(disc, m);
      const dm = disc as THREE.Mesh;
      if (dm.isMesh) {
        discMat = (dm.material as THREE.MeshStandardMaterial).clone();
        discMat.emissive = new THREE.Color(0xff3a0a);
        discMat.emissiveIntensity = 0;
        dm.material = discMat;
      }
    }
    wheel.add(spin);
    steer.add(wheel);
    setFromMatrix(wheel, wheelLocal);
    root.add(steer);
    corners.push({ steer, spin, isFront: i < 2, isLeft: i % 2 === 1, discMat });
  });

  // Belts buckled with a driver in the seat; lying open on the seat otherwise
  const driver = find("DRIVER");
  for (const name of ["BODY", "COCKPIT", "DRIVER", driver ? "HARNESS_ON" : "HARNESS_OFF"]) {
    const part = find(name);
    if (part) bodyGroup.add(part);
  }
  find(driver ? "HARNESS_OFF" : "HARNESS_ON")?.removeFromParent();
  chassisGroup.add(bodyGroup);

  // Driver arms follow the wheel through the mod's driver_steer clip (time set from the wheel angle)
  const helmet = driver?.getObjectByName("HELMET") ?? null;
  const steerTable = extras.driver?.steerAngleDeg ?? [];
  const steerClip = assets.animations.find((a) => a.name === (extras.driver?.steerClip ?? "steer"));
  let driverMixer: THREE.AnimationMixer | null = null;
  let steerAction: THREE.AnimationAction | null = null;
  if (driver && steerClip && steerTable.length > 1) {
    driverMixer = new THREE.AnimationMixer(driver);
    steerAction = driverMixer.clipAction(steerClip);
    steerAction.play();
    steerAction.paused = true;
  }
  const driverFps = extras.driver?.fps ?? 30;

  // Active aero (X-mode) flap poses baked from the mod's DRS animation
  interface AeroPart {
    obj: THREE.Object3D;
    p0: THREE.Vector3;
    q0: THREE.Quaternion;
    p1: THREE.Vector3;
    q1: THREE.Quaternion;
  }
  const aero: AeroPart[] = [];
  bodyGroup.traverse((obj) => {
    const ud = obj.userData as { aeroClosed?: number[]; aeroOpen?: number[] };
    if (!ud.aeroClosed || !ud.aeroOpen) return;
    const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), p1 = new THREE.Vector3(), q1 = new THREE.Quaternion();
    const s = new THREE.Vector3();
    new THREE.Matrix4().fromArray(ud.aeroClosed).decompose(p0, q0, s);
    new THREE.Matrix4().fromArray(ud.aeroOpen).decompose(p1, q1, s);
    aero.push({ obj, p0, q0, p1, q1 });
  });
  let aeroBlend = 0;

  // Steering wheel (STEER_BASE, bind rotation = identity): +rotation.z turns the rim clockwise as seen by
  // the driver (top of the rim moves to the right, -X), i.e. a right turn.
  const steerBase = bodyGroup.getObjectByName("STEER_BASE");
  const lockRad = VF26_CHASSIS.steering.lockDeg * THREE.MathUtils.DEG2RAD;
  const maxRoadWheelRad = lockRad / VF26_CHASSIS.steering.ratio;

  // Shift lights on the wheel rim
  const ledMats: THREE.MeshStandardMaterial[] = [];
  bodyGroup.getObjectByName("LED_RPM_0")?.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
    mesh.material = mat;
    ledMats.push(mat);
  });

  // Tyres share one per-car material so the compound can be swapped without touching other cars
  const tyreMaps = assets.tyreMaps;
  let tyreMat: THREE.MeshStandardMaterial | null = null;
  for (const c of corners) {
    c.spin.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.name.endsWith("_TYRE")) return;
      tyreMat ??= (mesh.material as THREE.MeshStandardMaterial).clone();
      mesh.material = tyreMat;
    });
  }
  const setTireCompound = (compound: TireCompound) => {
    const map = tyreMaps[compound];
    if (!tyreMat || !map || tyreMat.map === map) return;
    tyreMat.map = map;
    tyreMat.needsUpdate = true;
  };

  const cameraAnchors = {} as Vf26ModelInstance["cameraAnchors"];
  const cams = extras.cameras ?? {};
  for (const key of ["cockpit", "tcam", "dash", "bumper", "nearChase", "farChase"] as const) {
    const c = cams[key] ?? { pos: [0, 0.74, 0], pitchDeg: -5, fov: 55 };
    cameraAnchors[key] = {
      pos: new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]).add(offset),
      pitchRad: c.pitchDeg * THREE.MathUtils.DEG2RAD,
      fovDeg: c.fov,
    };
  }
  // Not an AC EVO camera: over the left cockpit rim, behind the eye point, for the sim's shoulder view
  cameraAnchors.shoulder = {
    pos: cameraAnchors.cockpit.pos.clone().add(new THREE.Vector3(0.2, 0.2, -0.22)),
    pitchRad: -9 * THREE.MathUtils.DEG2RAD,
    fovDeg: 58,
  };

  const update = (t: CarTelemetry, wheelRotationRad: number, dtSeconds: number) => {
    // Front wheels: telemetry.steering = road-wheel angle / max angle, + = right. rotation.y + = left.
    const roadWheel = -t.steering * maxRoadWheelRad;
    for (const c of corners) {
      if (c.isFront) {
        // Ackermann: the inside wheel turns a little more
        const inside = (roadWheel > 0) === c.isLeft;
        c.steer.rotation.y = roadWheel * (inside ? 1.06 : 0.94);
      }
      c.spin.rotation.x = wheelRotationRad;
    }
    if (steerBase) steerBase.rotation.z = t.steering * lockRad;
    if (driverMixer && steerAction) {
      steerAction.time = steerFrame(steerTable, t.steering * VF26_CHASSIS.steering.lockDeg) / driverFps;
      driverMixer.update(0);
    }

    const target = t.activeAeroMode === "X_MODE" ? 1 : 0;
    aeroBlend += (target - aeroBlend) * Math.min(1, dtSeconds * 6);
    for (const a of aero) {
      a.obj.position.lerpVectors(a.p0, a.p1, aeroBlend);
      a.obj.quaternion.slerpQuaternions(a.q0, a.q1, aeroBlend);
    }

    corners.forEach((c, i) => {
      if (!c.discMat) return;
      const temp = t.brakeTempsC?.[i] ?? 300;
      c.discMat.emissiveIntensity = THREE.MathUtils.clamp((temp - 520) / 480, 0, 1) * 3.5;
    });
    if (ledMats.length) {
      const rpmFrac = THREE.MathUtils.clamp((t.rpm - 8800) / (12850 - 8800), 0, 1);
      for (const m of ledMats) m.emissiveIntensity = 0.15 + rpmFrac * 3;
    }
  };

  const setHeadVisible = (visible: boolean) => {
    if (helmet) helmet.visible = visible;
  };

  const dispose = () => {
    driverMixer?.stopAllAction();
    bodyGroup.removeFromParent();
    for (const c of corners) c.steer.removeFromParent();
  };

  return { bodyGroup, cameraAnchors, update, setTireCompound, setHeadVisible, dispose };
}

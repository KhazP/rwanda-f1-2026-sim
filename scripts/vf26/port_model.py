"""Convert the Sim Dream "Grand Prix 2026 VF26" AC EVO car into a GLB for the three.js rig.

Usage (paths are arguments; nothing is read from or written into the repo except the output file):

    python -P scripts/vf26/port_model.py <extracted_mod_root> <out.glb> [--tex-max 2048] [--livery-max 4096]

<extracted_mod_root> is the directory that contains `content/cars/gp_2026_vf26/` after unpacking
`Saved Games/ACE/mods/gp_2026_vf26.kspkg` with scripts/vf26/kspkg.py. The output goes to
public/vf26/ (gitignored): the mod's model, textures and sounds are not ours to redistribute.

File formats (reverse-engineered from the package; see scripts/vf26/README.md):
  .mesh      protobuf. #5 = mesh: #4 submeshes {#1 name, #2 first index, #3 index count, #4 material},
             #5 positions f32x3, #6 normals f32x3, #7 uv0 f32x2, #8 tangents f32x4, #9 weights f32x4,
             #10 joints f32x4, #11 indices (packed varints), #12 bones {#1 name, #2 parent, #3 local 4x4
             column-major}, #13 colour f32x4, #14-#16 extra uv sets, #17/#18 bbox. Vertices are in model space
             (bind pose) with rigid single-bone weights; +X left, +Y up, +Z forward; CCW winding.
  .material  protobuf. #1 shader, #4 params {#1 name, #2 value}, #5 textures {#1 name, #2.#2 path}.
             UberVehicleMaterial is a 4-layer material (Base + Red/Green/Blue) blended by the RGB channels of
             `SpatMap`; layers are flattened into one PBR material here.
  .texture   protobuf header {#1 w, #2 h, #3 mips, #4 format, #12 tiling {#1 tile w, #2 tile h}}; pixels are in
             `.texturemips` as 64 KiB tiles (row-major tiles, row-major 4x4 blocks inside a tile), mip 0 first.
             format 34 = BC7, 26 = BC6H unsigned (normal maps), 27 and 13 = BC1.
"""
import argparse
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acformats import FORMATS, read_animation, read_mesh, read_material, decode_texture, texture_header  # noqa: E402

CAR = 'content/cars/gp_2026_vf26'

# Bones whose vertices become separate, animatable nodes. Everything else is merged into the static body.
ANIMATED_EXT = ['SUSP_LF', 'SUSP_RF', 'SUSP_LR', 'SUSP_RR', 'DISC_LF', 'DISC_RF', 'DISC_LR', 'DISC_RR',
                'WING_DRS', 'WING_DRS_2', 'WING_DRS_3', 'WING_DRS_4']
ANIMATED_INT = ['STEER_BASE', 'LED_RPM_0']
WHEELS = {  # node name -> (bone in exterior.mesh, rim mesh, tyre mesh)
    'WHEEL_LF': ('WHEEL_LF', 'gp_2026_sf26_rim_lf', 'gp_2026_tyre_lf'),
    'WHEEL_RF': ('WHEEL_RF', 'gp_2026_sf26_rim_rf', 'gp_2026_tyre_rf'),  # actor uses rim_lf here; rim_rf is the mirrored mesh
    'WHEEL_LR': ('WHEEL_LR', 'gp_2026_sf26_rim_lr', 'gp_2026_tyre_lr'),
    'WHEEL_RR': ('WHEEL_RR', 'gp_2026_sf26_rim_rr', 'gp_2026_tyre_rr'),
}
EXTRA_MESHES = {'HARNESS_ON': 'modded_car_belt_auto', 'HARNESS_OFF': 'modded_car_harness_off'}

# Driver outfit from skins/driver/driver_1.driverfinalstate: base-game mesh -> {submesh: mod material}.
# The meshes, skeleton (driver_body.mesh) and untouched materials live in the base game's content.kspkg.
SKIN = 'content\\cars\\gp_2026_vf26\\skins\\driver\\'
DRIVER_BODY = 'content/characters/0_driver/male_body/meshes/driver_body.mesh'
DRIVER_PARTS = {
    'DRIVER_SUIT': ('content/characters/2_suits/suit_2/mesh/male_suit_2.mesh',
                    {'RT_SUIT_Omp': SKIN + 'suit\\australia\\rt_suit_2.material'}),
    'DRIVER_GLOVES': ('content/characters/3_gloves/gloves_2/meshes/male_gloves_2.mesh',
                      {'RT_GLOVES_Sparco': SKIN + 'gloves\\australia\\rt_gloves_2.material'}),
    'DRIVER_SHOES': ('content/characters/4_shoes/shoes_1/meshes/common_shoes_1.mesh', {}),
}
DRIVER_HELMET = ('content/characters/1_helmets/helmet_2/meshes/helmet_2.mesh',
                 {'RT_HELMET_SKIN': SKIN + 'helmet\\australia_driver_1\\rt_helmet_2.material',
                  'RT_HELMET_GLASS': SKIN + 'helmet\\australia_driver_1\\rt_helmet_2_glass.material'})


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float32), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def bone_worlds(bones):
    names = [b['name'] for b in bones]
    local = [b['matrix'].reshape(4, 4).T.astype(np.float64) for b in bones]
    world = [None] * len(bones)

    def get(i):
        if world[i] is None:
            p = bones[i]['parent']
            world[i] = get(names.index(p)) @ local[i] if p in names else local[i]
        return world[i]
    return {n: get(i) for i, n in enumerate(names)}


# ----------------------------------------------------------------------------------------------- textures
class TextureBank:
    def __init__(self, roots, tex_max, livery_max):
        self.roots, self.tex_max, self.livery_max = roots, tex_max, livery_max
        self.cache = {}

    def path(self, ref):
        """First root that has the file (mod package first, then the base game)."""
        rel = ref.replace(chr(92), '/')
        for r in self.roots:
            p = os.path.join(r, rel)
            if os.path.exists(p):
                return p
        return os.path.join(self.roots[0], rel)

    def exists(self, ref):
        if not ref or not (os.path.exists(self.path(ref) + 'mips') and os.path.exists(self.path(ref))):
            return False
        return texture_header(self.path(ref))['fmt'] in FORMATS

    def size(self, ref):
        h = texture_header(self.path(ref))
        return h['w'], h['h']

    def load(self, ref, max_size):
        """Return float32 RGBA array (0..1, raw channel values) at <= max_size."""
        key = (ref, max_size)
        if key not in self.cache:
            h = texture_header(self.path(ref))
            mip = 0
            w, hh = h['w'], h['h']
            while max(w, hh) > max_size and mip + 1 < h['mips']:
                mip += 1
                w, hh = max(1, w // 2), max(1, hh // 2)
            img = decode_texture(self.path(ref), mip)
            self.cache[key] = np.asarray(img.convert('RGBA'), dtype=np.float32) / 255.0
        return self.cache[key]

    def mean(self, ref, channel=0):
        a = self.load(ref, 64)
        return float(a[..., channel].mean())


def green_is_down(a):
    """Guess a normal map's green convention: True = DirectX (green points down the image), False = OpenGL.

    Each texture is tested on its own because the package mixes both (the mod's suit/gloves integrate as OpenGL,
    the car's bolt/hub maps as DirectX). The convention whose gradient field is closest to integrable (smallest
    Frankot-Chellappa residual) wins; near-ties keep DirectX.
    """
    s = max(1, max(a.shape[:2]) // 512)
    H, W = a.shape[0] // s * s, a.shape[1] // s * s
    n = a[:H, :W, :3].reshape(H // s, s, W // s, s, 3).mean((1, 3)) * 2 - 1
    nz = np.clip(n[..., 2], 0.2, 1)
    p = -n[..., 0] / nz
    wx, wy = np.meshgrid(np.fft.fftfreq(p.shape[1]) * 2 * np.pi, np.fft.fftfreq(p.shape[0]) * 2 * np.pi)
    den = wx ** 2 + wy ** 2
    den[0, 0] = 1

    def residual(q):
        P, Q = np.fft.fft2(p), np.fft.fft2(q)
        Z = (-1j * wx * P - 1j * wy * Q) / den
        pz, qz = np.real(np.fft.ifft2(1j * wx * Z)), np.real(np.fft.ifft2(1j * wy * Z))
        return np.sqrt(((p - pz) ** 2 + (q - qz) ** 2).sum() / ((p ** 2 + q ** 2).sum() + 1e-12))
    gl, dx = residual(n[..., 1] / nz), residual(-n[..., 1] / nz)
    return not gl < dx * 0.9


def resize_to(a, w, h):
    if a.shape[1] == w and a.shape[0] == h:
        return a
    chans = []
    for c in range(a.shape[2]):
        im = Image.fromarray(a[..., c].astype(np.float32), mode='F').resize((w, h), Image.BILINEAR)
        chans.append(np.asarray(im))
    return np.stack(chans, -1)


# ----------------------------------------------------------------------------------------------- materials
LAYERS = ('Red', 'Green', 'Blue')


def flatten_material(name, mat_path, bank, livery_ref):
    """Flatten an AC EVO layered material into glTF PBR inputs.

    Returns dict(baseColor=(4,), metallic, roughness, clearcoat, clearcoatRoughness, emissive=(3,),
    alphaMode, images={'baseColor': rgba float array sRGB-encoded, 'normal': rgb, 'mr': rgb, 'occlusion': rgb},
    doubleSided).
    """
    out = dict(name=name, baseColor=[1, 1, 1, 1], metallic=0.0, roughness=0.6, clearcoat=0.0,
               clearcoatRoughness=0.1, emissive=[0, 0, 0], alphaMode='OPAQUE', alphaCutoff=0.5,
               images={}, doubleSided=False)
    if not mat_path or not os.path.exists(mat_path):
        # common_assets mirror materials are not in the mod package: dark mirror glass
        out.update(baseColor=[0.02, 0.02, 0.02, 1], metallic=1.0, roughness=0.05)
        return out
    shader, P, T = read_material(mat_path)
    g = lambda k, d=0.0: P.get(k, d) if not isinstance(P.get(k, d), tuple) else (P.get(k) or d)

    def vec3(k):
        v = P.get(k, ())
        v = tuple(v) + (0.0,) * (3 - len(v)) if isinstance(v, tuple) else (v, v, v)
        return np.array(v[:3], dtype=np.float32)

    def tex(k):
        ref = T.get(k)
        return ref if ref and not ref.startswith('editor') and bank.exists(ref) else None

    def uv_tiled(layer, kind=''):
        s = P.get(f'{layer}_UVscale{kind}', ())
        if s == () and kind:
            s = P.get(f'{layer}_UVscale', ())
        return isinstance(s, tuple) and len(s) >= 1 and any(abs(x - 1.0) > 1e-3 for x in s if x != 0.0)

    base_map = tex('Base_BaseColorMap') if g('Base_HasBaseColorMap') or 'Base_HasBaseColorMap' not in P else None
    splat_ref = tex('SpatMap')
    # Resolution of baked maps
    W = H = 0
    for ref in (base_map, splat_ref):
        if ref:
            w, h = bank.size(ref)
            cap = bank.livery_max if ref == livery_ref else bank.tex_max
            s = min(1.0, cap / max(w, h))
            W, H = max(W, int(w * s)), max(H, int(h * s))
    textured = W > 0
    shape = (H, W) if textured else (1, 1)

    def const(v, n):
        return np.broadcast_to(np.asarray(v, dtype=np.float32).reshape((1, 1, n)), shape + (n,)).copy()

    def load_rgba(ref):
        a = bank.load(ref, max(W, H) if textured else 64)
        return resize_to(a, W, H) if textured else a.mean((0, 1), keepdims=True)

    # Base layer
    if base_map:
        a = load_rgba(base_map)
        albedo = srgb_to_linear(a[..., :3])
        alpha = a[..., 3:4]
    else:
        albedo = const(vec3('Base_Basecolor'), 3)
        alpha = const(1.0, 1)
    base_albedo = albedo if base_map else 1.0
    rough = const(g('Base_Roughness') if 'Base_Roughness' in P else 0.5, 1)   # unset -> engine default map
    metal = const(g('Base_Metalness'), 1)
    cc = const(g('Base_ClearCoat'), 1)
    ccr = const(g('Base_ClearCoatRoughness'), 1)
    if g('Base_HasRoughnessMap') and tex('Base_RoughnessMap'):
        r = tex('Base_RoughnessMap')
        rough = rough * 0 + (load_rgba(r)[..., :1] if not uv_tiled('Base', 'Pbr') else bank.mean(r))
    if g('Base_HasMetalnessMap') and tex('Base_MetalnessMap'):
        r = tex('Base_MetalnessMap')
        metal = metal * 0 + (load_rgba(r)[..., :1] if not uv_tiled('Base', 'Pbr') else bank.mean(r))

    splat = load_rgba(splat_ref)[..., :3] if splat_ref else const((1.0, 1.0, 1.0), 3)
    for li, L in enumerate(LAYERS):
        if not g(f'{L}_Enable'):
            continue
        s = splat[..., li:li + 1]
        if float(s.max()) <= 1e-3:
            continue
        if g(f'{L}_HasBaseColorMap') and tex(f'{L}_BaseColorMap') and not uv_tiled(L):
            lc = srgb_to_linear(load_rgba(tex(f'{L}_BaseColorMap'))[..., :3])
        elif g(f'{L}_HasBaseColorMap') and tex(f'{L}_BaseColorMap'):
            lc = srgb_to_linear(bank.load(tex(f'{L}_BaseColorMap'), 64)[..., :3].mean((0, 1)))
        else:
            lc = vec3(f'{L}_Basecolor')
        # A layer without its own colour map replaces the tint of the base colour map, not the map itself.
        # Inferred: the base game's suit is a white map tinted grey/red by its Green/Blue layers, and the mod
        # keeps those layers (Green covering ~98% of the suit) over a full livery map.
        has_layer_map = bool(g(f'{L}_HasBaseColorMap') and tex(f'{L}_BaseColorMap'))
        replace_colour = lc if has_layer_map else base_albedo * lc

        def blend(dst, src, what):
            # Each property opts in explicitly: <L>OverrideReplace_X / OverrideMultiply_X /
            # OverrideCombine_AdditiveX; with no flag the layer leaves that property alone.
            if g(f'{L}Ignore_{what}'):
                return dst
            if g(f'{L}OverrideReplace_{what}'):
                if what == 'BaseColor':
                    src = replace_colour
                return dst * (1 - s) + src * s
            if g(f'{L}OverrideMultiply_{what}'):
                return dst * (1 - s + s * src)
            if g(f'{L}OverrideCombine_Additive{what}'):
                return dst + src * s
            return dst
        albedo = blend(albedo, lc, 'BaseColor')
        lr = g(f'{L}_Roughness')
        if g(f'{L}_HasRoughnessMap') and tex(f'{L}_RoughnessMap'):
            lr = bank.mean(tex(f'{L}_RoughnessMap')) if uv_tiled(L, 'Pbr') else load_rgba(tex(f'{L}_RoughnessMap'))[..., :1]
        rough = blend(rough, lr, 'Roughness')
        lm = g(f'{L}_Metalness')
        if g(f'{L}_HasMetalnessMap') and tex(f'{L}_MetalnessMap'):
            lm = bank.mean(tex(f'{L}_MetalnessMap')) if uv_tiled(L, 'Pbr') else load_rgba(tex(f'{L}_MetalnessMap'))[..., :1]
        metal = blend(metal, lm, 'Metalness')
        cc = blend(cc, g(f'{L}_ClearCoat'), 'ClearCoat')
        ccr = blend(ccr, g(f'{L}_ClearCoatRoughness'), 'ClearCoatRoughness')

    rough = np.clip(rough, 0.03, 1.0)
    metal = np.clip(metal, 0.0, 1.0)

    # Opacity
    blend_mode = int(g('blendMode'))
    if g('Base_HasOpacityMap') and tex('Base_OpacityMap'):
        alpha = load_rgba(tex('Base_OpacityMap'))[..., :1]
    if g('UseOpacityOverride'):
        alpha = alpha * 0 + g('OpacityOverride')
    if blend_mode == 1:
        out['alphaMode'] = 'BLEND'
    elif blend_mode == 2 or float(alpha.min()) < 0.5:
        out['alphaMode'] = 'MASK' if float(alpha.min()) < 0.99 else 'OPAQUE'
    if shader == 'VehicleGlass':
        out['alphaMode'] = 'BLEND'
        out['doubleSided'] = True

    # Emissive
    em = vec3('Base_EmissiveColor') * float(g('Base_EmissiveIntensity', 1.0) or 1.0)
    out['emissive'] = [float(x) for x in np.clip(em, 0, 1)]
    if g('Base_HasEmissiveMap') and tex('Base_EmissiveMap'):
        out['images']['emissive'] = linear_to_srgb(srgb_to_linear(load_rgba(tex('Base_EmissiveMap'))[..., :3]))
        out['emissive'] = [1.0, 1.0, 1.0]

    # Scalars or textures
    if textured:
        out['images']['baseColor'] = np.concatenate([linear_to_srgb(albedo), alpha], -1)
        if float(np.ptp(rough)) > 0.02 or float(np.ptp(metal)) > 0.02:
            out['images']['mr'] = np.concatenate([np.ones_like(rough), rough, metal], -1)
        else:
            out['roughness'], out['metallic'] = float(rough.mean()), float(metal.mean())
    else:
        out['baseColor'] = [float(x) for x in albedo.reshape(-1, 3).mean(0)] + [float(alpha.mean())]
        out['roughness'], out['metallic'] = float(rough.mean()), float(metal.mean())
    if 'mr' in out['images']:
        out['roughness'], out['metallic'] = 1.0, 1.0
    out['clearcoat'] = float(cc.mean())
    if g('Base_HasClearCoatMap') and tex('Base_ClearCoatMap'):   # clearcoat mask (e.g. tyre sidewall lettering)
        out['clearcoat'] *= bank.mean(tex('Base_ClearCoatMap'))
    out['clearcoatRoughness'] = float(ccr.mean())

    # Normal map (base layer only; layer detail normals tile hundreds of times and are skipped)
    if g('Base_HasNormalMap') and tex('Base_NormalMap') and not uv_tiled('Base', 'Normal'):
        n = bank.load(tex('Base_NormalMap'), bank.tex_max // 2).copy()
        if green_is_down(n):
            n[..., 1] = 1 - n[..., 1]                      # DirectX -> glTF/OpenGL
        out['images']['normal'] = n
        out['normalScale'] = min(2.0, float(g('Base_NormalScale', 1.0) or 1.0))
    # Ambient occlusion (R channel, uv0); 8x8 placeholders like AC_silver are skipped
    ao = tex('Base_AmbientOcclusionMap')
    if ao and (g('Base_HasAmbientOcclusionMap') or 'Base_HasAmbientOcclusionMap' not in P) and min(bank.size(ao)) >= 128:
        out['images']['occlusion'] = bank.load(ao, bank.tex_max)
    out['extras'] = dict(acShader=shader, acMaterial=os.path.basename(mat_path))
    return out


def encode_image(kind, a):
    """float array -> (mime, bytes). Normal maps arrive in OpenGL convention; z is rebuilt from x and y."""
    if kind == 'normal':
        x = a[..., 0] * 2 - 1
        y = a[..., 1] * 2 - 1
        z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
        rgb = np.stack([x * 0.5 + 0.5, y * 0.5 + 0.5, z * 0.5 + 0.5], -1)
        img = Image.fromarray((rgb * 255 + 0.5).astype(np.uint8), 'RGB')
        quality = 92
    elif kind == 'occlusion':
        r = a[..., 0]
        img = Image.fromarray((np.stack([r, r, r], -1) * 255 + 0.5).astype(np.uint8), 'RGB')
        quality = 80
    elif kind == 'baseColor' and a.shape[-1] == 4 and float(a[..., 3].min()) < 0.995:
        img = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
        quality = 88
    else:
        img = Image.fromarray((np.clip(a[..., :3], 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB')
        quality = 88
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=quality, method=6)
    return 'image/webp', buf.getvalue()


# ----------------------------------------------------------------------------------------------- glTF writer
class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.j = dict(asset=dict(version='2.0', generator='scripts/vf26/port_model.py'), scene=0,
                      scenes=[dict(nodes=[0])], nodes=[dict(name='VF26', children=[])], meshes=[], materials=[],
                      accessors=[], bufferViews=[], buffers=[], textures=[], images=[], samplers=[
                          dict(magFilter=9729, minFilter=9987, wrapS=10497, wrapT=10497)],
                      extensionsUsed=['EXT_texture_webp', 'KHR_materials_clearcoat'],
                      extensionsRequired=['EXT_texture_webp'])
        self.material_index = {}
        self.image_cache = {}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = dict(buffer=0, byteOffset=len(self.bin), byteLength=len(data))
        if target:
            v['target'] = target
        self.bin += data
        self.j['bufferViews'].append(v)
        return len(self.j['bufferViews']) - 1

    def accessor(self, arr, kind, target=None, minmax=False, normalized=False):
        arr = np.ascontiguousarray(arr)
        ctype = {np.dtype('float32'): 5126, np.dtype('uint32'): 5125, np.dtype('uint16'): 5123,
                 np.dtype('int16'): 5122, np.dtype('uint8'): 5121, np.dtype('int8'): 5120}[arr.dtype]
        acc = dict(bufferView=self.view(arr.tobytes(), target), componentType=ctype, count=int(arr.shape[0]), type=kind)
        if normalized:
            acc['normalized'] = True
        if minmax:
            acc['min'] = [float(x) for x in arr.min(0)]
            acc['max'] = [float(x) for x in arr.max(0)]
        self.j['accessors'].append(acc)
        return len(self.j['accessors']) - 1

    def texture(self, key, kind, arr):
        if key not in self.image_cache:
            mime, data = encode_image(kind, arr)
            self.j['images'].append(dict(bufferView=self.view(data), mimeType=mime, name=key))
            self.j['textures'].append(dict(sampler=0, extensions=dict(EXT_texture_webp=dict(source=len(self.j['images']) - 1))))
            self.image_cache[key] = len(self.j['textures']) - 1
        return self.image_cache[key]

    def material(self, m):
        if m['name'] in self.material_index:
            return self.material_index[m['name']]
        pbr = dict(baseColorFactor=[float(x) for x in m['baseColor']], metallicFactor=m['metallic'],
                   roughnessFactor=m['roughness'])
        mat = dict(name=m['name'], pbrMetallicRoughness=pbr, alphaMode=m['alphaMode'], doubleSided=m['doubleSided'],
                   extras=m.get('extras', {}))
        if m['alphaMode'] == 'MASK':
            mat['alphaCutoff'] = m['alphaCutoff']
        im = m['images']
        if 'baseColor' in im:
            pbr['baseColorTexture'] = dict(index=self.texture(m['name'] + '_c', 'baseColor', im['baseColor']))
            pbr['baseColorFactor'] = [1, 1, 1, pbr['baseColorFactor'][3] if 'baseColor' not in im else 1]
        if 'mr' in im:
            pbr['metallicRoughnessTexture'] = dict(index=self.texture(m['name'] + '_mr', 'mr', im['mr']))
        if 'normal' in im:
            mat['normalTexture'] = dict(index=self.texture(m['name'] + '_n', 'normal', im['normal']),
                                        scale=m.get('normalScale', 1.0))
        if 'occlusion' in im:
            mat['occlusionTexture'] = dict(index=self.texture(m['name'] + '_ao', 'occlusion', im['occlusion']))
        if 'emissive' in im:
            mat['emissiveTexture'] = dict(index=self.texture(m['name'] + '_e', 'emissive', im['emissive']))
        if any(m['emissive']):
            mat['emissiveFactor'] = m['emissive']
        if m['clearcoat'] > 0.01:
            mat['extensions'] = dict(KHR_materials_clearcoat=dict(clearcoatFactor=m['clearcoat'],
                                                                  clearcoatRoughnessFactor=m['clearcoatRoughness']))
        self.j['materials'].append(mat)
        self.material_index[m['name']] = len(self.j['materials']) - 1
        return self.material_index[m['name']]

    def node(self, name, parent=0, matrix=None, mesh=None, trs=False):
        """trs=True writes translation/rotation/scale instead of a matrix (required for animated nodes)."""
        n = dict(name=name)
        if trs and matrix is not None:
            t, q, s = decompose(matrix)
            n.update(translation=[float(x) for x in t], rotation=[float(x) for x in q])
            if np.abs(s - 1).max() > 1e-5:
                n['scale'] = [float(x) for x in s]
        elif matrix is not None and not np.allclose(matrix, np.eye(4), atol=1e-7):
            n['matrix'] = [float(x) for x in matrix.T.reshape(-1)]   # column-major
        if mesh is not None:
            n['mesh'] = mesh
        self.j['nodes'].append(n)
        idx = len(self.j['nodes']) - 1
        self.j['nodes'][parent].setdefault('children', []).append(idx)
        return idx

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j['buffers'] = [dict(byteLength=len(self.bin))]
        js = json.dumps(self.j, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin)))
            f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin))


def decompose(m):
    """4x4 (no shear) -> translation, quaternion (x, y, z, w), scale."""
    t = m[:3, 3].copy()
    s = np.linalg.norm(m[:3, :3], axis=0)
    r = m[:3, :3] / s
    tr = np.trace(r)
    if tr > 0:
        k = 2 * np.sqrt(tr + 1)
        q = [(r[2, 1] - r[1, 2]) / k, (r[0, 2] - r[2, 0]) / k, (r[1, 0] - r[0, 1]) / k, k / 4]
    else:
        i = int(np.argmax(np.diag(r)))
        j, l = (i + 1) % 3, (i + 2) % 3
        k = 2 * np.sqrt(1 + r[i, i] - r[j, j] - r[l, l])
        q = [0.0] * 4
        q[i], q[j], q[l], q[3] = k / 4, (r[j, i] + r[i, j]) / k, (r[l, i] + r[i, l]) / k, (r[l, j] - r[j, l]) / k
    q = np.array(q)
    return t, q / np.linalg.norm(q), s


# ----------------------------------------------------------------------------------------------- mesh export
def add_mesh(glb, name, M, vert_mask, xform, materials, skinned=False):
    """Add the triangles whose vertices all satisfy vert_mask as one glTF mesh (one primitive per submesh).

    xform: 4x4 applied to positions (normals use its rotation) to move model-space data into node space.
    skinned: also write JOINTS_0/WEIGHTS_0 (joint indices = the mesh's own bone order).
    Returns mesh index or None if empty.
    """
    idx = M['idx'].astype(np.int64)
    prims = []
    used_all = []
    for s in M['subs']:
        tri = idx[s['start']:s['start'] + s['count']].reshape(-1, 3)
        keep = vert_mask[tri].all(1)
        if keep.any():
            prims.append((s, tri[keep]))
            used_all.append(tri[keep].reshape(-1))
    if not prims:
        return None
    used = np.unique(np.concatenate(used_all))
    remap = -np.ones(len(M['pos']), dtype=np.int64)
    remap[used] = np.arange(len(used))
    R = xform[:3, :3]
    pos = (M['pos'][used].astype(np.float64) @ R.T + xform[:3, 3]).astype(np.float32)
    nrm = M['nrm'][used].astype(np.float64) @ R.T
    nrm = (nrm / np.maximum(1e-9, np.linalg.norm(nrm, axis=1, keepdims=True))).astype(np.float32)
    uv = M['uv0'][used].astype(np.float32)
    a_pos = glb.accessor(pos, 'VEC3', 34962, minmax=True)
    a_nrm = glb.accessor(nrm, 'VEC3', 34962)
    a_uv = glb.accessor(uv, 'VEC2', 34962)
    attrs = dict(POSITION=a_pos, NORMAL=a_nrm, TEXCOORD_0=a_uv)
    if skinned:
        w = M['weights'][used].astype(np.float32)
        w /= np.maximum(1e-9, w.sum(1, keepdims=True))
        attrs['JOINTS_0'] = glb.accessor((M['joints'][used] * (w > 0)).astype(np.uint8), 'VEC4', 34962)
        attrs['WEIGHTS_0'] = glb.accessor(w, 'VEC4', 34962)
    out = []
    small = len(used) < 65536
    for s, tri in prims:
        ind = remap[tri].reshape(-1).astype(np.uint16 if small else np.uint32)
        out.append(dict(attributes=attrs, indices=glb.accessor(ind, 'SCALAR', 34963), mode=4,
                        material=glb.material(materials[s['material']])))
    glb.j['meshes'].append(dict(name=name, primitives=out))
    return len(glb.j['meshes']) - 1


def export_driver(glb, args, car, roots, materials, steer_base):
    """Add the AC EVO driver: driver_body's skeleton seated by the mod's driver animations, the suit/gloves/shoes
    skinned to it (per-mesh inverse bind matrices; their bind poses differ slightly), the helmet rigid on A_Head,
    and a 'steer' clip whose time the runtime drives from the steering-wheel angle.

    Returns root extras: the wheel angle each clip frame corresponds to.
    """
    droot = args.driver_root
    body = read_mesh(os.path.join(droot, DRIVER_BODY))
    par = {b['name']: b['parent'] for b in body['bones']}
    local = {b['name']: b['matrix'].reshape(4, 4).T.astype(np.float64) for b in body['bones']}
    anim = os.path.join(car, 'animations', 'driver_animations')
    steer, fps = read_animation(os.path.join(anim, 'driver_steer.animation'))
    position, _ = read_animation(os.path.join(anim, 'driver_position.animation'))
    n_frames = len(steer['COG'])
    mid = n_frames // 2                      # frame 121 of 242: hands on the grips at 9 and 3 o'clock
    for n, fr in position.items():           # seated pose (every frame is identical); steer drives the upper body
        local[n] = fr[0]

    def pose(frame):
        loc = dict(local)
        loc.update({n: fr[frame] for n, fr in steer.items()})
        W = {}

        def get(n):
            if n not in W:
                W[n] = (get(par[n]) if par[n] in par else np.eye(4)) @ loc[n]
            return W[n]
        return get

    # The actor gives no lock for driver_steer, so measure the wheel angle each frame represents: the angle of
    # the hand that stays on its grip (right hand turning left, left hand turning right) about the STEER_BASE
    # column. + = clockwise from the seat (right turn). The hands stop past about -279/+246 degrees.
    centre, ex, ey = steer_base[:3, 3], steer_base[:3, 0], steer_base[:3, 1]
    ang = {'LeftHandMiddle1': [], 'RightHandMiddle1': []}
    for k in range(n_frames):
        get = pose(k)
        for hand, out in ang.items():
            p = get(hand)[:3, 3] - centre
            out.append(np.arctan2(-p @ ex, p @ ey))   # +X is left in model space
    L, R = (np.unwrap(ang[h]) for h in ('LeftHandMiddle1', 'RightHandMiddle1'))
    theta = np.degrees(np.where(np.arange(n_frames) >= mid, L - L[mid], R - R[mid]))
    theta = np.maximum.accumulate(theta)     # monotonic for the runtime lookup

    def is_driver_bone(n):
        while n in par:
            if n == 'COG':
                return True
            n = par[n]
        return False

    rest = dict(local)
    rest.update({n: fr[mid] for n, fr in steer.items()})
    drv = glb.node('DRIVER', 0)
    joint = {}

    def make(n):
        if n not in joint:
            parent = make(par[n]) if par[n] in par else drv
            joint[n] = glb.node(n, parent, rest[n], trs=True)
        return joint[n]
    for n in par:
        if is_driver_bone(n):
            make(n)

    dbank = TextureBank(roots, args.driver_tex_max, args.driver_tex_max)

    def part_mesh(path, overrides):
        M = read_mesh(os.path.join(droot, path))
        for s in M['subs']:
            ref = s['material'] = overrides.get(s['name'], s['material'])
            if ref not in materials:
                name = 'DRV_' + os.path.splitext(os.path.basename(ref.replace(chr(92), '/')))[0]
                p = dbank.path(ref)
                print('material', name, file=sys.stderr)
                m = flatten_material(name, p if os.path.exists(p) else None, dbank, None)
                if m['extras'].get('acShader', '').startswith('VehicleGlass'):
                    # Smoked visor. Kept nearly opaque: the head mesh (Male_Head_Caucasian) is not ported, and
                    # the meaning of the opacity mask's packed channels is unknown.
                    m.update(baseColor=[0.02, 0.022, 0.025, 0.9], metallic=0.6, roughness=0.05, clearcoat=0.0,
                             alphaMode='BLEND', doubleSided=False, images={})
                materials[ref] = m
        return M

    for node_name, (path, overrides) in DRIVER_PARTS.items():
        M = part_mesh(path, overrides)
        Wb = bone_worlds(M['bones'])
        names = [b['name'] for b in M['bones']]
        keep = [i for i, n in enumerate(names) if n in joint]
        weighted = {names[i] for i in np.unique(M['joints'][M['weights'] > 0].astype(np.int64))}
        assert weighted <= set(joint), (node_name, sorted(weighted - set(joint)))
        remap = np.zeros(len(names), np.int64)
        remap[keep] = np.arange(len(keep))
        M['joints'] = np.where(M['weights'] > 0, remap[M['joints'].astype(np.int64)], 0).astype(np.float32)
        ibm = np.stack([np.linalg.inv(Wb[names[i]]) for i in keep]).astype(np.float32)
        glb.j.setdefault('skins', []).append(dict(
            name=node_name, joints=[joint[names[i]] for i in keep], skeleton=joint['COG'],
            inverseBindMatrices=glb.accessor(np.ascontiguousarray(ibm.transpose(0, 2, 1)).reshape(-1, 16), 'MAT4')))
        mi = add_mesh(glb, node_name, M, np.ones(len(M['pos']), bool), np.eye(4), materials, skinned=True)
        glb.j['nodes'][glb.node(node_name, drv, None, mi)]['skin'] = len(glb.j['skins']) - 1

    H = part_mesh(*DRIVER_HELMET)
    # helmet vertices are in a head-centred frame: HELMET_BASE has A_Head's bind rotation and no offset
    hb = bone_worlds(H['bones'])['HELMET_BASE']
    mi = add_mesh(glb, 'HELMET', H, np.ones(len(H['pos']), bool), np.eye(4), materials)
    glb.node('HELMET', joint['A_Head'], np.linalg.inv(hb), mi)

    # 'steer' clip: one keyframe per animation frame
    t_acc = glb.accessor((np.arange(n_frames, dtype=np.float32) / fps).reshape(-1, 1), 'SCALAR', minmax=True)
    channels, samplers = [], []
    for n, frames in steer.items():
        if n not in joint:
            continue
        T, Q = zip(*[decompose(m)[:2] for m in frames])
        T, Q = np.array(T, np.float32), np.array(Q)
        for k in range(1, len(Q)):
            if Q[k] @ Q[k - 1] < 0:
                Q[k] = -Q[k]
        for path, data in (('translation', T), ('rotation', Q.astype(np.float32))):
            if float(np.ptp(data, 0).max()) > 1e-5:
                samplers.append(dict(input=t_acc, output=glb.accessor(data, 'VEC3' if path == 'translation' else 'VEC4'),
                                     interpolation='LINEAR'))
                channels.append(dict(sampler=len(samplers) - 1, target=dict(node=joint[n], path=path)))
    glb.j['animations'] = [dict(name='steer', channels=channels, samplers=samplers)]
    print(f'driver: {len(joint)} bones, {len(channels)} steer channels, wheel {theta[0]:.0f}..{theta[-1]:.0f} deg',
          file=sys.stderr)
    return dict(steerClip='steer', fps=float(fps), steerAngleDeg=[round(float(x), 2) for x in theta])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('out')
    ap.add_argument('--tex-max', type=int, default=2048)
    ap.add_argument('--livery-max', type=int, default=4096)
    ap.add_argument('--livery', default='car_chassis', help='texture name in texture/ used as EXT_SKIN base colour')
    ap.add_argument('--driver-root', help='base-game extract containing content/characters/ (adds the driver)')
    ap.add_argument('--driver-tex-max', type=int, default=1024)
    args = ap.parse_args()
    root = args.root
    car = os.path.join(root, CAR)
    roots = [root] + ([args.driver_root] if args.driver_root else [])
    bank = TextureBank(roots, args.tex_max, args.livery_max)
    livery_ref = f'content\\cars\\gp_2026_vf26\\texture\\{args.livery}.texture'

    meshes = {n: read_mesh(os.path.join(car, 'meshes', n + '.mesh')) for n in
              ['gp_2026_sf_26_exterior', 'gp_2026_sf_26_interior'] + [v for w in WHEELS.values() for v in w[1:]]
              + list(EXTRA_MESHES.values())}

    # Materials
    materials = {}
    for M in meshes.values():
        for s in M['subs']:
            ref = s['material']
            if ref in materials:
                continue
            p = os.path.join(root, ref.replace(chr(92), '/'))
            name = os.path.splitext(os.path.basename(ref.replace(chr(92), '/')))[0]
            if name == 'EXT_SKIN' and args.livery != 'car_chassis':
                pass
            print('material', name, file=sys.stderr)
            materials[ref] = flatten_material(name, p if os.path.exists(p) else None, bank, livery_ref)

    glb = GLB()
    root_node = 0
    parent_space = {}

    def export_skinned(mesh_name, node_prefix, animated):
        M = meshes[mesh_name]
        W = bone_worlds(M['bones'])
        names = [b['name'] for b in M['bones']]
        joint = M['joints'][:, 0].astype(np.int64)
        anim_ids = {names.index(b): b for b in animated if b in names}
        static_mask = ~np.isin(joint, list(anim_ids))
        mi = add_mesh(glb, node_prefix, M, static_mask, np.eye(4), materials)
        body = glb.node(node_prefix, root_node, None, mi)
        nodes = {}
        for bi, bname in anim_ids.items():
            parent = M['bones'][bi]['parent']
            pnode = nodes.get(parent, body)
            pw = W[parent] if parent in nodes else np.eye(4)
            local = np.linalg.inv(pw) @ W[bname]
            mi = add_mesh(glb, bname, M, joint == bi, np.linalg.inv(W[bname]), materials)
            nodes[bname] = glb.node(bname, pnode, local, mi)
            # maps the bone's own parent space (what .animation tracks are expressed in) to the node's parent space
            parent_space[bname] = np.linalg.inv(pw) @ (W[parent] if parent in W else np.eye(4))
        return W

    W_ext = export_skinned('gp_2026_sf_26_exterior', 'BODY', ANIMATED_EXT)
    export_skinned('gp_2026_sf_26_interior', 'COCKPIT', ANIMATED_INT)
    for node, (bone, rim, tyre) in WHEELS.items():
        wn = glb.node(node, root_node, W_ext[bone])
        for part, mname in (('RIM', rim), ('TYRE', tyre)):
            M = meshes[mname]
            mi = add_mesh(glb, f'{node}_{part}', M, np.ones(len(M['pos']), bool), np.eye(4), materials)
            glb.node(f'{node}_{part}', wn, None, mi)
    for node, mname in EXTRA_MESHES.items():
        M = meshes[mname]
        mi = add_mesh(glb, node, M, np.ones(len(M['pos']), bool), np.eye(4), materials)
        glb.node(node, root_node, None, mi)

    steer_base = bone_worlds(meshes['gp_2026_sf_26_interior']['bones'])['STEER_BASE']
    driver_extras = export_driver(glb, args, car, roots, materials, steer_base) if args.driver_root else None

    # Per-compound tyre diffuse maps (tyres/textures/f1_2026_<compound>.tyretextures field #5); the runtime
    # swaps EXT_TYRE's base colour map with these when the compound changes
    tyre_maps = {}
    bs = chr(92)
    for compound, parts in (('soft', ['tyres', 'textures', 'soft', 'RTT_TIRE_DIFFUSE']),
                            ('medium', ['texture', 'RTT_TIRE_Diffuse']),
                            ('hard', ['tyres', 'textures', 'hard', 'RTT_TIRE_DIFFUSE'])):
        tref = bs.join(['content', 'cars', 'gp_2026_vf26'] + parts) + '.texture'
        if bank.exists(tref):
            tyre_maps[compound] = glb.texture('tyre_' + compound, 'baseColor', bank.load(tref, args.tex_max)[..., :3])

    # Active-aero / DRS pose from the mod's wing animation: first frame = closed, last frame = open (local)
    tracks, _ = read_animation(os.path.join(car, 'animations', 'ferrari_sf26_ext_wing.animation'))
    for n in glb.j['nodes']:
        fr = tracks.get(n['name'])
        if fr and not np.allclose(fr[0], fr[-1], atol=1e-6):
            pre = parent_space.get(n['name'], np.eye(4))
            n.setdefault('extras', {})['aeroClosed'] = [float(x) for x in (pre @ fr[0]).T.reshape(-1)]
            n['extras']['aeroOpen'] = [float(x) for x in (pre @ fr[-1]).T.reshape(-1)]

    # Rig metadata the runtime needs (bind-pose pivots in model space, metres)
    glb.j['nodes'][0]['extras'] = dict(
        wheelCentres={k: [float(x) for x in W_ext[v[0]][:3, 3]] for k, v in WHEELS.items()},
        steerBase=[float(x) for x in bone_worlds(meshes['gp_2026_sf_26_interior']['bones'])['STEER_BASE'][:3, 3]],
        # gp_2026_vf26.actor camera list (#10: {#1 {#1 pos, #2 rot (pitch, yaw)}, #2 {name, fov}}), model space
        cameras=dict(cockpit=dict(pos=[0, 0.74, 0], pitchDeg=-5.865, fov=55),
                     tcam=dict(pos=[0.09, 1.06, -0.36], pitchDeg=-12.3, fov=55),
                     dash=dict(pos=[0, 0.74, 0.311], pitchDeg=-0.02, fov=55),
                     bumper=dict(pos=[0, 0.711, 2.381], pitchDeg=-0.165, fov=55),
                     nearChase=dict(pos=[0, 1.8, -5.095], pitchDeg=-5, fov=55),
                     farChase=dict(pos=[0, 2.5, -6.425], pitchDeg=-5, fov=55)),
        tyreMaps=tyre_maps,
        **({'driver': driver_extras} if driver_extras else {}),
        source='Sim Dream Grand Prix 2026 VF26 (AC EVO mod) - converted locally, not for redistribution')
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    glb.write(args.out)
    print(f'wrote {args.out} {os.path.getsize(args.out) / 1e6:.1f} MB, {len(glb.j["meshes"])} meshes, '
          f'{len(glb.j["materials"])} materials, {len(glb.j["images"])} images', file=sys.stderr)


if __name__ == '__main__':
    main()

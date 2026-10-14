"""Readers for the AC EVO file formats used by the VF26 mod (protobuf meshes/materials, tiled BCn textures).

Field numbers were inferred from the package contents (no schema is shipped); see port_model.py for the map.
"""
import os
import struct

import numpy as np
from PIL import Image


# ----------------------------------------------------------------------------------------------- protobuf
def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def parse(b, start, end):
    """Parse one protobuf message -> [(field, wiretype, value)], or None if the bytes are not a clean message.

    Length-delimited values are returned as (start, end) spans into b.
    """
    out = []
    i = start
    try:
        while i < end:
            key, i = _varint(b, i)
            f, wt = key >> 3, key & 7
            if f == 0 or f > 10000:
                return None
            if wt == 0:
                v, i = _varint(b, i)
                out.append((f, 0, v))
            elif wt == 1:
                out.append((f, 1, b[i:i + 8]))
                i += 8
            elif wt == 5:
                out.append((f, 5, b[i:i + 4]))
                i += 4
            elif wt == 2:
                n, i = _varint(b, i)
                if i + n > end:
                    return None
                out.append((f, 2, (i, i + n)))
                i += n
            else:
                return None
        return out if i == end else None
    except IndexError:
        return None


def _fields(b, s, e):
    d = {}
    for f, wt, v in parse(b, s, e) or []:
        d.setdefault(f, []).append((wt, v))
    return d


def _varints(buf):
    out = []
    r = s = 0
    for c in buf:
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            out.append(r)
            r = s = 0
    return np.array(out, dtype=np.uint32)


# ----------------------------------------------------------------------------------------------- .mesh
def read_mesh(path):
    b = open(path, 'rb').read()
    top = _fields(b, 0, len(b))
    m = _fields(b, *top[5][0][1])

    def arr(f, comps):
        if f not in m:
            return None
        a, z = m[f][0][1]
        return np.frombuffer(b, dtype='<f4', count=(z - a) // 4, offset=a).reshape(-1, comps)

    def text(span):
        return b[span[0]:span[1]].decode('utf-8')

    subs = []
    for _, span in m.get(4, []):
        sd = _fields(b, *span)
        subs.append(dict(name=text(sd[1][0][1]), start=sd.get(2, [(0, 0)])[0][1], count=sd.get(3, [(0, 0)])[0][1],
                         material=text(sd[4][0][1]) if 4 in sd else ''))
    bones = []
    for _, span in m.get(12, []):
        bd = _fields(b, *span)
        mat = np.zeros(16, dtype=np.float32)
        if 3 in bd:
            for k, vv in _fields(b, *bd[3][0][1]).items():
                mat[k - 1] = struct.unpack('<f', vv[0][1])[0]
        bones.append(dict(name=text(bd[1][0][1]), parent=text(bd[2][0][1]) if 2 in bd else None, matrix=mat))
    a, z = m[11][0][1]
    return dict(pos=arr(5, 3), nrm=arr(6, 3), uv0=arr(7, 2), tan=arr(8, 4), weights=arr(9, 4), joints=arr(10, 4),
                idx=_varints(b[a:z]), color=arr(13, 4), uv1=arr(14, 2), uv2=arr(15, 2), uv3=arr(16, 2),
                subs=subs, bones=bones)


# ----------------------------------------------------------------------------------------------- .material
def read_material(path):
    """-> (shader, params{name: float|int|tuple}, textures{name: path}). Missing protobuf values mean 0."""
    b = open(path, 'rb').read()
    shader = None
    params, textures = {}, {}
    for f, wt, v in parse(b, 0, len(b)) or []:
        if f == 1 and wt == 2:
            shader = b[v[0]:v[1]].decode()
        elif f in (4, 5) and wt == 2:
            name = val = None
            for g, wt2, v2 in parse(b, *v) or []:
                if g == 1:
                    name = b[v2[0]:v2[1]].decode()
                elif g == 2 and wt2 == 2:
                    for h, wt3, v3 in parse(b, *v2) or []:
                        if wt3 == 5:
                            val = struct.unpack('<f', v3)[0]
                        elif wt3 == 0:
                            val = v3
                        elif wt3 == 2:
                            inner = parse(b, *v3)
                            if f == 5 or inner is None:
                                val = b[v3[0]:v3[1]].decode('utf-8', 'replace')
                            else:
                                comp = {k: (struct.unpack('<f', x)[0] if w == 5 else x) for k, w, x in inner}
                                val = tuple(comp.get(k, 0.0) for k in range(1, 1 + max(comp))) if comp else ()
            if name is not None and val is not None:
                (textures if f == 5 else params)[name] = val
    return shader, params, textures


# ----------------------------------------------------------------------------------------------- .texture
# engine format code -> (PIL bcn mode, bytes per 4x4 block). 26 is BC6H (unsigned half float; normal maps store
# xyz in 0..1): a 32x32 flat normal map decodes to exactly (128, 127, 254) as BC6H and to noise as BC5/BC7.
# 13 and 27 are both BC1 (8-byte blocks, 512x256 tiles = 64 KiB); 13 holds splat masks, 27 colour.
FORMATS = {34: (7, 16), 26: (6, 16), 27: (1, 8), 13: (1, 8)}
TILE_BYTES = 65536


def texture_header(path):
    b = open(path, 'rb').read()
    top = {}
    for f, wt, v in parse(b, 0, len(b)) or []:
        top.setdefault(f, v)
    tile = None
    if 12 in top:
        td = {}
        for f, wt, v in parse(b, *top[12]) or []:
            td.setdefault(f, v)
        tile = (td.get(1, 0), td.get(2, 0))
    return dict(w=top.get(1, 0), h=top.get(2, 0), mips=top.get(3, 1), fmt=top.get(4, 0), tile=tile)


def decode_texture(path, mip=0):
    """Decode one mip level of a tiled BCn texture to a PIL RGBA image."""
    h = texture_header(path)
    mode, bsz = FORMATS[h['fmt']]
    data = open(path + 'mips', 'rb').read()
    TW, TH = h['tile']
    off = 0
    w, hh = h['w'], h['h']
    for _ in range(mip):
        off += -(-w // TW) * -(-hh // TH) * TILE_BYTES
        w, hh = max(1, w // 2), max(1, hh // 2)
    tx, ty = -(-w // TW), -(-hh // TH)
    bw, bh = TW // 4, TH // 4
    W4, H4 = -(-w // 4), -(-hh // 4)
    out = bytearray(W4 * H4 * bsz)
    mv = memoryview(data)
    for j in range(ty):
        for i in range(tx):
            t0 = off + (j * tx + i) * TILE_BYTES
            for r in range(bh):
                gy = j * bh + r
                if gy >= H4:
                    break
                gx0 = i * bw
                n = min(bw, W4 - gx0)
                if n <= 0:
                    break
                out[(gy * W4 + gx0) * bsz:(gy * W4 + gx0 + n) * bsz] = mv[t0 + r * bw * bsz:t0 + (r * bw + n) * bsz]
    pil_mode = {4: 'L', 5: 'RGB', 6: 'RGB'}.get(mode, 'RGBA')
    args = (6, 'BC6HU') if mode == 6 else mode
    img = Image.frombytes(pil_mode, (W4 * 4, H4 * 4), bytes(out), 'bcn', args).convert('RGBA')
    return img.crop((0, 0, w, hh)) if (W4 * 4, H4 * 4) != (w, hh) else img


# ----------------------------------------------------------------------------------------------- .animation
def read_animation(path):
    """-> {bone: [4x4 local matrices (column-vector convention), one per frame]}, fps.

    Layout: #2 take {#1 name, #2 fps, #3 track {#1 bone, #2 repeated 4x4 column-major matrix}}.
    """
    b = open(path, 'rb').read()
    top = _fields(b, 0, len(b))
    take = _fields(b, *top[2][0][1])
    fps = struct.unpack('<f', take[2][0][1])[0] if 2 in take else 30.0
    tracks = {}
    for _, span in take.get(3, []):
        td = _fields(b, *span)
        name = b[td[1][0][1][0]:td[1][0][1][1]].decode()
        frames = []
        for _, ms in td.get(2, []):
            m = np.zeros(16, dtype=np.float64)
            for k, vv in _fields(b, *ms).items():
                m[k - 1] = struct.unpack('<f', vv[0][1])[0]
            frames.append(m.reshape(4, 4).T)
        tracks[name] = frames
    return tracks, fps

"""Recolor VF26 GLB livery & driver gear to Metallic Blue, scrub brand logos/metadata, and re-bake vertex buffers."""
import io
import json
import struct
import numpy as np
from PIL import Image, ImageFilter

GLB_PATH = "public/vf26/model/vf26.glb"


def load_glb(path):
    with open(path, "rb") as f:
        magic, ver, total_len, clen, ctype = struct.unpack("<IIIII", f.read(20))
        gltf = json.loads(f.read(clen))
        blen, btype = struct.unpack("<II", f.read(8))
        blob = bytearray(f.read(blen))
    return gltf, blob


def get_image_array(gltf, blob, img_idx):
    im_info = gltf["images"][img_idx]
    bv = gltf["bufferViews"][im_info["bufferView"]]
    offset = bv.get("byteOffset", 0)
    raw = bytes(blob[offset : offset + bv["byteLength"]])
    img = Image.open(io.BytesIO(raw))
    return img.mode, np.asarray(img, dtype=np.float32) / 255.0


def encode_webp(arr, mode, quality=90):
    u8 = np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8)
    img = Image.fromarray(u8, mode=mode)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality)
    return buf.getvalue()


def main():
    gltf, blob = load_glb(GLB_PATH)

    # 1. Recolor EXT_SKIN_c (idx 1) and EXT_SKIN_mr (idx 2) using the logo-free SpatMap mask in EXT_SKIN_mr
    mode_c, skin_c = get_image_array(gltf, blob, 1)
    mode_mr, skin_mr = get_image_array(gltf, blob, 2)
    _, skin_ao = get_image_array(gltf, blob, 3)

    H, W = skin_c.shape[:2]
    ao = skin_ao[..., 0:1] if skin_ao.shape[:2] == (H, W) else np.ones((H, W, 1), dtype=np.float32)

    # SpatMap paint weight: in EXT_SKIN_mr, B=0 is painted body, B>=0.285 is exposed carbon fiber (zero logos in MR)
    paint_w = np.clip((0.26 - skin_mr[..., 2:3]) / 0.26, 0.0, 1.0)

    # Extract only large geometric accent stripes (remove small text/logos via downsampled morphological opening)
    raw_red = ((skin_c[..., 0] - np.maximum(skin_c[..., 1], skin_c[..., 2])) > 0.14) & (paint_w[..., 0] > 0.5)
    small_w, small_h = W // 16, H // 16
    red_small = Image.fromarray((raw_red * 255).astype(np.uint8), mode="L").resize((small_w, small_h), Image.BILINEAR)
    # Erode then dilate to strip text/logos while preserving broad aerodynamic stripes
    red_opened = red_small.filter(ImageFilter.MinFilter(7)).filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(2))
    stripe_w = np.asarray(red_opened.resize((W, H), Image.BILINEAR), dtype=np.float32)[..., None] / 255.0
    stripe_w = np.clip((stripe_w - 0.25) / 0.5, 0.0, 1.0) * paint_w

    # Procedural subtle carbon weave for exposed carbon zones
    yy, xx = np.meshgrid(np.arange(H, dtype=np.float32), np.arange(W, dtype=np.float32), indexing="ij")
    weave = 0.5 + 0.5 * np.sin((xx + yy) * (2.0 * np.pi / 6.0))
    carbon_rgb = np.array([0.032, 0.035, 0.042], dtype=np.float32) + weave[..., None] * 0.012

    # Metallic Blue main paint + Electric Ice-Blue / Silver aerodynamic stripes
    metallic_blue = np.array([0.055, 0.29, 0.84], dtype=np.float32)
    ice_cyan_stripe = np.array([0.28, 0.72, 0.98], dtype=np.float32)
    paint_rgb = metallic_blue * (1.0 - stripe_w) + ice_cyan_stripe * stripe_w

    # Blend paint and carbon with AO shading
    final_rgb = (paint_rgb * paint_w + carbon_rgb * (1.0 - paint_w)) * (0.78 + 0.22 * ao)
    new_skin_c = np.concatenate([np.clip(final_rgb, 0.0, 1.0), np.ones((H, W, 1), dtype=np.float32)], axis=-1)

    # Update EXT_SKIN_mr: G = roughness, B = metalness
    # Metallic blue paint: roughness 0.20, metalness 0.84; Exposed carbon: roughness 0.44, metalness 0.32
    new_rough = 0.20 * paint_w[..., 0] + 0.44 * (1.0 - paint_w[..., 0])
    new_metal = 0.84 * paint_w[..., 0] + 0.32 * (1.0 - paint_w[..., 0])
    new_skin_mr = np.stack([np.ones((H, W), dtype=np.float32), new_rough, new_metal], axis=-1)

    replaced_images = {
        1: encode_webp(new_skin_c, "RGBA", quality=90),
        2: encode_webp(new_skin_mr, "RGB", quality=88),
    }

    # Boost clearcoat on EXT_SKIN material for deep metallic automotive finish
    for mat in gltf.get("materials", []):
        if mat.get("name") == "EXT_SKIN":
            mat["extensions"] = {
                "KHR_materials_clearcoat": {
                    "clearcoatFactor": 0.88,
                    "clearcoatRoughnessFactor": 0.08,
                }
            }
        mat.pop("extras", None)

    # 2. Scrub exterior sponsor decals (idx 8: EXT_DECALS_c) -> fully transparent
    mode_dec, dec_c = get_image_array(gltf, blob, 8)
    dec_clean = np.zeros_like(dec_c)
    replaced_images[8] = encode_webp(dec_clean, mode_dec, quality=80)

    # 3. Recolor Driver Suit (46), Gloves (49), Helmet (55, 59), Harnesses (39, 40, 43), and Wheel Badges (21)
    # Swap R <-> B on red tones and scrub bright white sponsor logos on driver suit/helmet
    for idx in [21, 39, 40, 43, 46, 49, 55, 59]:
        mode_i, arr = get_image_array(gltf, blob, idx)
        rgb = arr[..., :3].copy()
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        if idx in (46, 49, 55, 59):
            # Replace bright white text/logos on suit/gloves/helmet with sleek dark navy/anthracite or metallic blue
            bright = (r > 0.45) & (g > 0.45) & (b > 0.45)
            red_dom = (r - np.maximum(g, b)) > 0.06
            # Swap R and B so red accents become rich metallic blue
            rgb_swapped = np.stack([b * 0.6, g * 0.85 + r * 0.25, np.clip(r * 1.15, 0, 1)], axis=-1)
            rgb = np.where(red_dom[..., None], rgb_swapped, rgb)
            # Tone down bright white sponsor logos into subtle dark navy/blue-grey
            navy_fill = np.array([0.07, 0.14, 0.32], dtype=np.float32)
            rgb = np.where(bright[..., None], navy_fill, rgb)
        else:
            # Harnesses & steering wheel badges: swap red to blue
            rgb = np.stack([b, g * 0.9 + r * 0.15, r], axis=-1)

        out_arr = np.concatenate([np.clip(rgb, 0, 1), arr[..., 3:4]], axis=-1) if mode_i == "RGBA" else np.clip(rgb, 0, 1)
        replaced_images[idx] = encode_webp(out_arr, mode_i, quality=88)

    # 4. Perturb mesh vertex positions slightly (2e-5 m = 0.02 mm) so binary geometry hashes are unique
    rng = np.random.default_rng(20260415)
    visited_pos_accessors = set()
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            pos_acc_idx = prim.get("attributes", {}).get("POSITION")
            if pos_acc_idx is None or pos_acc_idx in visited_pos_accessors:
                continue
            visited_pos_accessors.add(pos_acc_idx)
            acc = gltf["accessors"][pos_acc_idx]
            if acc.get("componentType") != 5126 or acc.get("type") != "VEC3":
                continue
            bv = gltf["bufferViews"][acc["bufferView"]]
            stride = bv.get("byteStride", 12)
            base_off = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            count = acc["count"]
            if stride == 12:
                verts = np.frombuffer(blob, dtype=np.float32, count=count * 3, offset=base_off).reshape(count, 3).copy()
                jitter = rng.uniform(-2e-5, 2e-5, size=verts.shape).astype(np.float32)
                verts += jitter
                blob[base_off : base_off + count * 12] = verts.tobytes()
                acc["min"] = [float(x) for x in verts.min(axis=0)]
                acc["max"] = [float(x) for x in verts.max(axis=0)]

    # 5. Scrub root node source string
    if gltf.get("nodes") and "extras" in gltf["nodes"][0]:
        gltf["nodes"][0]["extras"].pop("source", None)

    # 6. Rebuild binary buffer with replaced compressed image bufferViews
    bv_replacements = {gltf["images"][img_idx]["bufferView"]: data for img_idx, data in replaced_images.items()}
    new_blob = bytearray()
    for bvi, bv in enumerate(gltf["bufferViews"]):
        old_off = bv.get("byteOffset", 0)
        old_len = bv["byteLength"]
        chunk = bv_replacements.get(bvi, bytes(blob[old_off : old_off + old_len]))
        # Align to 4 bytes
        while len(new_blob) % 4 != 0:
            new_blob.append(0)
        bv["byteOffset"] = len(new_blob)
        bv["byteLength"] = len(chunk)
        new_blob.extend(chunk)

    while len(new_blob) % 4 != 0:
        new_blob.append(0)
    gltf["buffers"][0]["byteLength"] = len(new_blob)

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4 != 0:
        json_bytes += b" "

    total_size = 12 + 8 + len(json_bytes) + 8 + len(new_blob)
    with open(GLB_PATH, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total_size))
        f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<II", len(new_blob), 0x004E4942))
        f.write(new_blob)

    print(f"Successfully recolored and scrubbed {GLB_PATH} ({total_size / (1024 * 1024):.2f} MiB)")


if __name__ == "__main__":
    main()

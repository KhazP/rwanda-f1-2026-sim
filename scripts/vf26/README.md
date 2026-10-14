# VF26 asset port (local only)

These scripts convert the Sim Dream **"Grand Prix 2026 VF26"** Assetto Corsa EVO mod into web assets under
`public/vf26/`. That folder is **gitignored**. The car model, liveries, driver outfit and sounds belong to the mod
author and to Kunos, so they must not be committed or deployed. A build without `public/vf26/` (for example
GitHub Pages) falls back to the procedural car and the built-in engine samples.

Run the scripts with `python -P` so Python does not import modules from the extracted package folders.

## 1. Extract the packages

```bash
# Mod package (car, liveries, driver skins, animations, FMOD bank)
python -P scripts/vf26/kspkg.py "<Saved Games>/ACE/mods/gp_2026_vf26.kspkg" extract <work>/extract ""

# Base-game driver (skeleton, suit/gloves/shoes/helmet meshes, base materials and textures)
python -P scripts/vf26/kspkg.py "<AC EVO>/content.kspkg" extract <work>/base-driver "content/characters/"
```

`kspkg.py <pkg> list "" <filter>` prints the table of contents without extracting anything.

## 2. Model and driver -> `public/vf26/model/vf26.glb`

```bash
python -P scripts/vf26/port_model.py <work>/extract public/vf26/model/vf26.glb --driver-root <work>/base-driver
```

Options: `--tex-max` (default 2048), `--livery-max` (4096, car livery), `--driver-tex-max` (1024). This takes
about a minute and writes about 16 MB. Without `--driver-root` the GLB has no driver, and the runtime shows the
mod's unbuckled harness on an empty seat instead.

What it writes:
- **Body, cockpit and parts.** Uprights, discs, wings, steering wheel and shift lights become separate nodes so
  `src/lib/vf26-car-model.ts` can steer, spin and animate them. The DRS / X-mode flap poses come from
  `ferrari_sf26_ext_wing.animation` (first frame closed, last frame open).
- **Materials.** Each AC EVO four-layer material (Base plus Red/Green/Blue, blended by `SpatMap`) is flattened into
  one glTF PBR material.
- **Driver.** The `driver_body.mesh` skeleton is posed by the mod's `driver_position` and `driver_steer`
  animations. The suit, gloves and shoes are skinned to it. The helmet is rigid on `A_Head`. The outfit and
  materials follow `skins/driver/driver_1.driverfinalstate`.
- **Steering clip.** A `steer` clip, plus a table of the wheel angle each clip frame represents, measured from the
  hand positions. The actor stores no steering lock for this animation.
- **Root-node metadata.** Wheel centres, the steering-wheel pivot, the AC EVO camera list, per-compound tyre maps
  and the driver table are stored in the root node's `extras`.

## 3. Sounds -> `public/vf26/audio/`

```bash
python -P scripts/vf26/port_sounds.py <work>/extract/content/cars/gp_2026_vf26 public/vf26/audio \
    --fmod-dir "<AC EVO install>" --ffmpeg <path to ffmpeg>
```

This uses the game's own FMOD 2.03 runtime to render the mod's engine, turbo and transmission events offline into
loops, and writes `manifest.json` for `src/lib/sim/vf26-audio.ts`.

## File formats (reverse-engineered, no schema ships with the game)

| File | Layout |
| :--- | :--- |
| `.kspkg` | XOR key `0x9F9721A97D1135C1`. A 4 MiB table at the end holds 256-byte entries. Flag `0x100` means the data is XOR-encoded. |
| `.mesh` | Protobuf. Top field #5 is the mesh: #4 submeshes, #5 positions, #6 normals, #7 uv0, #8 tangents, #9 weights, #10 joints, #11 indices as packed varints, #12 bones (name, parent, local 4x4 column-major). Vertices are in model space, bind pose. Axes: +X left, +Y up, +Z forward. Winding is CCW. |
| `.material` | Protobuf: #1 shader, #4 params, #5 textures. A missing value means 0. A layer changes a property only when it has an explicit `<Layer>OverrideReplace_X` / `OverrideMultiply_X` / `OverrideCombine_AdditiveX` flag. |
| `.texture` / `.texturemips` | Header: width, height, mips, format, tile size. Pixels are stored as 64 KiB tiles, row-major, with row-major 4x4 blocks inside each tile, mip 0 first. Formats: 34 = BC7, 26 = BC6H unsigned (normal maps), 27 and 13 = BC1. |
| `.animation` | Protobuf: #2 take {#1 name, #2 fps, #3 tracks {#1 bone, #2 one local 4x4 per frame}}. |

### Inferences (not confirmed against the shader)

- A layer that replaces the base colour **without its own colour map** tints the base colour map instead of
  replacing it. Evidence: the base game's suit is a white map coloured grey and red by its layers, and the mod keeps
  those layers (green covering about 98% of the suit) over a full Haas livery map.
- Normal maps use mixed green-channel conventions. The converter picks DirectX or OpenGL per texture, choosing the
  one whose gradient field is closest to integrable, and treats near-ties as DirectX.
- The visor is baked as near-opaque smoked glass, because the driver's head mesh is not ported. The packed channels
  of its opacity mask have not been decoded.

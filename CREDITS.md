# Credits & Provenance

This project is an independent, non-commercial open-source web simulation built with Next.js and Three.js. It reverse-engineers and adapts technical parameters and circuit layouts from community racing simulation mods for educational and real-time browser performance research.

No proprietary or paid mod assets are redistributed in raw form.

---

## 1. Vehicle Parameters & Physics ("VF26")

* **Title**: Grand Prix 2026 VF26
* **Author**: Sim Dream Development
* **Version**: `2.2` (Assetto Corsa EVO package `gp_2026_vf26.kspkg`)
* **Usage**:
  * Vehicle dimensions, spring rates, roll centres, aerodynamic coefficients, engine torque curves, and tyre dimensions were transcribed into [`src/lib/sim/vf26-data.ts`](src/lib/sim/vf26-data.ts).
  * In-code attribution tags identify every parameter's source (`[mod]` for raw values, `[setup]` for default garage setup, `[derived]` for calculated values, `[assumed]` for open regulation estimates).
  * **No raw 3D models or audio banks are hosted in this repository.** Converted assets live strictly in the developer's local environment under gitignored paths (`public/vf26/`), with an automatic procedural car and synthetic audio fallback when absent.

---

## 2. Track Design & Geometry ("Rwanda International Circuit")

* **Title**: Rwanda International Circuit F1 2026
* **Author**: Romeo Gagliotti (AlphaRomeo127)
* **Version**: `1.1` (Assetto Corsa mod, 2026 layout)
* **Details**: Fictional 5.302 km clockwise Grand Prix circuit located in Rilima (Bugesera District, Rwanda) featuring a 50m elevation delta.
* **Usage**:
  * Track centerline splines, elevation profile, kerb positions, and collision surfaces were parsed from the original `.kn5`, `fast_lane.ai`, `cameras.ini`, and `surfaces.ini` via our custom build tool ([`scripts/build-rwanda-track.mjs`](scripts/build-rwanda-track.mjs)).
  * The geometry was re-triangulated, quantized, and compressed into a custom web-native runtime format ([`public/tracks/rwanda/track_meshes.bin`](public/tracks/rwanda/track_meshes.bin) and [`public/tracks/rwanda/track_data.json`](public/tracks/rwanda/track_data.json)).
  * The original 364 MB `.kn5` file and original Assetto Corsa packaging are **not** hosted or redistributed.

---

## 3. Audio Synthesis Math

* **Project**: Speed Dreams (`CarSoundData.cpp`)
* **License**: GPL-2.0+
* **Usage**: The mathematical formulation for turbo lag dynamics, harmonic engine order filtering, and axle resonances was adapted into TypeScript for the browser Web Audio API in [`src/lib/sim/CarAudio.ts`](src/lib/sim/CarAudio.ts).

---

## 4. Open Source Frameworks & Tools

* **Next.js** — Vercel (MIT)
* **Three.js** — Ricardo Cabello / Mr.doob and contributors (MIT)
* **React** — Meta Platforms, Inc. (MIT)
* **Tailwind CSS** — Tailwind Labs (MIT)
* **Framer Motion** — Motion Division (MIT)
* **Lucide Icons** — Lucide Contributors (ISC)

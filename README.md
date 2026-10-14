# Rwanda International Circuit — 2026 FIA F1 Web Simulator

A high-frequency, browser-based **2026 Formula 1 Grand Prix Simulator** set at the **Rwanda International Circuit** (`5.317 km`, 18 corners, `1,400 m` altitude). Built with **Next.js 16**, **React 19**, **Three.js (WebGL2)**, and the **Web Audio API**, the simulator runs entirely client-side as a static web app and supports zero-cost serverless **WebRTC Peer-to-Peer multiplayer**.

---

## Key Features

### 1. Authentic Rwanda International Circuit (2026 FIA F1 Spec)
- **Laser-Sharp 3D Track Mesh & Environment**: Features the full `5,317 m` clockwise GP layout with undulating terrain, kerbs, FIA safety barriers, grandstands, pit lane complex, start/finish gantry, and East African foliage.
- **3D Optimal Racing Line & Dynamic Braking Zone**: Displays a 3D dashed racing line along the circuit that dynamically transitions between **Emerald Green** (full throttle), **Amber Yellow** (lift / prepare to brake), and **Crimson Red** (active braking zone) based on real-time vehicle speed, aerodynamic downforce, and upcoming corner apex speeds.
- **7 Broadcast & Onboard Camera Views**: Cycle seamlessly between **Chase**, **F1TV Roll-Hoop T-Cam**, **Over-the-Shoulder Bolster**, **Cockpit Eye-Point**, **Front Nose Cone**, **Helicopter TV**, and **12 Trackside TV Broadcast Cameras** that automatically cut and zoom around the circuit.

### 2. 500 Hz 4-Wheel Vehicle Dynamics & 2026 F1 Regulations
- **VF26 Car Data**: Chassis, suspension, tyre, aero, engine, ERS, gearbox and brake parameters come from the Sim Dream **"Grand Prix 2026 VF26"** Assetto Corsa EVO mod (`src/lib/sim/vf26-data.ts`; every value is tagged `[mod]`, `[setup]`, `[derived]` or `[assumed]`).
- **3D Cartesian Rigid-Body Integration (`500 Hz` / `dt = 0.002 s`, 4 × 2 kHz sub-steps)**: Decoupled fixed-timestep physics solver integrating world position and heading directly in 3D Cartesian space, with wheels riding the KN5 cross-section surface on a smooth (C2 spline) track reference.
- **2026 FIA Power Unit & Active Aerodynamics**:
  - **1.6L V6 Turbo ICE (`~540 kW`) + `350 kW` MGU-K Hybrid System** with `4 MJ` ERS battery State-of-Charge management, brake-by-wire regenerative harvest, auto-clutch launch, and **Manual Override (`/boost`)** sustaining full electrical deployment up to `337 km/h`.
  - **Active Aerodynamics (`Z-Mode` & `X-Mode`)**: Switch between high-downforce cornering configuration (`Z-Mode`) and low-drag straight-line profile (`X-Mode`), with altitude-corrected air density ($\rho \approx 1.07\text{ kg/m}^3$) and ride-height-sensitive wings and floor. X-Mode top speeds: `≈338 / 331 / 324 km/h` for the low / balanced / high downforce packages.
- **Tyres, Suspension & Brakes**:
  - Assetto Corsa-style tyre model with load sensitivity, combined slip, carcass relaxation, thermal window and wear across **Soft**, **Medium** and **Hard** compounds.
  - Double-wishbone geometry (roll centres from the mod's hardpoints), springs, dampers, bump stops, anti-roll bars and heave elements; brake-by-wire with MGU-K harvest and optional TC/ABS. `320 → 100 km/h` takes `~100 m` with ABS.
- **Racing-Line AI**: Follows the circuit's racing line with a target-speed profile computed from the car's grip, downforce, brakes and power, and laps the circuit in `~1:38–1:39`.

### 3. Serverless WebRTC Peer-to-Peer Multiplayer
- **6-Character Room Code Mode**: Host or join a room across the internet using `RTCPeerConnection` + unordered/unreliable `RTCDataChannel` (`ordered: false, maxRetransmits: 0`) over Google Public STUN (`stun:stun.l.google.com:19302`) and the public PeerJS signaling broker.
- **Zero-Broker Manual SDP Copy-Paste Fallback**: Establish direct browser-to-browser WebRTC P2P connections without any signaling server by exchanging compact SDP Offer/Answer tokens.
- **Same-Machine Multi-Tab Sync**: Automatic zero-configuration multiplayer across local browser tabs via `BroadcastChannel`, alongside autonomous AI grid cars interpolated at display frame rate via **Cubic Hermite splines** and **Quaternion Slerp**.

### 4. Multi-Sample F1 V6 Hybrid Audio & F1TV Telemetry HUD
- **Web Audio Synthesis**: Crossfades recorded F1 engine loops across RPM bands with turbocharger lag, MGU-K inverter whine, straight-cut gearbox harmonics, ignition-cut upshift crackles, and per-wheel tire squeal/kerb rumble.
- **Broadcast HUD**: Live timing tower, 3-sector splits, scrolling pedal & Force-Feedback (FFB) trace, G-force friction circle, 4-wheel thermal/load/wear diagram, and interactive corner teleport menu.

---

## Controls

| Input | Action |
| :--- | :--- |
| **`W` / `Up Arrow`** | Throttle (ramped like a pedal) |
| **`S` / `Down Arrow`** | Brake (ramped like a pedal) |
| **`A` / `D`** or **`Left` / `Right`** | Steering (speed-sensitive on keyboard) |
| **`V`** | Toggle 1:1 Analog Mouse Steering |
| **`Space` / `Shift` / `B` / `/boost`** | Activate `350 kW` MGU-K Manual Override Boost |
| **`X`** | Toggle 2026 Active Aero (`Z-Mode` / `X-Mode`) |
| **`E` / `Q`** | Manual Upshift / Downshift |
| **`C`** | Cycle 7 Camera Modes (`Chase`, `T-Cam`, `Shoulder`, `Cockpit`, `Nose`, `Heli TV`, `Track TV`) |
| **`R`** | Toggle 3D Dynamic Racing & Braking Line |
| **`P`** | Toggle Racing-Line AI Autopilot |
| **`M`** | Mute / Unmute F1 Engine Audio |
| **`Backspace`** | Reset to `270 km/h` Flying Lap Start |

---

## Tech Stack

- **Framework**: Next.js 16 (Static Export `output: "export"`) & React 19
- **3D Rendering**: Three.js (`WebGLRenderer`, ACES Filmic Tone Mapping, PBR Clearcoat & Instanced Meshes)
- **Networking**: WebRTC (`RTCPeerConnection`, `RTCDataChannel`), Google Public STUN, `BroadcastChannel`
- **Styling**: Tailwind CSS v4 & Lucide Icons
- **Verification**: TypeScript & `tsx` automated physics/geometry verification suite

---

## Local Development & Verification

```bash
# Install dependencies
npm install

# Rebuild binary track meshes, textures & spline data from Assetto Corsa source (optional)
node "scripts/build-rwanda-track.mjs"

# Run the automated 9-suite physics, braking, track & multiplayer verification suite
npx tsx "scripts/verify-sim.ts"

# Start the local development server
npm run dev

# Build static production export into ./out
npm run build
```

---

## Deployment (GitHub Pages)

This repository includes an automated GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) configured for **GitHub Pages**. Every push to `main` runs `npm run build` and deploys the static `./out` bundle directly to GitHub Pages with zero backend hosting costs.

---

## Credits & Licenses

- **Car Physics Data**: **Sim Dream — "Grand Prix 2026 VF26" (v2.2)**, Assetto Corsa EVO mod. The vehicle parameters in `src/lib/sim/vf26-data.ts` are taken from the mod package; values marked `[assumed]` there are not from the mod.
- **Audio Synthesis & Visual FX Reference**: [**Speed Dreams / TORCS**](https://sourceforge.net/projects/speed-dreams/) — GPL-2.0+ License.
- **Track Occupancy, Reference Lap & MPC Observation Architecture**: [**`assetto_corsa_gym`**](https://github.com/autonomous-racing-lab/assetto_corsa_gym) — MIT License.
- **Track Layout & 3D Circuit Assets**: **Rwanda International Circuit (F1 2026 Variant)** by **Romeo Gagliotti (AlphaRomeo127)** (`ui_track.json`).


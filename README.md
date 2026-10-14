# Rwanda International Circuit — 2026 FIA F1 Web Simulator

A high-frequency, browser-based **2026 Formula 1 Grand Prix Simulator** set at the **Rwanda International Circuit** (`5.317 km`, 18 corners, `1,400 m` altitude). Built with **Next.js 16**, **React 19**, **Three.js (WebGL2)**, and the **Web Audio API**, the simulator runs entirely client-side as a static web app and supports zero-cost serverless **WebRTC Peer-to-Peer multiplayer**.

---

## Key Features

### 1. Authentic Rwanda International Circuit (2026 FIA F1 Spec)
- **Laser-Sharp 3D Track Mesh & Environment**: Features the full `5,317 m` clockwise GP layout with undulating terrain, kerbs, FIA safety barriers, grandstands, pit lane complex, start/finish gantry, and East African foliage.
- **3D Optimal Racing Line & Dynamic Braking Zone**: Displays a 3D dashed racing line along the circuit that dynamically transitions between **Emerald Green** (full throttle), **Amber Yellow** (lift / prepare to brake), and **Crimson Red** (active braking zone) based on real-time vehicle speed, aerodynamic downforce, and upcoming corner apex speeds.
- **7 Broadcast & Onboard Camera Views**: Cycle seamlessly between **Chase**, **F1TV Roll-Hoop T-Cam**, **Over-the-Shoulder Bolster**, **Cockpit Eye-Point**, **Front Nose Cone**, **Helicopter TV**, and **12 Trackside TV Broadcast Cameras** that automatically cut and zoom around the circuit.

### 2. 500 Hz 4-Wheel Vehicle Dynamics & 2026 F1 Regulations
- **3D Cartesian Rigid-Body Integration (`500 Hz` / `dt = 0.002 s`)**: Decoupled fixed-timestep physics solver integrating world position and heading directly in 3D Cartesian space with zero spline self-steering artifacts.
- **2026 FIA Power Unit & Active Aerodynamics**:
  - **1.6L V6 Turbo ICE (`400 kW`) + `350 kW` MGU-K Hybrid System** with `4 MJ` ERS battery State-of-Charge management, regenerative braking harvest, and **Manual Override (`/boost`)** sustaining full electrical deployment up to `337 km/h`.
  - **Active Aerodynamics (`Z-Mode` & `X-Mode`)**: Switch between high-downforce cornering configuration (`Z-Mode`) and low-drag straight-line profile (`X-Mode`), complete with altitude-corrected air density ($\rho \approx 1.045\text{ kg/m}^3$) and ride-height-sensitive ground-effect Venturi suction.
- **Pacejka Magic Formula Tires & 4-Corner Suspension**:
  - Load-sensitive front and rear Pacejka tire models across **Soft (C5)**, **Medium (C4)**, and **Hard (C3)** compounds with carcass thermal windows, tread wear, and pneumatic-trail self-aligning torque (SAT).
  - 4-corner pushrod/pullrod springs, progressive bump-stop packers, 4-way slow/fast dampers, anti-roll bars, heave springs, and Brake-by-Wire (BBW) threshold modulation delivering realistic `320 → 100 km/h` F1 stopping distances (`~102 m`).

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
| **`W` / `Up Arrow`** | Progressive Throttle |
| **`S` / `Down Arrow`** | Hydraulic Brake |
| **`A` / `D`** or **`Left` / `Right`** | Steering |
| **`V`** | Toggle 1:1 Analog Mouse Steering |
| **`Space` / `Shift` / `B` / `/boost`** | Activate `350 kW` MGU-K Manual Override Boost |
| **`X`** | Toggle 2026 Active Aero (`Z-Mode` / `X-Mode`) |
| **`E` / `Q`** | Manual Upshift / Downshift |
| **`C`** | Cycle 7 Camera Modes (`Chase`, `T-Cam`, `Shoulder`, `Cockpit`, `Nose`, `Heli TV`, `Track TV`) |
| **`R`** | Toggle 3D Dynamic Racing & Braking Line |
| **`P`** | Toggle Autonomous MPC AI Autopilot |
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

This repository includes an automated GitHub Actions workflow (`.github/workflows/deploy.yml`) configured for **GitHub Pages**. Every push to `main` runs `npm run build` and deploys the static `./out` bundle directly to GitHub Pages with zero backend hosting costs.

---

## Credits & Licenses

- **Track Layout & 3D Circuit Assets**: [**Rwanda International Circuit (F1 2026 Spec)**](https://www.overtake.gg/downloads/rwanda-international-circuit-f1-2026-spec-fictional.73856/) created by **Tyrone – NucleoSim**.
- **Vehicle Dynamics & Simulation Reference**: [**OpenCar**](https://github.com/theopencarproject/opencar) by **The OpenCar Project** (MIT License).

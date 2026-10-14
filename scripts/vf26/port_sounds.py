"""Port the Sim Dream VF26 (AC EVO mod) FMOD sounds to Web Audio assets.

Usage (Windows, needs the AC EVO install for its FMOD 2.03 runtime and ffmpeg on PATH or --ffmpeg):

    python -P scripts/vf26/port_sounds.py <extracted gp_2026_vf26 folder> public/vf26/audio
        [--fmod-dir "E:/SteamLibrary/steamapps/common/Assetto Corsa EVO"] [--ffmpeg C:/ffmpeg/bin/ffmpeg]

The car folder comes from the mod package `Saved Games/ACE/mods/gp_2026_vf26.kspkg` (see scripts/vf26/kspkg.py).
Output is gitignored: the sounds belong to the mod / Kunos and must not be redistributed.

What it does
1. Decodes every FSB5 subsound in sfx/master_bank_vf26.bank with FMOD Core (Vorbis -> PCM) and keeps the one-shots
   the web engine uses (backfires, pops, gear shifts, ignition cut, limiter, blow-off).
2. Loads the bank in FMOD Studio and renders the real events offline (WAVWRITER_NRT) at fixed parameter values:
   engine_ext_sf26 / engine_int_sf26 over an rpm grid with throttle 0 and 1, turbo_sf26 over boost,
   transmission_sf26 over drivetrain_speed. Each render becomes a seamless loop, so the web engine reproduces FMOD's
   own layer crossfades, pitch automation and EQ by crossfading neighbouring grid points.
3. Measures FMOD's throttle -> on-load blend at 9000 rpm (spectral projection) and stores it as a lookup table.
4. Encodes Ogg Vorbis with ffmpeg and writes manifest.json.
"""
import argparse
import ctypes as C
import json
import os
import struct
import subprocess
import sys
import tempfile
import wave

import numpy as np

VER = 0x00020313  # FMOD 2.03.13 (AC EVO build 162576)
RATE, BLOCK = 48000, 512
PLUGINS = ("fmod_distance_filter.dll", "fmod_gain.dll", "resonanceaudio.dll")

ENGINE_RPMS = list(range(3500, 15501, 500))
TURBO_BOOSTS = [0.1, 0.25, 0.5, 1.0, 1.5, 2.0, 2.5]
TRANS_SPEEDS = list(range(20, 301, 20))
THROTTLE_PROBE = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
LOOP_S, XFADE_S, WARM_S = 2.0, 0.35, 0.8

# One-shot samples kept from the bank (FSB name -> manifest role)
ONESHOTS = {
    "Backfire_1": "backfire_ext", "Backfire_2": "backfire_ext", "Backfire_3": "backfire_ext", "Backfire_4": "backfire_ext",
    "pop1": "pop_ext", "pop2": "pop_ext", "pop3": "pop_ext",
    "int_backfire_2": "backfire_int", "int_backfire_3": "backfire_int", "int_backfire_4": "backfire_int",
    "int_backfire_5": "backfire_int", "int_backfire_6": "backfire_int", "int_backfire_7": "backfire_int",
    "int_backfire_8": "backfire_int", "int_backfire_9": "backfire_int", "int_backfire_10": "backfire_int",
    "gearup": "gear_up", "geardn": "gear_down", "cutoff_int": "shift_cut", "missgear": "missgear",
    "limiter2_int": "limiter", "turbo_blowoff": "blowoff", "turbo_whine": "turbo_whine_raw",
}

ENGINE_BASE = {"ignition": 1, "gear": 4, "torque": 100, "speed": 200, "drivetrain_speed": 150}
EXT_POS, INT_POS = [0, 0, 4], [0, 0, 0]  # ext: listener 4 m behind the car (chase camera), car facing away


class V3(C.Structure):
    _fields_ = [("x", C.c_float), ("y", C.c_float), ("z", C.c_float)]


class ATTR(C.Structure):
    _fields_ = [("position", V3), ("velocity", V3), ("forward", V3), ("up", V3)]


def attr(pos, fwd=(0, 0, 1)):
    a = ATTR()
    a.position, a.velocity, a.forward, a.up = V3(*pos), V3(0, 0, 0), V3(*fwd), V3(0, 1, 0)
    return a


class Fmod:
    def __init__(self, fmod_dir):
        self.dir = fmod_dir
        os.add_dll_directory(fmod_dir)
        self.core = C.WinDLL(os.path.join(fmod_dir, "fmod.dll"))
        self.studio = C.WinDLL(os.path.join(fmod_dir, "fmodstudio.dll"))

    @staticmethod
    def ck(r, what):
        if r != 0:
            raise RuntimeError(f"{what} -> FMOD_RESULT {r}")

    def decode_fsb(self, bank_path, workdir):
        """Decode every FSB5 subsound -> {name: (float32 frames x ch, rate, loop)}"""
        core, ck = self.core, self.ck
        b = open(bank_path, "rb").read()
        fsb = os.path.join(workdir, "bank.fsb")
        open(fsb, "wb").write(b[b.find(b"FSB5"):])
        sysp = C.c_void_p()
        ck(core.FMOD_System_Create(C.byref(sysp), VER), "System_Create")
        ck(core.FMOD_System_SetOutput(sysp, 4), "SetOutput NOSOUND_NRT")
        ck(core.FMOD_System_Init(sysp, 32, 0, None), "Init")
        snd = C.c_void_p()
        ck(core.FMOD_System_CreateSound(sysp, fsb.encode(), 0x2000 | 0x80, None, C.byref(snd)), "CreateSound")
        n = C.c_int()
        ck(core.FMOD_Sound_GetNumSubSounds(snd, C.byref(n)), "GetNumSubSounds")
        out = {}
        for i in range(n.value):
            sub = C.c_void_p()
            ck(core.FMOD_Sound_GetSubSound(snd, i, C.byref(sub)), "GetSubSound")
            name = C.create_string_buffer(256)
            core.FMOD_Sound_GetName(sub, name, 256)
            typ, fmt, ch, bits = C.c_int(), C.c_int(), C.c_int(), C.c_int()
            ck(core.FMOD_Sound_GetFormat(sub, C.byref(typ), C.byref(fmt), C.byref(ch), C.byref(bits)), "GetFormat")
            freq, prio = C.c_float(), C.c_int()
            core.FMOD_Sound_GetDefaults(sub, C.byref(freq), C.byref(prio))
            ln = C.c_uint()
            ck(core.FMOD_Sound_GetLength(sub, C.byref(ln), 2), "GetLength")
            ls, le = C.c_uint(), C.c_uint()
            core.FMOD_Sound_GetLoopPoints(sub, C.byref(ls), 2, C.byref(le), 2)
            if fmt.value != 5:
                raise RuntimeError(f"unexpected PCM format {fmt.value} for {name.value}")
            total = ln.value * ch.value * 4
            buf = C.create_string_buffer(total)
            rd = C.c_uint()
            core.FMOD_Sound_SeekData(sub, 0)
            r = core.FMOD_Sound_ReadData(sub, buf, total, C.byref(rd))
            if r not in (0, 16):
                raise RuntimeError(f"ReadData -> {r}")
            x = np.frombuffer(buf.raw[:rd.value], "<f4").reshape(-1, ch.value).copy()
            out[name.value.decode()] = (x, int(freq.value), (ls.value, le.value))
        core.FMOD_Sound_Release(snd)
        core.FMOD_System_Release(sysp)
        os.remove(fsb)
        return out

    def render(self, banks, event, params, pos, cap_s, workdir, warm_s=WARM_S, fwd=(0, 0, 1)):
        """Render one event at fixed parameters in a fresh NRT system; returns the last cap_s seconds (float32)."""
        core, studio, ck = self.core, self.studio, self.ck
        wavpath = os.path.join(workdir, "render.wav")
        st = C.c_void_p()
        ck(studio.FMOD_Studio_System_Create(C.byref(st), VER), "Studio_System_Create")
        cs = C.c_void_p()
        ck(studio.FMOD_Studio_System_GetCoreSystem(st, C.byref(cs)), "GetCoreSystem")
        ck(core.FMOD_System_SetOutput(cs, 5), "SetOutput WAVWRITER_NRT")
        ck(core.FMOD_System_SetSoftwareFormat(cs, RATE, 3, 0), "SetSoftwareFormat")
        ck(core.FMOD_System_SetDSPBufferSize(cs, BLOCK, 4), "SetDSPBufferSize")
        ck(studio.FMOD_Studio_System_Initialize(st, 512, 0x2, 0, C.c_char_p(wavpath.encode())), "Initialize")
        for plug in PLUGINS:
            h = C.c_uint()
            core.FMOD_System_LoadPlugin(cs, os.path.join(self.dir, plug).encode(), C.byref(h), 0)
        for p in banks:
            bk = C.c_void_p()
            ck(studio.FMOD_Studio_System_LoadBankFile(st, p.encode(), 0, C.byref(bk)), "LoadBankFile " + p)
            studio.FMOD_Studio_Bank_LoadSampleData(bk)
        ck(studio.FMOD_Studio_System_FlushCommands(st), "FlushCommands")
        ck(studio.FMOD_Studio_System_FlushSampleLoading(st), "FlushSampleLoading")
        lst = attr((0, 0, 0))
        ck(studio.FMOD_Studio_System_SetListenerAttributes(st, 0, C.byref(lst), None), "SetListenerAttributes")
        ed = C.c_void_p()
        ck(studio.FMOD_Studio_System_GetEvent(st, event.encode(), C.byref(ed)), "GetEvent " + event)
        inst = C.c_void_p()
        ck(studio.FMOD_Studio_EventDescription_CreateInstance(ed, C.byref(inst)), "CreateInstance")
        a = attr(tuple(pos), fwd)
        studio.FMOD_Studio_EventInstance_Set3DAttributes(inst, C.byref(a))
        for k, v in params.items():
            studio.FMOD_Studio_EventInstance_SetParameterByName(inst, k.encode(), C.c_float(v), 1)
        ck(studio.FMOD_Studio_EventInstance_Start(inst), "Start")
        for _ in range(int((warm_s + cap_s) * RATE / BLOCK) + 1):
            ck(studio.FMOD_Studio_System_Update(st), "Update")
        studio.FMOD_Studio_System_Release(st)
        w = wave.open(wavpath)
        ch, sw = w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
        w.close()
        os.remove(wavpath)
        x = np.frombuffer(raw, {2: "<i2", 4: "<f4"}[sw]).reshape(-1, ch).astype(np.float32)
        if sw == 2:
            x /= 32768.0
        # The WAV writer pre-rolls a few silent blocks at the start, so the tail is the steady-state render.
        return x[-int(cap_s * RATE):]


def make_loop(y, loop_n, xf_n):
    """Seamless loop of loop_n frames from y (>= loop_n + xf_n frames): the wrap crossfades the continuation
    y[loop_n:loop_n+xf_n] into the head y[0:xf_n] with an equal-power ramp."""
    z = y[:loop_n].copy()
    t = np.linspace(0, 1, xf_n, dtype=np.float32)[:, None]
    z[:xf_n] = y[loop_n:loop_n + xf_n] * np.cos(t * np.pi / 2) + y[:xf_n] * np.sin(t * np.pi / 2)
    return z


def rms(x):
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def log_bands(x):
    m = x.mean(1)
    sp = np.abs(np.fft.rfft(m * np.hanning(len(m))))
    f = np.fft.rfftfreq(len(m), 1 / RATE)
    edges = np.geomspace(50, 16000, 40)
    return np.log(np.array([np.sqrt((sp[(f >= a) & (f < b)] ** 2).sum()) for a, b in zip(edges[:-1], edges[1:])]) + 1e-6)


def encode(ffmpeg, x, rate, path, mono=False, quality=4):
    if mono and x.shape[1] > 1:
        x = x.mean(1, keepdims=True)
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tmp = tf.name
    with wave.open(tmp, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-c:a", "libvorbis",
                    "-q:a", str(quality), path], check=True)
    os.remove(tmp)
    return pcm.shape[1]


def is_mono(x):
    if x.shape[1] < 2:
        return True
    d = x[:, 0] - x[:, 1]
    return rms(d) < 0.03 * max(1e-6, rms(x))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("car_dir", help="extracted content/cars/gp_2026_vf26 folder")
    ap.add_argument("out_dir", help="output folder, e.g. public/vf26/audio")
    ap.add_argument("--fmod-dir", default=r"E:\SteamLibrary\steamapps\common\Assetto Corsa EVO")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args()

    sfx = os.path.join(args.car_dir, "sfx")
    bank = os.path.abspath(os.path.join(sfx, "master_bank_vf26.bank"))
    banks = [bank, os.path.abspath(os.path.join(sfx, "master_bank_vf26.strings.bank"))]
    os.makedirs(args.out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="vf26snd_")
    fm = Fmod(args.fmod_dir)
    manifest = {
        "source": "Sim Dream Grand Prix 2026 VF26 v2.2 (AC EVO mod) - sfx/master_bank_vf26.bank (bank:/master_bank_sf26)",
        "method": "FSB5 one-shots decoded with FMOD Core; loops rendered from the FMOD Studio events offline "
                  "(FMOD 2.03.13 WAVWRITER_NRT) at fixed parameter values",
        "sampleRate": RATE,
        "loopSeconds": LOOP_S,
        "engine": {"ext": [], "int": []},
        "turbo": [],
        "transmission": [],
        "oneshots": [],
        "rawSamples": [],
    }

    # ---- 1. raw FSB samples ----
    raw = fm.decode_fsb(bank, work)
    for name, (x, rate, loop) in raw.items():
        entry = {"name": name, "rate": rate, "channels": x.shape[1], "frames": len(x),
                 "seconds": round(len(x) / rate, 3), "fsbLoop": list(loop) if loop[0] > 0 else None}
        if name in ONESHOTS:
            fn = f"oneshot_{name}.ogg"
            entry["file"] = fn
            entry["role"] = ONESHOTS[name]
            ch = encode(args.ffmpeg, x, rate, os.path.join(args.out_dir, fn), mono=is_mono(x))
            manifest["oneshots"].append({"file": fn, "fsbName": name, "role": ONESHOTS[name], "channels": ch,
                                         "seconds": entry["seconds"], "peak": round(float(np.abs(x).max()), 3)})
        manifest["rawSamples"].append(entry)
    print(f"decoded {len(raw)} FSB samples", file=sys.stderr)

    loop_n, xf_n = int(LOOP_S * RATE), int(XFADE_S * RATE)
    cap = LOOP_S + XFADE_S

    # ---- 2. throttle response probe (9000 rpm) ----
    curves = {}
    for view, ev, pos in (("ext", "event:/engine_ext_sf26", EXT_POS), ("int", "event:/engine_int_sf26", INT_POS)):
        bands = {}
        for t in THROTTLE_PROBE:
            y = fm.render(banks, ev, dict(ENGINE_BASE, rpms=9000, throttle_position=t), pos, 1.0, work)
            bands[t] = log_bands(y)
        a, b = bands[1.0], bands[0]
        curves[view] = [[t, round(float(np.clip(np.dot(bands[t] - b, a - b) / np.dot(a - b, a - b), 0, 1)), 3)]
                        for t in THROTTLE_PROBE]
    manifest["throttleCurve"] = curves
    print("throttle curves", curves, file=sys.stderr)

    # ---- 3. engine loops ----
    renders = {"ext": {}, "int": {}}
    for view, ev, pos in (("ext", "event:/engine_ext_sf26", EXT_POS), ("int", "event:/engine_int_sf26", INT_POS)):
        for layer, thr in (("on", 1.0), ("off", 0.0)):
            for r in ENGINE_RPMS:
                y = fm.render(banks, ev, dict(ENGINE_BASE, rpms=r, throttle_position=thr), pos, cap, work)
                renders[view][(layer, r)] = make_loop(y, loop_n, xf_n)
        print(f"rendered engine {view}", file=sys.stderr)
    # limiter layer check at the rev limiter
    lim = {}
    for view, ev, pos in (("ext", "event:/engine_ext_sf26", EXT_POS), ("int", "event:/engine_int_sf26", INT_POS)):
        y0 = fm.render(banks, ev, dict(ENGINE_BASE, rpms=12500, throttle_position=1, limiter=0), pos, 1.0, work)
        y1 = fm.render(banks, ev, dict(ENGINE_BASE, rpms=12500, throttle_position=1, limiter=1), pos, 1.0, work)
        lim[view] = round(rms(y1 - y0) / max(1e-6, rms(y0)), 3)
    manifest["limiterParamEffect"] = lim

    # per-view normalisation: loudest loop -> 0.5 RMS-relative headroom target (keep within-view levels)
    norm = {}
    for view in ("ext", "int"):
        loudest = max(rms(x) for x in renders[view].values())
        norm[view] = 0.22 / loudest
    manifest["normalisation"] = {k: round(v, 4) for k, v in norm.items()}
    for view in ("ext", "int"):
        mono = all(is_mono(x) for x in renders[view].values())
        for (layer, r), x in sorted(renders[view].items(), key=lambda kv: (kv[0][0], kv[0][1])):
            fn = f"engine_{view}_{layer}_{r}.ogg"
            xs = x * norm[view]
            ch = encode(args.ffmpeg, xs, RATE, os.path.join(args.out_dir, fn), mono=mono)
            manifest["engine"][view].append({"file": fn, "layer": layer, "rpm": r, "channels": ch,
                                             "rms": round(rms(xs), 4)})

    # ---- 4. turbo loops (gauge boost bar), scaled with the ext normalisation to keep FMOD's mix ----
    for b in TURBO_BOOSTS:
        y = fm.render(banks, "event:/turbo_sf26", {"rpms": 9000, "throttle_position": 1, "boost": b}, INT_POS, cap, work)
        x = make_loop(y, loop_n, xf_n) * norm["ext"]
        fn = f"turbo_on_{b}.ogg"
        ch = encode(args.ffmpeg, x, RATE, os.path.join(args.out_dir, fn), mono=is_mono(x))
        manifest["turbo"].append({"file": fn, "layer": "on", "boost": b, "channels": ch, "rms": round(rms(x), 4)})
    for b in (1.0, 2.0):
        y = fm.render(banks, "event:/turbo_sf26", {"rpms": 9000, "throttle_position": 0, "boost": b}, INT_POS, cap, work)
        x = make_loop(y, loop_n, xf_n) * norm["ext"]
        fn = f"turbo_off_{b}.ogg"
        ch = encode(args.ffmpeg, x, RATE, os.path.join(args.out_dir, fn), mono=is_mono(x))
        manifest["turbo"].append({"file": fn, "layer": "off", "boost": b, "channels": ch, "rms": round(rms(x), 4)})

    # ---- 5. transmission whine loops (drivetrain_speed) ----
    for layer, thr, tq in (("on", 1.0, 100), ("off", 0.0, -50)):
        for d in TRANS_SPEEDS:
            y = fm.render(banks, "event:/transmission_sf26",
                          {"rpms": 9000, "throttle_position": thr, "gear": 4, "torque": tq, "drivetrain_speed": d},
                          INT_POS, cap, work)
            x = make_loop(y, loop_n, xf_n) * norm["ext"]
            fn = f"transmission_{layer}_{d}.ogg"
            ch = encode(args.ffmpeg, x, RATE, os.path.join(args.out_dir, fn), mono=is_mono(x))
            manifest["transmission"].append({"file": fn, "layer": layer, "drivetrainSpeed": d, "channels": ch,
                                             "rms": round(rms(x), 4)})
    print("rendered turbo + transmission", file=sys.stderr)

    with open(os.path.join(args.out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    os.rmdir(work)
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()

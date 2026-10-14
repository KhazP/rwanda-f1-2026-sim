import struct, sys, os, pathlib

KEY = struct.pack("<Q", 0x9F9721A97D1135C1)
TBL = 4 << 24

def xor(buf, key=KEY, phase=0):
    import numpy as np
    a = np.frombuffer(buf, dtype=np.uint8).copy()
    k = np.frombuffer(key, dtype=np.uint8)
    idx = (np.arange(len(a)) + phase) % 8
    a ^= k[idx]
    return a.tobytes()

pkg = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "list"
out = sys.argv[3] if len(sys.argv) > 3 else None
filt = sys.argv[4] if len(sys.argv) > 4 else ""
f = open(pkg, "rb")
size = os.path.getsize(pkg)
f.seek(size - TBL)
tbl = xor(f.read(TBL))
entries = []
for i in range(0, TBL, 256):
    e = tbl[i:i+256]
    plen = struct.unpack_from("<h", e, 0xE6)[0]
    if plen <= 0:
        continue
    path = e[:plen].decode("utf-8", "replace")
    flags = struct.unpack_from("<h", e, 0xE4)[0]
    fsz, offs = struct.unpack_from("<qq", e, 0xF0)
    entries.append((path, flags, fsz, offs))
print("entries", len(entries), file=sys.stderr)
if mode == "list":
    for p, fl, sz, o in entries:
        if filt.lower() in p.lower():
            print(f"{fl:5x} {sz:12d} {o:12d} {p}")
elif mode == "extract":
    for p, fl, sz, o in entries:
        if fl & 1 or filt.lower() not in p.lower():
            continue
        f.seek(o)
        data = f.read(sz)
        if fl & 0x100:
            data = xor(data)
        dst = pathlib.Path(out) / p.replace("\\", "/")
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    print("done", file=sys.stderr)

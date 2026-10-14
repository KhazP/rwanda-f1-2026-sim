import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const AC_TRACK_DIR =
  process.env.AC_TRACK_DIR ||
  'C:\\Users\\alpya\\Downloads\\Rwanda_International\\Rwanda_International';

const OUT_DIR = path.resolve(process.cwd(), 'public', 'tracks', 'rwanda');
const TEX_OUT_DIR = path.join(OUT_DIR, 'textures');

// Origin shift to center the circuit around (0, 0, 0) in Three.js world space
const ORIGIN_X = 2050.0;
const ORIGIN_Y = 40.0;
const ORIGIN_Z = -3750.0;

fs.mkdirSync(TEX_OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Pure-JS PNG Encoder (RGBA8 -> PNG via node:zlib)
// ---------------------------------------------------------------------------
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(typeStr, dataBuf) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function encodeRgbaToPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1; // Sub filter for better compression
    const srcStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[srcStart + x - 4] : 0;
      raw[rowStart + 1 + x] = (rgba[srcStart + x] - left) & 0xff;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function downsampleRgba(width, height, rgba, maxDim) {
  let w = width;
  let h = height;
  let data = rgba;
  while ((w > maxDim || h > maxDim) && w >= 4 && h >= 4) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = y * 2;
      const y1 = Math.min(h - 1, y0 + 1);
      for (let x = 0; x < nw; x++) {
        const x0 = x * 2;
        const x1 = Math.min(w - 1, x0 + 1);
        const i00 = (y0 * w + x0) * 4;
        const i10 = (y0 * w + x1) * 4;
        const i01 = (y1 * w + x0) * 4;
        const i11 = (y1 * w + x1) * 4;
        const dst = (y * nw + x) * 4;
        next[dst] = (data[i00] + data[i10] + data[i01] + data[i11] + 2) >> 2;
        next[dst + 1] = (data[i00 + 1] + data[i10 + 1] + data[i01 + 1] + data[i11 + 1] + 2) >> 2;
        next[dst + 2] = (data[i00 + 2] + data[i10 + 2] + data[i01 + 2] + data[i11 + 2] + 2) >> 2;
        next[dst + 3] = (data[i00 + 3] + data[i10 + 3] + data[i01 + 3] + data[i11 + 3] + 2) >> 2;
      }
    }
    w = nw;
    h = nh;
    data = next;
  }
  return { width: w, height: h, rgba: data };
}

// ---------------------------------------------------------------------------
// 2. Pure-JS DDS Decoder (DXT1, DXT3, DXT5, and uncompressed RGBA/BGRA)
// ---------------------------------------------------------------------------
function unpackRgb565(c) {
  const r = ((c >> 11) & 31) * 255 / 31;
  const g = ((c >> 5) & 63) * 255 / 63;
  const b = (c & 31) * 255 / 31;
  return [Math.round(r), Math.round(g), Math.round(b)];
}

function decodeDdsToRgba(buf) {
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const pfFlags = buf.readUInt32LE(80);
  const fourCC = buf.toString('ascii', 84, 88);
  const rgbBitCount = buf.readUInt32LE(88);
  const rMask = buf.readUInt32LE(92);

  let dataOffset = 128;
  if (fourCC === 'DX10') dataOffset += 20;

  const rgba = new Uint8Array(width * height * 4);
  const blocksX = Math.max(1, Math.ceil(width / 4));
  const blocksY = Math.max(1, Math.ceil(height / 4));

  if ((pfFlags & 0x4) !== 0 && (fourCC === 'DXT1' || fourCC === 'DXT3' || fourCC === 'DXT5')) {
    const blockBytes = fourCC === 'DXT1' ? 8 : 16;
    let ptr = dataOffset;
    const colors = [
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ];
    const alphas = new Uint8Array(8);
    const blockAlpha = new Uint8Array(16);

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        if (ptr + blockBytes > buf.length) break;
        let cPtr = ptr;
        if (fourCC === 'DXT3') {
          for (let i = 0; i < 8; i++) {
            const byte = buf[ptr + i];
            blockAlpha[i * 2] = (byte & 0x0f) * 17;
            blockAlpha[i * 2 + 1] = ((byte >> 4) & 0x0f) * 17;
          }
          cPtr = ptr + 8;
        } else if (fourCC === 'DXT5') {
          const a0 = buf[ptr];
          const a1 = buf[ptr + 1];
          alphas[0] = a0;
          alphas[1] = a1;
          if (a0 > a1) {
            for (let k = 1; k <= 6; k++) alphas[k + 1] = Math.round(((7 - k) * a0 + k * a1) / 7);
          } else {
            for (let k = 1; k <= 4; k++) alphas[k + 1] = Math.round(((5 - k) * a0 + k * a1) / 5);
            alphas[6] = 0;
            alphas[7] = 255;
          }
          // 48-bit alpha index table (6 bytes at ptr+2..ptr+7)
          const lo = buf.readUInt32LE(ptr + 2);
          const hi = buf.readUInt16LE(ptr + 6);
          for (let i = 0; i < 16; i++) {
            const bitPos = i * 3;
            let idx;
            if (bitPos < 30) {
              idx = (lo >>> bitPos) & 7;
            } else if (bitPos === 30) {
              idx = ((lo >>> 30) & 3) | ((hi & 1) << 2);
            } else {
              idx = (hi >>> (bitPos - 32)) & 7;
            }
            blockAlpha[i] = alphas[idx];
          }
          cPtr = ptr + 8;
        }

        const c0 = buf.readUInt16LE(cPtr);
        const c1 = buf.readUInt16LE(cPtr + 2);
        const bits = buf.readUInt32LE(cPtr + 4);
        const [r0, g0, b0] = unpackRgb565(c0);
        const [r1, g1, b1] = unpackRgb565(c1);
        colors[0][0] = r0; colors[0][1] = g0; colors[0][2] = b0; colors[0][3] = 255;
        colors[1][0] = r1; colors[1][1] = g1; colors[1][2] = b1; colors[1][3] = 255;

        if (c0 > c1 || fourCC !== 'DXT1') {
          colors[2][0] = Math.round((2 * r0 + r1) / 3);
          colors[2][1] = Math.round((2 * g0 + g1) / 3);
          colors[2][2] = Math.round((2 * b0 + b1) / 3);
          colors[2][3] = 255;
          colors[3][0] = Math.round((r0 + 2 * r1) / 3);
          colors[3][1] = Math.round((g0 + 2 * g1) / 3);
          colors[3][2] = Math.round((b0 + 2 * b1) / 3);
          colors[3][3] = 255;
        } else {
          colors[2][0] = (r0 + r1) >> 1;
          colors[2][1] = (g0 + g1) >> 1;
          colors[2][2] = (b0 + b1) >> 1;
          colors[2][3] = 255;
          colors[3][0] = 0;
          colors[3][1] = 0;
          colors[3][2] = 0;
          colors[3][3] = 0;
        }

        for (let py = 0; py < 4; py++) {
          const y = by * 4 + py;
          if (y >= height) continue;
          for (let px = 0; px < 4; px++) {
            const x = bx * 4 + px;
            if (x >= width) continue;
            const pIdx = py * 4 + px;
            const cIdx = (bits >>> (pIdx * 2)) & 3;
            const dst = (y * width + x) * 4;
            rgba[dst] = colors[cIdx][0];
            rgba[dst + 1] = colors[cIdx][1];
            rgba[dst + 2] = colors[cIdx][2];
            rgba[dst + 3] = fourCC === 'DXT1' ? colors[cIdx][3] : blockAlpha[pIdx];
          }
        }
        ptr += blockBytes;
      }
    }
  } else {
    // Uncompressed RGBA/BGRA/RGB
    const bytesPerPixel = Math.max(3, Math.floor((rgbBitCount || 32) / 8));
    const isBgra = rMask === 0x00ff0000;
    let ptr = dataOffset;
    for (let i = 0; i < width * height; i++) {
      if (ptr + bytesPerPixel > buf.length) break;
      const dst = i * 4;
      if (isBgra) {
        rgba[dst] = buf[ptr + 2];
        rgba[dst + 1] = buf[ptr + 1];
        rgba[dst + 2] = buf[ptr];
      } else {
        rgba[dst] = buf[ptr];
        rgba[dst + 1] = buf[ptr + 1];
        rgba[dst + 2] = buf[ptr + 2];
      }
      rgba[dst + 3] = bytesPerPixel >= 4 ? buf[ptr + 3] : 255;
      ptr += bytesPerPixel;
    }
  }

  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// 3. Parse KN5 File Helper
// ---------------------------------------------------------------------------
function createIdentityMat4() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMat4(localMat, parentMat) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        localMat[r * 4 + 0] * parentMat[0 * 4 + c] +
        localMat[r * 4 + 1] * parentMat[1 * 4 + c] +
        localMat[r * 4 + 2] * parentMat[2 * 4 + c] +
        localMat[r * 4 + 3] * parentMat[3 * 4 + c];
    }
  }
  return out;
}

function isIdentityMat4(m) {
  return (
    Math.abs(m[0] - 1) < 1e-5 &&
    Math.abs(m[1]) < 1e-5 &&
    Math.abs(m[2]) < 1e-5 &&
    Math.abs(m[3]) < 1e-5 &&
    Math.abs(m[4]) < 1e-5 &&
    Math.abs(m[5] - 1) < 1e-5 &&
    Math.abs(m[6]) < 1e-5 &&
    Math.abs(m[7]) < 1e-5 &&
    Math.abs(m[8]) < 1e-5 &&
    Math.abs(m[9]) < 1e-5 &&
    Math.abs(m[10] - 1) < 1e-5 &&
    Math.abs(m[11]) < 1e-5 &&
    Math.abs(m[12]) < 1e-5 &&
    Math.abs(m[13]) < 1e-5 &&
    Math.abs(m[14]) < 1e-5 &&
    Math.abs(m[15] - 1) < 1e-5
  );
}

function transformPointMat4(x, y, z, m) {
  if (!m || m._isIdentity) return [x, y, z];
  return [
    x * m[0] + y * m[4] + z * m[8] + m[12],
    x * m[1] + y * m[5] + z * m[9] + m[13],
    x * m[2] + y * m[6] + z * m[10] + m[14],
  ];
}

function transformNormalMat4(nx, ny, nz, m) {
  if (!m || m._isIdentity) return [nx, ny, nz];
  const rx = nx * m[0] + ny * m[4] + nz * m[8];
  const ry = nx * m[1] + ny * m[5] + nz * m[9];
  const rz = nx * m[2] + ny * m[6] + nz * m[10];
  const len = Math.hypot(rx, ry, rz) || 1;
  return [rx / len, ry / len, rz / len];
}

function parseKn5(filePath) {
  const buf = fs.readFileSync(filePath);
  const magic = buf.toString('ascii', 0, 6);
  if (magic !== 'sc6969') {
    throw new Error(`Invalid KN5 magic in ${filePath}: ${magic}`);
  }
  let pos = 6;
  const version = buf.readInt32LE(pos);
  pos += 4;
  if (version > 5) pos += 4;

  const texCount = buf.readInt32LE(pos);
  pos += 4;
  const textures = new Map();
  for (let i = 0; i < texCount; i++) {
    const active = buf.readInt32LE(pos);
    pos += 4;
    const nameLen = buf.readInt32LE(pos);
    pos += 4;
    const name = buf.toString('utf8', pos, pos + nameLen);
    pos += nameLen;
    const byteSize = buf.readInt32LE(pos);
    pos += 4;
    const data = buf.subarray(pos, pos + byteSize);
    pos += byteSize;
    if (active && byteSize > 0) {
      textures.set(name, data);
    }
  }

  const matCount = buf.readInt32LE(pos);
  pos += 4;
  const materials = [];
  for (let i = 0; i < matCount; i++) {
    const nameLen = buf.readInt32LE(pos);
    pos += 4;
    const name = buf.toString('utf8', pos, pos + nameLen);
    pos += nameLen;
    const shaderLen = buf.readInt32LE(pos);
    pos += 4;
    const shader = buf.toString('utf8', pos, pos + shaderLen);
    pos += shaderLen;
    const alphaBlend = buf.readUInt8(pos);
    const alphaTested = buf.readUInt8(pos + 1);
    const depthMode = buf.readInt32LE(pos + 2);
    pos += 6;

    const propCount = buf.readInt32LE(pos);
    pos += 4;
    const props = {};
    for (let p = 0; p < propCount; p++) {
      const pLen = buf.readInt32LE(pos);
      pos += 4;
      const pName = buf.toString('utf8', pos, pos + pLen);
      pos += pLen;
      const valA = buf.readFloatLE(pos);
      const valB = [buf.readFloatLE(pos + 4), buf.readFloatLE(pos + 8)];
      const valC = [
        buf.readFloatLE(pos + 12),
        buf.readFloatLE(pos + 16),
        buf.readFloatLE(pos + 20),
      ];
      props[pName] = { valA, valB, valC };
      pos += 40;
    }

    const slotCount = buf.readInt32LE(pos);
    pos += 4;
    const texSlots = {};
    for (let s = 0; s < slotCount; s++) {
      const sLen = buf.readInt32LE(pos);
      pos += 4;
      const slotName = buf.toString('utf8', pos, pos + sLen);
      pos += sLen;
      pos += 4; // slot index
      const tLen = buf.readInt32LE(pos);
      pos += 4;
      const texName = buf.toString('utf8', pos, pos + tLen);
      pos += tLen;
      texSlots[slotName] = texName;
    }

    materials.push({
      id: i,
      name,
      shader,
      alphaBlend,
      alphaTested,
      depthMode,
      props,
      texSlots,
    });
  }

  const meshes = [];
  const rootIdent = createIdentityMat4();
  rootIdent._isIdentity = true;

  function readNode(ancestorPath = '', parentMatrix = rootIdent) {
    const nodeClass = buf.readInt32LE(pos);
    pos += 4;
    const nameLen = buf.readInt32LE(pos);
    pos += 4;
    const name = buf.toString('utf8', pos, pos + nameLen);
    pos += nameLen;
    const childrenCount = buf.readInt32LE(pos);
    pos += 4;
    const active = buf.readUInt8(pos);
    pos += 1;

    const currentPath = ancestorPath ? `${ancestorPath}/${name}` : name;
    let currentMatrix = parentMatrix;

    if (nodeClass === 1) {
      const localMat = new Array(16);
      for (let k = 0; k < 16; k++) {
        localMat[k] = buf.readFloatLE(pos + k * 4);
      }
      pos += 64; // 4x4 transform matrix
      currentMatrix = multiplyMat4(localMat, parentMatrix);
      currentMatrix._isIdentity = isIdentityMat4(currentMatrix);
    } else if (nodeClass === 2) {
      const castShadows = buf.readUInt8(pos);
      const isVisible = buf.readUInt8(pos + 1);
      const isTransparent = buf.readUInt8(pos + 2);
      pos += 3;

      const vCount = buf.readInt32LE(pos);
      pos += 4;
      const vByteStart = pos;
      pos += vCount * 44;

      const iCount = buf.readInt32LE(pos);
      pos += 4;
      const iByteStart = pos;
      pos += iCount * 2;

      const materialId = buf.readInt32LE(pos);
      pos += 4;
      pos += 29; // layer + lodIn + lodOut + bounding sphere + isRenderable

      meshes.push({
        name,
        parentName: ancestorPath,
        ancestorPath: currentPath,
        worldMatrix: currentMatrix,
        active,
        castShadows,
        isVisible,
        isTransparent,
        vCount,
        vByteStart,
        iCount,
        iByteStart,
        materialId,
        buf,
      });
    } else if (nodeClass === 3) {
      pos += 3;
      const boneCount = buf.readInt32LE(pos);
      pos += 4;
      for (let b = 0; b < boneCount; b++) {
        const bLen = buf.readInt32LE(pos);
        pos += 4 + bLen + 64;
      }
      const vCount = buf.readInt32LE(pos);
      pos += 4 + vCount * 76;
      const iCount = buf.readInt32LE(pos);
      pos += 4 + iCount * 2 + 12;
    }

    for (let c = 0; c < childrenCount; c++) {
      readNode(currentPath, currentMatrix);
    }
  }

  readNode();
  return { textures, materials, meshes };
}

console.log('Parsing Rwanda_International.kn5 and Rwanda_International_2026.kn5...');
const baseKn5 = parseKn5(path.join(AC_TRACK_DIR, 'Rwanda_International.kn5'));
const ext2026Kn5 = parseKn5(path.join(AC_TRACK_DIR, 'Rwanda_International_2026.kn5'));

// ---------------------------------------------------------------------------
// 4. Build Exact Surface Height Sampler from 1ROAD0_SUB0, 1TARMAC0, 1KERB*
// ---------------------------------------------------------------------------
const roadVerts = [];
const roadTris = [];

for (const mesh of baseKn5.meshes) {
  const isRoad = mesh.name.includes('ROAD');
  const isTarmac = mesh.name.includes('TARMAC') || mesh.name.includes('PIT');
  const isKerb = mesh.name.includes('KERB');
  if (!isRoad && !isTarmac && !isKerb) continue;

  const prio = mesh.name === '1ROAD0_SUB0' ? 0 : isTarmac ? 1 : isRoad ? 2 : 3;
  const baseV = roadVerts.length;
  const { buf, vByteStart, vCount, iByteStart, iCount, worldMatrix } = mesh;

  for (let v = 0; v < vCount; v++) {
    const off = vByteStart + v * 44;
    roadVerts.push(
      transformPointMat4(
        buf.readFloatLE(off),
        buf.readFloatLE(off + 4),
        buf.readFloatLE(off + 8),
        worldMatrix
      )
    );
  }
  for (let t = 0; t < iCount; t += 3) {
    const off = iByteStart + t * 2;
    roadTris.push([
      baseV + buf.readUInt16LE(off),
      baseV + buf.readUInt16LE(off + 2),
      baseV + buf.readUInt16LE(off + 4),
      prio,
    ]);
  }
}

const CELL_SIZE = 10;
const roadGrid = new Map();
for (let ti = 0; ti < roadTris.length; ti++) {
  const [i0, i1, i2] = roadTris[ti];
  const a = roadVerts[i0];
  const b = roadVerts[i1];
  const c = roadVerts[i2];
  const minGX = Math.floor((Math.min(a[0], b[0], c[0]) - 0.5) / CELL_SIZE);
  const maxGX = Math.floor((Math.max(a[0], b[0], c[0]) + 0.5) / CELL_SIZE);
  const minGZ = Math.floor((Math.min(a[2], b[2], c[2]) - 0.5) / CELL_SIZE);
  const maxGZ = Math.floor((Math.max(a[2], b[2], c[2]) + 0.5) / CELL_SIZE);
  for (let gx = minGX; gx <= maxGX; gx++) {
    for (let gz = minGZ; gz <= maxGZ; gz++) {
      const key = `${gx},${gz}`;
      let list = roadGrid.get(key);
      if (!list) {
        list = [];
        roadGrid.set(key, list);
      }
      list.push(ti);
    }
  }
}

function sampleRoadHeightAtXZ(x, z, hintY) {
  const gx = Math.floor(x / CELL_SIZE);
  const gz = Math.floor(z / CELL_SIZE);
  let bestY = null;
  let bestScore = Infinity;
  let bestNormal = [0, 1, 0];
  let bestPrio = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = roadGrid.get(`${gx + dx},${gz + dz}`);
      if (!list) continue;
      for (const ti of list) {
        const [i0, i1, i2, prio] = roadTris[ti];
        const a = roadVerts[i0];
        const b = roadVerts[i1];
        const c = roadVerts[i2];
        const v0x = b[0] - a[0];
        const v0z = b[2] - a[2];
        const v1x = c[0] - a[0];
        const v1z = c[2] - a[2];
        const v2x = x - a[0];
        const v2z = z - a[2];
        const denom = v0x * v1z - v1x * v0z;
        if (Math.abs(denom) < 1e-8) continue;
        const u = (v2x * v1z - v1x * v2z) / denom;
        const v = (v0x * v2z - v2x * v0z) / denom;
        if (u >= -0.08 && v >= -0.08 && u + v <= 1.08) {
          const y = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
          const yDiff = Math.abs(y - hintY);
          if (yDiff > 3.0) continue;
          const score = prio * 0.04 + yDiff;
          if (score < bestScore) {
            bestScore = score;
            bestY = y;
            bestPrio = prio;
            const ux = b[0] - a[0];
            const uy = b[1] - a[1];
            const uz = b[2] - a[2];
            const vx = c[0] - a[0];
            const vy = c[1] - a[1];
            const vz = c[2] - a[2];
            let nx = uy * vz - uz * vy;
            let ny = uz * vx - ux * vz;
            let nz = ux * vy - uy * vx;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len;
            ny /= len;
            nz /= len;
            if (ny < 0) {
              nx = -nx;
              ny = -ny;
              nz = -nz;
            }
            bestNormal = [nx, ny, nz];
          }
        }
      }
    }
  }
  return { y: bestY, normal: bestNormal, prio: bestPrio };
}

// ---------------------------------------------------------------------------
// 5. Parse INI / JSON Track Files & fast_lane.ai
// ---------------------------------------------------------------------------
function parseIni(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const sections = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split(';')[0].split('//')[0].trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1).trim();
      sections[current] = {};
    } else if (current && line.includes('=')) {
      const eq = line.indexOf('=');
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      sections[current][k] = v;
    }
  }
  return sections;
}

const uiTrack = JSON.parse(
  fs.readFileSync(path.join(AC_TRACK_DIR, 'ui', 'layout_2026', 'ui_track.json'), 'utf8')
);
const drsIni = parseIni(path.join(AC_TRACK_DIR, 'layout_2026', 'data', 'drs_zones.ini'));
const camIni = parseIni(path.join(AC_TRACK_DIR, 'layout_2026', 'data', 'cameras.ini'));
const surfIni = parseIni(path.join(AC_TRACK_DIR, 'layout_2026', 'data', 'surfaces.ini'));

const drsZones = [];
for (const [sec, vals] of Object.entries(drsIni)) {
  if (sec.startsWith('ZONE_')) {
    drsZones.push({
      id: sec,
      detection: parseFloat(vals.DETECTION),
      start: parseFloat(vals.START),
      end: parseFloat(vals.END),
    });
  }
}

const cameras = [];
for (const [sec, vals] of Object.entries(camIni)) {
  if (sec.startsWith('CAMERA_')) {
    const posArr = vals.POSITION.split(',').map((s) => parseFloat(s.trim()));
    const fwdArr = vals.FORWARD.split(',').map((s) => parseFloat(s.trim()));
    const upArr = vals.UP.split(',').map((s) => parseFloat(s.trim()));
    cameras.push({
      name: vals.NAME || sec,
      position: [
        Number((posArr[0] - ORIGIN_X).toFixed(3)),
        Number((posArr[1] - ORIGIN_Y).toFixed(3)),
        Number((posArr[2] - ORIGIN_Z).toFixed(3)),
      ],
      forward: fwdArr.map((n) => Number(n.toFixed(5))),
      up: upArr.map((n) => Number(n.toFixed(5))),
      minFov: parseFloat(vals.MIN_FOV || '10'),
      maxFov: parseFloat(vals.MAX_FOV || '60'),
      inPoint: parseFloat(vals.IN_POINT || '0'),
      outPoint: parseFloat(vals.OUT_POINT || '1'),
    });
  }
}

// Parse fast_lane.ai
const aiBuf = fs.readFileSync(path.join(AC_TRACK_DIR, 'layout_2026', 'ai', 'fast_lane.ai'));
const numAiPoints = aiBuf.readInt32LE(4);
const extraBase = 16 + numAiPoints * 20 + 4;

const rawAi = [];
for (let i = 0; i < numAiPoints; i++) {
  const pOff = 16 + i * 20;
  const x = aiBuf.readFloatLE(pOff);
  const y = aiBuf.readFloatLE(pOff + 4);
  const z = aiBuf.readFloatLE(pOff + 8);
  const dist = aiBuf.readFloatLE(pOff + 12);

  const eOff = extraBase + i * 72;
  const speedMs = Math.max(8.0, aiBuf.readFloatLE(eOff + 0 * 4));
  const gas = Math.max(0.0, Math.min(1.0, aiBuf.readFloatLE(eOff + 1 * 4)));
  const brake = Math.max(0.0, Math.min(1.0, aiBuf.readFloatLE(eOff + 2 * 4)));
  const radius = aiBuf.readFloatLE(eOff + 4 * 4);
  const sideLeft = Math.max(1.0, aiBuf.readFloatLE(eOff + 5 * 4));
  const sideRight = Math.max(1.0, aiBuf.readFloatLE(eOff + 6 * 4));
  const camber = aiBuf.readFloatLE(eOff + 7 * 4);
  rawAi.push({ x, y, z, dist, speedMs, gas, brake, radius, sideLeft, sideRight, camber });
}

// Compute tangents & smooth lateral center shift so the track centerline is C2 smooth
for (let i = 0; i < numAiPoints; i++) {
  const prev = rawAi[(i - 2 + numAiPoints) % numAiPoints];
  const next = rawAi[(i + 2) % numAiPoints];
  const fx = next.x - prev.x;
  const fz = next.z - prev.z;
  const len = Math.hypot(fx, fz) || 1;
  rawAi[i].tx = fx / len;
  rawAi[i].tz = fz / len;
  rawAi[i].rx = -rawAi[i].tz;
  rawAi[i].rz = rawAi[i].tx;
}

const smoothShift = new Float64Array(numAiPoints);
const smoothWidth = new Float64Array(numAiPoints);
const WINDOW = 18;
for (let i = 0; i < numAiPoints; i++) {
  let sumShift = 0;
  let sumW = 0;
  let count = 0;
  for (let k = -WINDOW; k <= WINDOW; k++) {
    const pt = rawAi[(i + k + numAiPoints) % numAiPoints];
    const w = Math.min(20.0, Math.max(11.0, pt.sideLeft + pt.sideRight));
    const shift = 0.5 * (pt.sideRight - pt.sideLeft);
    sumShift += shift;
    sumW += w;
    count++;
  }
  smoothShift[i] = sumShift / count;
  smoothWidth[i] = sumW / count;
}

const STEP = 3;
const trackSamples = [];
for (let i = 0; i < numAiPoints; i += STEP) {
  const pt = rawAi[i];
  const shift = smoothShift[i];
  const width = smoothWidth[i];

  const cxRaw = pt.x + pt.rx * shift;
  const czRaw = pt.z + pt.rz * shift;
  const rxRaw = pt.x;
  const rzRaw = pt.z;

  const raceHit = sampleRoadHeightAtXZ(rxRaw, rzRaw, pt.y);
  const ryRaw = raceHit.y !== null ? raceHit.y : pt.y - 0.23;

  const centerHit = sampleRoadHeightAtXZ(cxRaw, czRaw, pt.y);
  const cyRaw = centerHit.y !== null ? centerHit.y : ryRaw;

  const leftHit = sampleRoadHeightAtXZ(cxRaw - pt.rx * 4.0, czRaw - pt.rz * 4.0, cyRaw);
  const rightHit = sampleRoadHeightAtXZ(cxRaw + pt.rx * 4.0, czRaw + pt.rz * 4.0, cyRaw);
  let banking = 0;
  if (leftHit.y !== null && rightHit.y !== null) {
    banking = Math.atan2(leftHit.y - rightHit.y, 8.0);
    banking = Math.max(-0.12, Math.min(0.12, banking));
  }

  const racingLineOffset = -shift;

  trackSamples.push({
    s: Number(pt.dist.toFixed(3)),
    p: [
      Number((cxRaw - ORIGIN_X).toFixed(3)),
      Number((cyRaw - ORIGIN_Y).toFixed(3)),
      Number((czRaw - ORIGIN_Z).toFixed(3)),
    ],
    r: [
      Number((rxRaw - ORIGIN_X).toFixed(3)),
      Number((ryRaw - ORIGIN_Y).toFixed(3)),
      Number((rzRaw - ORIGIN_Z).toFixed(3)),
    ],
    ro: Number(racingLineOffset.toFixed(3)),
    w: Number(width.toFixed(2)),
    b: Number(banking.toFixed(4)),
    g: centerHit.prio === 1 ? 0.99 : 1.0,
    v: Number((pt.speedMs * 3.6).toFixed(1)),
    gas: Number(pt.gas.toFixed(3)),
    brk: Number(pt.brake.toFixed(3)),
  });
}

const totalLength = Number(
  (
    rawAi[numAiPoints - 1].dist +
    Math.hypot(
      rawAi[0].x - rawAi[numAiPoints - 1].x,
      rawAi[0].y - rawAi[numAiPoints - 1].y,
      rawAi[0].z - rawAi[numAiPoints - 1].z
    )
  ).toFixed(2)
);

const trackDataJson = {
  metadata: {
    name: uiTrack.name || 'Rwanda International Circuit',
    description: uiTrack.description || 'F1 2026 Variant',
    country: uiTrack.country || 'Rwanda',
    city: uiTrack.city || 'Bugesera',
    lengthMeters: totalLength,
    widthMeters: uiTrack.width || '13m-18m',
    pitboxes: parseInt(uiTrack.pitboxes || '32', 10),
    direction: uiTrack.run || 'clockwise',
    geotags: uiTrack.geotags || [],
    author: uiTrack.author || 'Assetto Corsa Rwanda International',
    originOffset: [ORIGIN_X, ORIGIN_Y, ORIGIN_Z],
    surfaces: {
      roadGrip: parseFloat(surfIni.SURFACE_0?.FRICTION || '1.0'),
      tarmacGrip: parseFloat(surfIni.SURFACE_1?.FRICTION || '0.99'),
      kerbGrip: parseFloat(surfIni.SURFACE_2?.FRICTION || '0.95'),
    },
  },
  drsZones,
  cameras,
  samples: trackSamples,
};

fs.writeFileSync(
  path.join(OUT_DIR, 'track_data.json'),
  JSON.stringify(trackDataJson)
);
console.log(
  `Wrote public/tracks/rwanda/track_data.json (${trackSamples.length} samples, totalLength=${totalLength}m, ${cameras.length} cameras, ${drsZones.length} DRS zones)`
);

// ---------------------------------------------------------------------------
// 6. Filter, Batch & Weld 3D Meshes from Both KN5 Files
// ---------------------------------------------------------------------------
const EXCLUDE_PATTERNS = [
  /marshall/i,
  /texture modified/i,
  /cars1/i,
  /vehicles/i,
  /recoverytruck/i,
  /truckrs/i,
  /^trucks/i,
  /cherry\s*picker/i,
  /cameraman/i,
  /videocamera/i,
  /people/i,
  /toilet_block/i,
  /helicopter/i,
  /metpole/i,
  /^ac_start/i,
  /^ac_pit/i,
  /^ac_time/i,
  /^ac_hotlap/i,
  /^ac_audio/i,
  /^null/i,
];

function shouldExcludeMesh(mesh, mat) {
  const diffuseTex = mat?.texSlots?.txDiffuse || '';
  for (const pat of EXCLUDE_PATTERNS) {
    if (
      pat.test(mesh.name) ||
      pat.test(mesh.ancestorPath) ||
      pat.test(mat?.name || '') ||
      pat.test(diffuseTex)
    ) {
      return true;
    }
  }
  if (!mat || /^null/i.test(mat.name) || diffuseTex === 'NULL.dds') {
    return true;
  }

  const { buf, vByteStart, vCount, worldMatrix } = mesh;
  if (vCount === 0) return true;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let v = 0; v < vCount; v += Math.max(1, Math.floor(vCount / 50))) {
    const off = vByteStart + v * 44;
    const [x, , z] = transformPointMat4(
      buf.readFloatLE(off),
      buf.readFloatLE(off + 4),
      buf.readFloatLE(off + 8),
      worldMatrix
    );
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const isSatelliteTerrain = mesh.name.includes('GOOGLE_SAT') || mat.name.includes('rastMat');
  if (!isSatelliteTerrain) {
    if (maxX < 900 || minX > 3300 || maxZ < -4700 || minZ > -2800) {
      return true;
    }
  }
  return false;
}

const batches = new Map();
const usedTextures = new Map();

function addKn5Meshes(kn5) {
  for (const mesh of kn5.meshes) {
    const mat = kn5.materials[mesh.materialId];
    if (shouldExcludeMesh(mesh, mat)) continue;

    const diffuseTex = mat.texSlots.txDiffuse || '';
    const baseMatName = mat.name.replace(/\.\d+$/, '');
    const batchKey = `${baseMatName}__${diffuseTex}`;

    if (diffuseTex) {
      const texBuf = kn5.textures.get(diffuseTex) || baseKn5.textures.get(diffuseTex);
      if (texBuf && !usedTextures.has(diffuseTex)) {
        usedTextures.set(diffuseTex, texBuf);
      }
    }

    let batch = batches.get(batchKey);
    if (!batch) {
      const isFoliageOrFence =
        mat.shader === 'ksTree' ||
        /tree|fence|grass2|trans|symbol|welcome|bush|verde/i.test(mat.name) ||
        /tree|fence|grass2|trans|bush|verde/i.test(diffuseTex);

      const isRoadSurface =
        mesh.name.includes('1ROAD0_SUB0') ||
        mesh.name.includes('1TARMAC') ||
        mesh.name.includes('1PIT');

      const isKerbOrLine =
        mesh.name.includes('1KERB') ||
        mesh.name.includes('1ROAD0_SUB1') ||
        mesh.name.includes('1ROAD0_SUB2') ||
        mesh.name.includes('1ROAD0_SUB3');

      const isTerrain =
        mesh.name.includes('GOOGLE_SAT') ||
        mesh.name.includes('1GRASS') ||
        mesh.name.includes('1SAND') ||
        mesh.name.includes('1OFFTRACK');

      batch = {
        key: batchKey,
        materialName: baseMatName,
        shader: mat.shader,
        diffuseTex,
        alphaBlend: Boolean(mat.alphaBlend),
        alphaTest: Boolean(mat.alphaTested || isFoliageOrFence),
        isFoliage: Boolean(mat.shader === 'ksTree' || /tree|grass2|bush|verde/i.test(diffuseTex)),
        isRoadSurface: Boolean(isRoadSurface || isKerbOrLine),
        isCoreAsphalt: Boolean(isRoadSurface),
        isKerbOrLine: Boolean(isKerbOrLine),
        isTerrain,
        castShadow: Boolean(!isRoadSurface && !isKerbOrLine && !isTerrain && mesh.castShadows),
        receiveShadow: Boolean(isRoadSurface || isKerbOrLine || isTerrain),
        posMap: new Map(),
        positions: [],
        normals: [],
        uvs: [],
        indices: [],
      };
      batches.set(batchKey, batch);
    }

    const { buf, vByteStart, vCount, iByteStart, iCount, worldMatrix } = mesh;
    const localToBatchIdx = new Uint32Array(vCount);

    const isSolidColor =
      /ColorWhite|RwandaBlue|RwandaGreen|RwandaYellow|RwandaGold|Qatar Red|Rwandair Blue/i.test(
        diffuseTex + ' ' + mat.name
      );

    let posScale = 1.6;
    let uvScale = isSolidColor ? 0.0 : 3.0;
    if (batch.isCoreAsphalt) {
      posScale = 25.0;
      uvScale = 150.0;
    } else if (/drs|sm1|ot1|100m|150m|50m|rolex|start_lights/i.test(mesh.name + ' ' + mat.name)) {
      posScale = 30.0;
      uvScale = 80.0;
    } else if (batch.isKerbOrLine) {
      posScale = 1.5;
      uvScale = isSolidColor ? 0.0 : 1.5;
    } else if (/fences2/i.test(batch.key)) {
      posScale = 0.40;
      uvScale = isSolidColor ? 0.0 : 0.45;
    } else if (/metal_d|guardrail|tent|grandstand|trans|bush|verde|hospitality|jumbotron|radiomast/i.test(batch.key)) {
      posScale = 0.55;
      uvScale = isSolidColor ? 0.0 : 0.8;
    }

    for (let v = 0; v < vCount; v++) {
      const off = vByteStart + v * 44;
      const [wx, wy, wz] = transformPointMat4(
        buf.readFloatLE(off),
        buf.readFloatLE(off + 4),
        buf.readFloatLE(off + 8),
        worldMatrix
      );
      const px = wx - ORIGIN_X;
      const py = wy - ORIGIN_Y;
      const pz = wz - ORIGIN_Z;
      const [nx, ny, nz] = transformNormalMat4(
        buf.readFloatLE(off + 12),
        buf.readFloatLE(off + 16),
        buf.readFloatLE(off + 20),
        worldMatrix
      );
      const u = buf.readFloatLE(off + 24);
      const uvV = buf.readFloatLE(off + 28);

      const wKey =
        uvScale === 0
          ? `${Math.round(px * posScale)},${Math.round(py * posScale)},${Math.round(pz * posScale)}`
          : `${Math.round(px * posScale)},${Math.round(py * posScale)},${Math.round(pz * posScale)},${Math.round(u * uvScale)},${Math.round(uvV * uvScale)}`;
      let bIdx = batch.posMap.get(wKey);
      if (bIdx === undefined) {
        bIdx = batch.positions.length / 3;
        batch.posMap.set(wKey, bIdx);
        batch.positions.push(px, py, pz);
        batch.normals.push(nx, ny, nz);
        batch.uvs.push(u, uvV);
      }
      localToBatchIdx[v] = bIdx;
    }


    for (let t = 0; t < iCount; t += 3) {
      const off = iByteStart + t * 2;
      const i0 = localToBatchIdx[buf.readUInt16LE(off)];
      const i1 = localToBatchIdx[buf.readUInt16LE(off + 2)];
      const i2 = localToBatchIdx[buf.readUInt16LE(off + 4)];
      if (i0 !== i1 && i1 !== i2 && i2 !== i0) {
        batch.indices.push(i0, i1, i2);
      }
    }
  }
}

addKn5Meshes(baseKn5);
addKn5Meshes(ext2026Kn5);


// Also include Asphalt_detail.dds so we can bake micro-detail into Asphalt_color.dds & Asphalt_color_grip.dds
const asphaltDetailBuf = baseKn5.textures.get('Asphalt_detail.dds');
const asphaltDetailDecoded = asphaltDetailBuf ? decodeDdsToRgba(asphaltDetailBuf) : null;

// ---------------------------------------------------------------------------
// 7. Convert & Optimize Textures to public/tracks/rwanda/textures/
// ---------------------------------------------------------------------------
function sanitizeTexFilename(name) {
  const base = name.replace(/\.(dds|png|jpg|jpeg)$/i, '');
  const clean = base.replace(/[^a-zA-Z0-9_-]/g, '_');
  return clean;
}

const textureFileMap = new Map();
const psResizeTasks = [];

console.log(`Processing ${usedTextures.size} referenced textures...`);
for (const [texName, texBuf] of usedTextures.entries()) {
  const magic0 = texBuf[0];
  const magic1 = texBuf[1];
  const isPng = magic0 === 0x89 && magic1 === 0x50;
  const isJpg = magic0 === 0xff && magic1 === 0xd8;
  const isDds = texBuf.toString('ascii', 0, 4) === 'DDS ';
  const cleanBase = sanitizeTexFilename(texName);

  if (isDds) {
    const decoded = decodeDdsToRgba(texBuf);
    // If this is Asphalt_color.dds or Asphalt_color_grip.dds, blend subtle high-frequency grain from Asphalt_detail.dds
    if (
      asphaltDetailDecoded &&
      (texName === 'Asphalt_color.dds' || texName === 'Asphalt_color_grip.dds')
    ) {
      const { width: dw, height: dh, rgba: dRgba } = asphaltDetailDecoded;
      const { width: w, height: h, rgba } = decoded;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const dx = (x * 7) % dw;
          const dy = (y * 7) % dh;
          const dIdx = (dy * dw + dx) * 4;
          const grain = (dRgba[dIdx] - 128) * 0.25;
          rgba[idx] = Math.max(0, Math.min(255, Math.round(rgba[idx] + grain)));
          rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(rgba[idx + 1] + grain)));
          rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(rgba[idx + 2] + grain)));
        }
      }
    }

    const isHero = /asphalt|kerb|drs|road|banner|flag|rolex|pitwall|guardrail/i.test(texName);
    const maxDim = isHero ? 512 : 256;
    const resized = downsampleRgba(decoded.width, decoded.height, decoded.rgba, maxDim);
    const outFile = `${cleanBase}.png`;
    const pngData = encodeRgbaToPng(resized.width, resized.height, resized.rgba);
    fs.writeFileSync(path.join(TEX_OUT_DIR, outFile), pngData);
    textureFileMap.set(texName, outFile);
  } else if (isPng || isJpg) {
    const ext = isPng ? 'png' : 'jpg';
    const outFile = `${cleanBase}.${ext}`;
    const outPath = path.join(TEX_OUT_DIR, outFile);
    fs.writeFileSync(outPath, texBuf);
    textureFileMap.set(texName, outFile);

    // Queue oversized PNG/JPG (> 350 KB) for downsampling
    if (texBuf.length > 350 * 1024) {
      const isSat = /GOOGLE_SAT/i.test(texName);
      psResizeTasks.push({
        texName,
        inPath: outPath,
        cleanBase,
        maxDim: isSat ? 1024 : 512,
        toJpg: isSat || isJpg || !/trans|alpha|tree|symbol/i.test(texName),
      });
    }
  }
}

// Downsample oversized PNG/JPG textures using Windows .NET System.Drawing so GOOGLE_SAT_WM R.png (63 MB) becomes a crisp ~180 KB JPG
if (psResizeTasks.length > 0 && process.platform === 'win32') {
  console.log(`Downsampling ${psResizeTasks.length} oversized PNG/JPG textures...`);
  for (const task of psResizeTasks) {
    const targetExt = task.toJpg ? 'jpg' : 'png';
    const targetFile = `${task.cleanBase}.${targetExt}`;
    const targetPath = path.join(TEX_OUT_DIR, targetFile);
    const psScript = `
      Add-Type -AssemblyName System.Drawing
      $img = [System.Drawing.Image]::FromFile('${task.inPath.replace(/'/g, "''")}')
      $max = ${task.maxDim}
      $w = $img.Width
      $h = $img.Height
      if ($w -gt $max -or $h -gt $max) {
        if ($w -gt $h) { $nh = [int]($h * $max / $w); $nw = $max }
        else { $nw = [int]($w * $max / $h); $nh = $max }
      } else { $nw = $w; $nh = $h }
      $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($img, 0, 0, $nw, $nh)
      $g.Dispose()
      $img.Dispose()
      if ('${targetExt}' -eq 'jpg') {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 82L)
        $bmp.Save('${targetPath.replace(/'/g, "''")}', $codec, $ep)
      } else {
        $bmp.Save('${targetPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
      }
      $bmp.Dispose()
    `;
    try {
      execFileSync('pwsh', ['-NoProfile', '-Command', psScript], { stdio: 'ignore' });
      if (targetPath !== task.inPath && fs.existsSync(task.inPath)) {
        fs.unlinkSync(task.inPath);
      }
      textureFileMap.set(task.texName, targetFile);
    } catch (err) {
      console.warn('Warning: failed to resize', task.texName, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Pack Batched Geometry into Binary track_meshes.bin + manifest.json
//    To keep track_meshes.bin ultra-compact (< 12 MB):
//    - Positions: Float32Array (vCount * 3 * 4 bytes)
//    - Normals:   Int8Array    (vCount * 3 * 1 byte, padded to 4-byte boundary)
//    - UVs:       Float32Array (vCount * 2 * 4 bytes)
//    - Indices:   Uint16Array (if vCount <= 65535) or Uint32Array (padded to 4-byte boundary)
// ---------------------------------------------------------------------------
const manifestBatches = [];
const binChunks = [];
let currentByteOffset = 0;

function align4(len) {
  return (len + 3) & ~3;
}

let totalVerts = 0;
let totalTris = 0;

for (const batch of batches.values()) {
  const vCount = batch.positions.length / 3;
  const iCount = batch.indices.length;
  if (vCount === 0 || iCount === 0) continue;

  totalVerts += vCount;
  totalTris += iCount / 3;

  // 1. Positions (Float32)
  const posTyped = new Float32Array(batch.positions);
  const posBuf = Buffer.from(posTyped.buffer, posTyped.byteOffset, posTyped.byteLength);
  const posOffset = currentByteOffset;
  binChunks.push(posBuf);
  currentByteOffset += posBuf.length;

  // 2. Normals (Int8 quantized -127..127, 4-byte aligned)
  const normLenAligned = align4(batch.normals.length);
  const normBuf = Buffer.alloc(normLenAligned);
  for (let i = 0; i < batch.normals.length; i++) {
    const n = Math.max(-1, Math.min(1, batch.normals[i]));
    normBuf.writeInt8(Math.round(n * 127), i);
  }
  const normOffset = currentByteOffset;
  binChunks.push(normBuf);
  currentByteOffset += normBuf.length;

  // 3. UVs (Float32)
  const uvTyped = new Float32Array(batch.uvs);
  const uvBuf = Buffer.from(uvTyped.buffer, uvTyped.byteOffset, uvTyped.byteLength);
  const uvOffset = currentByteOffset;
  binChunks.push(uvBuf);
  currentByteOffset += uvBuf.length;

  // 4. Indices (Uint16 if vCount <= 65535, else Uint32)
  const useUint32 = vCount > 65535;
  let idxBuf;
  if (useUint32) {
    const idxTyped = new Uint32Array(batch.indices);
    idxBuf = Buffer.from(idxTyped.buffer, idxTyped.byteOffset, idxTyped.byteLength);
  } else {
    const idxTyped = new Uint16Array(batch.indices);
    const rawIdxBuf = Buffer.from(idxTyped.buffer, idxTyped.byteOffset, idxTyped.byteLength);
    const alignedLen = align4(rawIdxBuf.length);
    if (alignedLen !== rawIdxBuf.length) {
      idxBuf = Buffer.concat([rawIdxBuf, Buffer.alloc(alignedLen - rawIdxBuf.length)]);
    } else {
      idxBuf = rawIdxBuf;
    }
  }
  const idxOffset = currentByteOffset;
  binChunks.push(idxBuf);
  currentByteOffset += idxBuf.length;

  manifestBatches.push({
    key: batch.key,
    materialName: batch.materialName,
    shader: batch.shader,
    texture: textureFileMap.get(batch.diffuseTex) || null,
    alphaBlend: batch.alphaBlend,
    alphaTest: batch.alphaTest,
    isFoliage: batch.isFoliage,
    isRoadSurface: batch.isRoadSurface,
    isTerrain: batch.isTerrain,
    castShadow: batch.castShadow,
    receiveShadow: batch.receiveShadow,
    vCount,
    iCount,
    useUint32,
    posOffset,
    normOffset,
    uvOffset,
    idxOffset,
  });
}

const fullBin = Buffer.concat(binChunks);
fs.writeFileSync(path.join(OUT_DIR, 'track_meshes.bin'), fullBin);
fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify({
    version: 1,
    totalVerts,
    totalTris,
    byteLength: fullBin.length,
    batches: manifestBatches,
  })
);

let texTotalBytes = 0;
for (const f of fs.readdirSync(TEX_OUT_DIR)) {
  texTotalBytes += fs.statSync(path.join(TEX_OUT_DIR, f)).size;
}

console.log(
  `Done! Built ${manifestBatches.length} batches (${totalVerts.toLocaleString()} verts, ${totalTris.toLocaleString()} tris).`
);
console.log(
  `track_meshes.bin: ${(fullBin.length / 1024 / 1024).toFixed(2)} MB | textures: ${(texTotalBytes / 1024 / 1024).toFixed(2)} MB | total: ${((fullBin.length + texTotalBytes) / 1024 / 1024).toFixed(2)} MB`
);

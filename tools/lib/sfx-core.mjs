// PixelFX 纯 JavaScript 音效合成与动态参考库混音引擎 (Node.js ES Module + WebAssembly Audio)
// 提供程序化物理/芯片音效合成原语，以及由用户动态挂载与启停的可选外部音效参考库检索与切片混音能力。

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { createOggEncoder } from "wasm-media-encoders";
import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { MPEGDecoder } from "mpg123-decoder";

export const RATE = 22050;
const PEAK_LIMIT = Math.pow(10, -1.05 / 20);

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(LIB_DIR, "..", "..");
export const WS_DIR = join(REPO_ROOT, "workspace");
export const WS_SFX_DIR = join(WS_DIR, "sfx");
export const WS_REFS_UPLOAD_DIR = join(WS_DIR, "sfx-refs");
export const WS_REFS_CFG_FILE = join(WS_DIR, "sfx-refs.json");
export const WS_REFS_INDEX_FILE = join(WS_DIR, "state", "sfx-refs-index.json");

const AUDIO_EXTS = new Set([".wav", ".ogg", ".mp3"]);

const _sampleCache = new Map();
const _usedRefIds = new Set();
let _oggDecPromise = null;
let _mp3DecPromise = null;

async function getOggDecoder() {
  if (!_oggDecPromise) {
    _oggDecPromise = (async () => {
      const dec = new OggVorbisDecoder();
      await dec.ready;
      return dec;
    })();
  }
  return _oggDecPromise;
}

async function getMp3Decoder() {
  if (!_mp3DecPromise) {
    _mp3DecPromise = (async () => {
      const dec = new MPEGDecoder();
      await dec.ready;
      return dec;
    })();
  }
  return _mp3DecPromise;
}

/** 确定性伪随机数与高斯白噪声发生器（禁止使用 Math.random）。 */
export function sfxRng(seed = 1) {
  let state = (Number(seed) | 0) ^ 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    chance: (p) => next() < p,
    normal() {
      const u1 = Math.max(1e-9, next());
      const u2 = next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    },
    noise(length) {
      const out = new Float64Array(length);
      for (let i = 0; i < length; i++) {
        const u1 = Math.max(1e-9, next());
        const u2 = next();
        out[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      }
      return out;
    },
  };
}

function biquadPass(input, b0, b1, b2, a1, a2) {
  const n = input.length;
  const out = new Float64Array(n);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < n; i++) {
    const x = input[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    out[i] = y;
  }
  return out;
}

function reverseArray(arr) {
  const n = arr.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[n - 1 - i];
  return out;
}

function filtfiltBiquad(samples, b0, b1, b2, a1, a2) {
  if (samples.length < 16) return Float64Array.from(samples);
  const fwd = biquadPass(samples, b0, b1, b2, a1, a2);
  const bwd = biquadPass(reverseArray(fwd), b0, b1, b2, a1, a2);
  return reverseArray(bwd);
}

export function lowpass(samples, cutoff, rate = RATE) {
  const fc = Math.max(30, Math.min(Number(cutoff) || 4000, rate * 0.475));
  const w0 = (2 * Math.PI * fc) / rate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  return filtfiltBiquad(samples, b0, b1, b2, a1, a2);
}

export function highpass(samples, cutoff, rate = RATE) {
  const fc = Math.max(20, Math.min(Number(cutoff) || 80, rate * 0.46));
  const w0 = (2 * Math.PI * fc) / rate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  const b1 = -(1 + cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  return filtfiltBiquad(samples, b0, b1, b2, a1, a2);
}

export function band(samples, low, high, rate = RATE) {
  const lo = Math.max(22, Math.min(Number(low) || 80, rate * 0.44));
  const hi = Math.max(lo + 35, Math.min(Number(high) || 6000, rate * 0.48));
  return lowpass(highpass(samples, lo, rate), hi, rate);
}

export function resample(samples, fromRate, toRate = RATE) {
  if (fromRate === toRate || samples.length < 4) return Float64Array.from(samples);
  const ratio = fromRate / toRate;
  const src = ratio > 1.02 ? lowpass(samples, toRate * 0.45, fromRate) : samples;
  const outLen = Math.max(4, Math.round(src.length / ratio));
  const out = new Float64Array(outLen);
  const maxIdx = src.length - 1;

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const xm1 = src[Math.max(0, idx - 1)];
    const x0 = src[Math.min(maxIdx, idx)];
    const x1 = src[Math.min(maxIdx, idx + 1)];
    const x2 = src[Math.min(maxIdx, idx + 2)];
    const c0 = x0;
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    out[i] = ((c3 * frac + c2) * frac + c1) * frac + c0;
  }
  return out;
}

export function pitchShift(samples, semitones = 0) {
  if (Math.abs(semitones) < 0.02 || samples.length < 8) return Float64Array.from(samples);
  const speedRatio = Math.pow(2, semitones / 12);
  return resample(samples, RATE * speedRatio, RATE);
}

export function edgeFade(samples, attack = 0.0007, release = 0.025) {
  const out = Float64Array.from(samples);
  const n = out.length;
  if (!n) return out;
  const first = Math.min(Math.round(attack * RATE), n);
  const last = Math.min(Math.round(release * RATE), n);
  for (let i = 0; i < first; i++) {
    const s = Math.sin(((i / Math.max(1, first - 1)) * Math.PI) / 2);
    out[i] *= s * s;
  }
  for (let i = 0; i < last; i++) {
    const c = Math.cos(((i / Math.max(1, last - 1)) * Math.PI) / 2);
    out[n - last + i] *= c * c;
  }
  return out;
}

export function fit(samples, duration, release = 0.04) {
  const out = new Float64Array(Math.max(16, Math.round(duration * RATE)));
  const len = Math.min(out.length, samples.length);
  for (let i = 0; i < len; i++) out[i] = samples[i];
  return edgeFade(out, 0.0006, release);
}

export function splice(samples, begin, end, overlap = 0.012) {
  const i0 = Math.max(2, Math.min(samples.length, Math.round(begin * RATE)));
  const i1 = Math.max(0, Math.min(samples.length - 2, Math.round(end * RATE)));
  const first = samples.subarray(0, i0);
  const second = samples.subarray(i1);
  const count = Math.min(first.length, second.length, Math.max(2, Math.round(overlap * RATE)));
  const out = new Float64Array(first.length + second.length - count);
  out.set(first.subarray(0, first.length - count), 0);
  const midStart = first.length - count;
  for (let i = 0; i < count; i++) {
    const w = i / Math.max(1, count - 1);
    out[midStart + i] = first[first.length - count + i] * (1 - w) + second[i] * w;
  }
  out.set(second.subarray(count), midStart + count);
  return out;
}

export function place(destination, fragment, offsetSeconds = 0, gain = 1.0) {
  const pos = Math.max(0, Math.round(offsetSeconds * RATE));
  if (pos >= destination.length || !fragment?.length) return;
  const count = Math.min(fragment.length, destination.length - pos);
  for (let i = 0; i < count; i++) destination[pos + i] += fragment[i] * gain;
}

export function windowRms(samples) {
  const n = samples.length;
  if (!n) return 1e-6;
  const width = Math.max(1, Math.min(n, Math.round(0.05 * RATE)));
  let sumSq = 0;
  for (let i = 0; i < width; i++) sumSq += samples[i] * samples[i];
  let maxSq = sumSq;
  for (let i = width; i < n; i++) {
    sumSq += samples[i] * samples[i] - samples[i - width] * samples[i - width];
    if (sumSq > maxSq) maxSq = sumSq;
  }
  return Math.max(Math.sqrt(Math.max(0, maxSq) / width), 1e-6);
}

export function normLayer(samples, { low = null, high = null, release = 0.025 } = {}) {
  let out = Float64Array.from(samples);
  if (low != null && high != null) out = band(out, low, high);
  else if (low != null) out = highpass(out, low);
  else if (high != null) out = lowpass(out, high);
  out = edgeFade(out, 0.0007, release);
  const rms = windowRms(out);
  for (let i = 0; i < out.length; i++) out[i] /= rms;
  return out;
}

export function resonate(excitation, modes, decay = 0.12) {
  const n = excitation.length;
  const out = new Float64Array(n);
  for (const [freq, q, gain = 1.0] of modes) {
    if (!(freq > 35 && freq < RATE * 0.46)) continue;
    const w0 = (2 * Math.PI * freq) / RATE;
    const bw = w0 / Math.max(0.5, q);
    const beta = Math.tan(bw / 2);
    const gf = 1 / (1 + beta);
    const b0 = 1 - gf;
    const b2 = -(1 - gf);
    const a1 = -2 * gf * Math.cos(w0);
    const a2 = 2 * gf - 1;
    const modal = biquadPass(excitation, b0, 0, b2, a1, a2);
    for (let i = 0; i < n; i++) out[i] += modal[i] * gain;
  }
  const tau = Math.max(0.01, decay);
  for (let i = 0; i < n; i++) out[i] *= Math.exp(-(i / RATE) / tau);
  return normLayer(out, { release: Math.min(0.06, (n / RATE) * 0.35) });
}

export function pixelTexture(samples, amount = 0.15) {
  const n = samples.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-7 || amount <= 0.001 || n < 32) return Float64Array.from(samples);

  const norm = new Float64Array(n);
  for (let i = 0; i < n; i++) norm[i] = samples[i] / peak;

  const detail = band(norm, 350, 4800);
  let detailPeak = 1e-6;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(detail[i]);
    if (a > detailPeak) detailPeak = a;
  }

  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const held = detail[i & ~1];
    const crushed = (Math.round((held / detailPeak) * 127) / 127) * detailPeak;
    diff[i] = crushed - detail[i];
  }
  const roughness = band(diff, 350, 6200);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (norm[i] + roughness[i] * amount) * peak;
  return out;
}

export function pixelTick(duration = 0.022, frequency = 440) {
  const n = Math.max(8, Math.round(duration * RATE));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const ph = 2 * Math.PI * frequency * t;
    let v = Math.sin(ph);
    if (frequency * 3 < 8200) v += Math.sin(ph * 3) * 0.25;
    if (frequency * 5 < 8200) v += Math.sin(ph * 5) * 0.1;
    const env = (1 - Math.exp(-t / 0.00045)) * Math.exp(-t / 0.0045);
    out[i] = v * env;
  }
  return edgeFade(out, 0.0004, 0.008);
}

export function finish(samples, targetDb = -16.5, texture = 0.15) {
  let out = pixelTexture(samples, texture);
  out = edgeFade(out, 0.0005, 0.014);
  const scale = Math.pow(10, targetDb / 20) / windowRms(out);
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] *= scale;
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const f32 = new Float32Array(out.length);
  if (peak > PEAK_LIMIT) {
    for (let i = 0; i < out.length; i++) f32[i] = Math.tanh((out[i] / PEAK_LIMIT) * 0.92) * PEAK_LIMIT;
  } else {
    for (let i = 0; i < out.length; i++) f32[i] = out[i];
  }
  return f32;
}

// ---- 音频解码辅助 (支持 WAV / OGG / MP3) ----
function decodeWavBytes(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 44) return null;
  let fmtCode = 1, channels = 1, sampleRate = 44100, bitsPerSample = 16, dataOffset = -1, dataSize = 0;
  let off = 12;
  while (off + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const sz = dv.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmtCode = dv.getUint16(off + 8, true);
      channels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bitsPerSample = dv.getUint16(off + 22, true);
    } else if (id === "data") {
      dataOffset = off + 8;
      dataSize = Math.min(sz, dv.byteLength - dataOffset);
      break;
    }
    off += 8 + sz + (sz & 1);
  }
  if (dataOffset < 0 || channels < 1) return null;
  const bps = bitsPerSample >> 3;
  const frames = Math.floor(dataSize / (bps * channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOffset + (i * channels + c) * bps;
      if (fmtCode === 3 && bitsPerSample === 32) s += dv.getFloat32(p, true);
      else if (bitsPerSample === 8) s += (dv.getUint8(p) - 128) / 128;
      else if (bitsPerSample === 16) s += dv.getInt16(p, true) / 32768;
      else if (bitsPerSample === 24) s += (dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16)) / 8388608;
      else if (bitsPerSample === 32) s += dv.getInt32(p, true) / 2147483648;
    }
    mono[i] = s / channels;
  }
  return { mono, sampleRate };
}

export async function decodeAudioFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const bytes = Uint8Array.from(readFileSync(filePath));
  if (ext === ".wav") return decodeWavBytes(bytes);
  if (ext === ".ogg") {
    const dec = await getOggDecoder();
    await dec.reset();
    const d = await dec.decodeFile(bytes);
    if (!d.channelData?.length) return null;
    const len = d.channelData[0].length;
    const mono = new Float64Array(len);
    for (let c = 0; c < d.channelData.length; c++) {
      const ch = d.channelData[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i] / d.channelData.length;
    }
    return { mono, sampleRate: d.sampleRate };
  }
  if (ext === ".mp3") {
    const dec = await getMp3Decoder();
    await dec.reset();
    const d = dec.decode(bytes);
    if (!d.channelData?.length) return null;
    const len = d.channelData[0].length;
    const mono = new Float64Array(len);
    for (let c = 0; c < d.channelData.length; c++) {
      const ch = d.channelData[c];
      for (let i = 0; i < len; i++) mono[i] += ch[i] / d.channelData.length;
    }
    return { mono, sampleRate: d.sampleRate };
  }
  return null;
}

// ---- 动态可插拔、可选启用的音效参考库管理系统 (不内置任何固定包) ----
function slugify(str) {
  return (
    String(str || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "ref"
  );
}

function asciiSlug(str) {
  return (
    String(str || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "lib"
  );
}

export function readSfxRefsConfig() {
  if (!existsSync(WS_REFS_CFG_FILE)) {
    return { enabled: false, libraries: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(WS_REFS_CFG_FILE, "utf8"));
    return {
      enabled: Boolean(parsed.enabled),
      libraries: Array.isArray(parsed.libraries) ? parsed.libraries : [],
    };
  } catch {
    return { enabled: false, libraries: [] };
  }
}

export function writeSfxRefsConfig(cfg) {
  mkdirSync(dirname(WS_REFS_CFG_FILE), { recursive: true });
  writeFileSync(WS_REFS_CFG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

function readRefsIndex() {
  if (!existsSync(WS_REFS_INDEX_FILE)) return { sounds: [] };
  try {
    const parsed = JSON.parse(readFileSync(WS_REFS_INDEX_FILE, "utf8"));
    return { sounds: Array.isArray(parsed.sounds) ? parsed.sounds : [] };
  } catch {
    return { sounds: [] };
  }
}

function writeRefsIndex(data) {
  mkdirSync(dirname(WS_REFS_INDEX_FILE), { recursive: true });
  writeFileSync(WS_REFS_INDEX_FILE, JSON.stringify(data, null, 2), "utf8");
}

function walkAudioFiles(dir, maxFiles = 2000) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith(".") || ent.name === "__MACOSX" || ent.name === "node_modules") continue;
      const full = join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (AUDIO_EXTS.has(extname(ent.name).toLowerCase())) out.push(full);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

async function indexLibraryFolder(libId, rootDir) {
  const files = walkAudioFiles(rootDir);
  const indexed = [];
  const seen = new Set();

  for (const fp of files) {
    const rel = relative(rootDir, fp).split(sep);
    const ext = extname(fp);
    const stem = slugify(basename(fp, ext));
    const subDirs = rel.slice(0, -1).map(slugify).filter(Boolean);
    const relSlug = [...subDirs, stem].join("/");
    let refId = `${libId}/${relSlug}`;
    let k = 2;
    while (seen.has(refId)) refId = `${libId}/${relSlug}-${k++}`;
    seen.add(refId);

    let duration = 0;
    let peakTime = 0;
    try {
      const dec = await decodeAudioFile(fp);
      if (!dec || dec.mono.length < 32) continue;
      duration = Math.round((dec.mono.length / dec.sampleRate) * 1000) / 1000;
      let pk = 0, pkIdx = 0;
      for (let i = 0; i < dec.mono.length; i++) {
        const a = Math.abs(dec.mono[i]);
        if (a > pk) { pk = a; pkIdx = i; }
      }
      if (pk < 1e-5) continue;
      peakTime = Math.round((pkIdx / dec.sampleRate) * 1000) / 1000;
    } catch {
      continue;
    }

    const tokens = [libId, ...subDirs, stem]
      .join("-")
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5]+/)
      .filter((t) => t.length >= 2);

    indexed.push({
      id: refId,
      libId,
      absPath: normalize(fp),
      duration,
      peakTime,
      tags: [...new Set(tokens)],
    });
  }
  return indexed;
}

export function getSfxRefsStatus() {
  const cfg = readSfxRefsConfig();
  const idx = readRefsIndex();
  const enabledLibIds = new Set(cfg.libraries.filter((l) => l.enabled !== false).map((l) => l.id));
  const activeSoundCount = cfg.enabled
    ? idx.sounds.filter((s) => enabledLibIds.has(s.libId)).length
    : 0;
  return {
    enabled: cfg.enabled,
    active: cfg.enabled && activeSoundCount > 0,
    activeLibraryCount: cfg.enabled ? enabledLibIds.size : 0,
    activeSoundCount,
    totalSoundCount: idx.sounds.length,
    libraries: cfg.libraries,
  };
}

export function setSfxRefsGlobalEnabled(enabled) {
  const cfg = readSfxRefsConfig();
  cfg.enabled = Boolean(enabled);
  writeSfxRefsConfig(cfg);
  return getSfxRefsStatus();
}

export async function addLocalDirRefLibrary({ name, dirPath }) {
  if (!dirPath || !String(dirPath).trim()) throw new Error("请填写本地音效参考目录路径");
  const resolved = resolve(REPO_ROOT, String(dirPath).trim());
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`目录不存在或不可访问: ${resolved}`);
  }

  const cfg = readSfxRefsConfig();
  const baseId = asciiSlug(name || basename(resolved));
  let libId = baseId;
  let n = 2;
  while (cfg.libraries.some((l) => l.id === libId)) libId = `${baseId}-${n++}`;

  const entries = await indexLibraryFolder(libId, resolved);
  if (!entries.length) {
    throw new Error("该目录下未扫描到任何有效的 .ogg / .wav / .mp3 音频文件");
  }

  const idx = readRefsIndex();
  idx.sounds = [...idx.sounds.filter((s) => s.libId !== libId), ...entries];
  writeRefsIndex(idx);

  cfg.libraries.push({
    id: libId,
    name: String(name || basename(resolved)).trim(),
    sourceType: "dir",
    dirPath: resolved,
    enabled: true,
    count: entries.length,
    addedAt: new Date().toISOString(),
  });
  cfg.enabled = true;
  writeSfxRefsConfig(cfg);
  return getSfxRefsStatus();
}

export async function importUploadedRefLibrary({ name, files }) {
  if (!Array.isArray(files) || !files.length) throw new Error("未选择任何音频或 ZIP 文件");
  const cfg = readSfxRefsConfig();
  const displayName = String(name || files[0].name.replace(/\.[^.]+$/, "")).trim() || "导入音效包";
  const baseId = asciiSlug(displayName);
  let libId = baseId;
  let n = 2;
  while (cfg.libraries.some((l) => l.id === libId)) libId = `${baseId}-${n++}`;

  const targetDir = join(WS_REFS_UPLOAD_DIR, libId);
  mkdirSync(targetDir, { recursive: true });

  for (const f of files) {
    const ext = extname(f.name || "").toLowerCase();
    const bytes = new Uint8Array(Buffer.from(f.base64 || "", "base64"));
    if (ext === ".zip") {
      const unzipped = unzipSync(bytes);
      for (const [relKey, fileBytes] of Object.entries(unzipped)) {
        if (relKey.endsWith("/") || relKey.includes("__MACOSX")) continue;
        const innerExt = extname(relKey).toLowerCase();
        if (!AUDIO_EXTS.has(innerExt)) continue;
        const safeRel = relKey.split("/").filter((p) => p && p !== "..").join(sep);
        const dst = join(targetDir, safeRel);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, fileBytes);
      }
    } else if (AUDIO_EXTS.has(ext)) {
      const safeName = basename(f.name).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, "_");
      writeFileSync(join(targetDir, safeName), bytes);
    }
  }

  const entries = await indexLibraryFolder(libId, targetDir);
  if (!entries.length) {
    rmSync(targetDir, { recursive: true, force: true });
    throw new Error("导入的文件中未发现有效的 .ogg / .wav / .mp3 音频");
  }

  const idx = readRefsIndex();
  idx.sounds = [...idx.sounds.filter((s) => s.libId !== libId), ...entries];
  writeRefsIndex(idx);

  cfg.libraries.push({
    id: libId,
    name: displayName,
    sourceType: "upload",
    dirPath: `workspace/sfx-refs/${libId}`,
    enabled: true,
    count: entries.length,
    addedAt: new Date().toISOString(),
  });
  cfg.enabled = true;
  writeSfxRefsConfig(cfg);
  return getSfxRefsStatus();
}

export function toggleRefLibrary({ id, enabled }) {
  const cfg = readSfxRefsConfig();
  const hit = cfg.libraries.find((l) => l.id === id);
  if (!hit) throw new Error(`未找到参考库: ${id}`);
  hit.enabled = Boolean(enabled);
  writeSfxRefsConfig(cfg);
  return getSfxRefsStatus();
}

export async function rescanRefLibrary(id) {
  const cfg = readSfxRefsConfig();
  const hit = cfg.libraries.find((l) => l.id === id);
  if (!hit) throw new Error(`未找到参考库: ${id}`);
  const rootDir = hit.sourceType === "upload" ? join(REPO_ROOT, hit.dirPath) : hit.dirPath;
  const entries = await indexLibraryFolder(hit.id, rootDir);
  hit.count = entries.length;
  writeSfxRefsConfig(cfg);

  const idx = readRefsIndex();
  idx.sounds = [...idx.sounds.filter((s) => s.libId !== hit.id), ...entries];
  writeRefsIndex(idx);
  for (const k of [..._sampleCache.keys()]) {
    if (k.startsWith(`${hit.id}/`)) _sampleCache.delete(k);
  }
  return getSfxRefsStatus();
}

export function removeRefLibrary(id) {
  const cfg = readSfxRefsConfig();
  const hit = cfg.libraries.find((l) => l.id === id);
  if (!hit) throw new Error(`未找到参考库: ${id}`);
  if (hit.sourceType === "upload") {
    const uploadDir = join(WS_REFS_UPLOAD_DIR, hit.id);
    if (existsSync(uploadDir)) rmSync(uploadDir, { recursive: true, force: true });
  }
  cfg.libraries = cfg.libraries.filter((l) => l.id !== id);
  writeSfxRefsConfig(cfg);

  const idx = readRefsIndex();
  idx.sounds = idx.sounds.filter((s) => s.libId !== id);
  writeRefsIndex(idx);
  for (const k of [..._sampleCache.keys()]) {
    if (k.startsWith(`${id}/`)) _sampleCache.delete(k);
  }
  return getSfxRefsStatus();
}

/** 检索当前已启用的用户音效参考库（若全局未启用参考库则返回空数组）。 */
export function searchRefs(query = "", { libId = null, limit = 24, ignoreGlobalSwitch = false } = {}) {
  const cfg = readSfxRefsConfig();
  if (!ignoreGlobalSwitch && !cfg.enabled) return [];
  const enabledLibs = new Set(cfg.libraries.filter((l) => l.enabled !== false).map((l) => l.id));
  if (!enabledLibs.size) return [];

  const sounds = readRefsIndex().sounds.filter((s) => enabledLibs.has(s.libId) && (!libId || s.libId === libId));
  const tokens = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return sounds.slice(0, limit);

  const scored = [];
  for (const item of sounds) {
    const hay = item.id.toLowerCase();
    const tagSet = new Set(item.tags || []);
    let score = 0;
    for (const tok of tokens) {
      if (tagSet.has(tok)) score += 3;
      else if (hay.includes(tok)) score += 2;
      else if ([...tagSet].some((tg) => tg.includes(tok))) score += 1;
    }
    if (score > 0) scored.push([score, item]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].id.localeCompare(b[1].id));
  return scored.slice(0, limit).map((x) => x[1]);
}

/** 只读读取已启用音效参考库中的单条音频（返回独立 Float64Array 副本）。 */
export async function refSample(refId) {
  const cleanId = String(refId || "").trim().replace(/\\/g, "/");
  if (!_sampleCache.has(cleanId)) {
    const hit = readRefsIndex().sounds.find((s) => s.id === cleanId);
    if (!hit || !existsSync(hit.absPath)) {
      const hints = searchRefs(cleanId.replace(/\//g, " "), { limit: 5, ignoreGlobalSwitch: true }).map((x) => x.id);
      throw new Error(
        `参考库中未找到音频 '${cleanId}'。` +
          (hints.length ? ` 相近参考 ID: ${JSON.stringify(hints)}` : " 请确认该参考库已添加并启用。"),
      );
    }
    const dec = await decodeAudioFile(hit.absPath);
    if (!dec) throw new Error(`无法解码参考音频: ${cleanId}`);
    const mono = dec.sampleRate === RATE ? dec.mono : resample(dec.mono, dec.sampleRate, RATE);
    _sampleCache.set(cleanId, mono);
  }
  _usedRefIds.add(cleanId);
  return Float64Array.from(_sampleCache.get(cleanId));
}

/** 从已启用音效参考库截取片段 -> 可选移调 -> 分频段提取 -> 微淡入淡出并按 50ms RMS 归一。 */
export async function refLayer(
  refId,
  begin = 0,
  end = null,
  { low = null, high = null, semitones = 0, attack = 0.0008, release = 0.028 } = {},
) {
  const src = await refSample(refId);
  const i0 = Math.max(0, Math.min(src.length - 1, Math.round(begin * RATE)));
  const i1 = end == null ? src.length : Math.max(i0 + 16, Math.min(src.length, Math.round(end * RATE)));
  let seg = src.slice(i0, i1);
  if (Math.abs(semitones) >= 0.02) seg = pitchShift(seg, semitones);
  if (low != null && high != null) seg = band(seg, low, high);
  else if (low != null) seg = highpass(seg, low);
  else if (high != null) seg = lowpass(seg, high);
  seg = edgeFade(seg, attack, release);
  const rms = windowRms(seg);
  for (let i = 0; i < seg.length; i++) seg[i] /= rms;
  return seg;
}

// 兼容别名
export const searchBank = searchRefs;
export const bankSample = refSample;
export const bankLayer = refLayer;

function waveformBars(samples, count = 56) {
  if (!samples.length) return new Array(count).fill(0);
  const peaks = new Array(count).fill(0);
  let maxPeak = 1e-6;
  for (let b = 0; b < count; b++) {
    const s0 = Math.floor((b * samples.length) / count);
    const s1 = Math.max(s0 + 1, Math.floor(((b + 1) * samples.length) / count));
    let pk = 0;
    for (let i = s0; i < s1 && i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > pk) pk = a;
    }
    peaks[b] = pk;
    if (pk > maxPeak) maxPeak = pk;
  }
  return peaks.map((p) => Math.round((p / maxPeak) * 1000) / 1000);
}

export async function encodeVorbisOgg(float32Mono, rate = RATE) {
  const enc = await createOggEncoder();
  enc.configure({ sampleRate: rate, channels: 1, vbrQuality: 5 });
  // 注意：enc.encode() 返回 WASM 线性内存视图，必须在调用 enc.finalize() 前立即拷贝
  const c1 = Uint8Array.from(enc.encode([float32Mono]));
  const c2 = Uint8Array.from(enc.finalize());
  const out = new Uint8Array(c1.length + c2.length);
  out.set(c1, 0);
  out.set(c2, c1.length);
  return out;
}

export async function compileEffectVariants(effectId, variants, outRoot = WS_SFX_DIR) {
  const fxDir = join(outRoot, effectId);
  mkdirSync(fxDir, { recursive: true });

  const validNames = new Set(Object.keys(variants).map((k) => `${k}.ogg`));
  for (const f of readdirSync(fxDir)) {
    if (f.endsWith(".ogg") && !validNames.has(f)) {
      try { unlinkSync(join(fxDir, f)); } catch {}
    }
  }

  const allRefs = new Set();
  const manifestItems = [];

  for (const [key, spec] of Object.entries(variants)) {
    let rawSamples;
    let variantRefs;
    if (typeof spec.samples === "function") {
      const prev = new Set(_usedRefIds);
      _usedRefIds.clear();
      rawSamples = await spec.samples();
      variantRefs = [..._usedRefIds].sort();
      for (const x of variantRefs) allRefs.add(x);
      for (const x of prev) _usedRefIds.add(x);
    } else {
      rawSamples = await spec.samples;
      variantRefs = Array.isArray(spec.refSamples) ? [...spec.refSamples] : [..._usedRefIds].sort();
      for (const x of variantRefs) allRefs.add(x);
    }

    const targetDb = Number(spec.targetDb ?? spec.target_db ?? -16.5);
    const texture = Number(spec.texture ?? 0.15);
    const pcm = finish(rawSamples, targetDb, texture);
    const oggBytes = await encodeVorbisOgg(pcm, RATE);
    writeFileSync(join(fxDir, `${key}.ogg`), oggBytes);

    let maxAbs = 1e-6;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > maxAbs) maxAbs = a;
    }
    const peakDb = Math.round(20 * Math.log10(maxAbs) * 10) / 10;
    const rmsDb = Math.round(20 * Math.log10(windowRms(pcm)) * 10) / 10;

    manifestItems.push({
      id: key,
      label: String(spec.label || key),
      desc: String(spec.desc || ""),
      file: `/workspace/sfx/${effectId}/${key}.ogg`,
      duration: Math.round((pcm.length / RATE) * 1000) / 1000,
      rate: RATE,
      peakDb,
      rmsDb,
      texture,
      cues: Array.isArray(spec.cues) ? spec.cues : [],
      refSamples: variantRefs,
      bars: waveformBars(pcm, 56),
    });
  }

  const manifest = {
    effectId,
    refSamples: [...allRefs].sort(),
    variants: manifestItems,
  };
  writeFileSync(join(fxDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

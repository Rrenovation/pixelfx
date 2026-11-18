// PixelFX 纯浏览器端无服务工作区与 AI/SFX 运行时 (供 GitHub Pages 等静态托管环境 100% 完整运行工作区、克隆、热改、自定义 Key 对话、Undo 回撤与纯 JS .ogg 配音合成)

import { unzipSync } from "fflate";
import { createOggEncoder } from "wasm-media-encoders";
import * as CoreExports from "../src/core/index.js";
import { effects as LIB_MODULES } from "../src/fx/index.js";

import * as lib_arcane from "../src/fx/arcane/_lib.js";
import * as lib_critters from "../src/fx/critters/_lib.js";
import * as lib_explosions from "../src/fx/explosions/_lib.js";
import * as lib_fire from "../src/fx/fire/_lib.js";
import * as lib_holy from "../src/fx/holy/_lib.js";
import * as lib_ice from "../src/fx/ice/_lib.js";
import * as lib_impacts from "../src/fx/impacts/_lib.js";
import * as lib_lightning from "../src/fx/lightning/_lib.js";
import * as lib_melee from "../src/fx/melee/_lib.js";
import * as lib_nature from "../src/fx/nature/_lib.js";
import * as lib_pickups from "../src/fx/pickups/_lib.js";
import * as lib_projectiles from "../src/fx/projectiles/_lib.js";
import * as lib_scifi from "../src/fx/scifi/_lib.js";
import * as lib_shadow from "../src/fx/shadow/_lib.js";
import * as lib_spawn from "../src/fx/spawn/_lib.js";
import * as lib_status from "../src/fx/status/_lib.js";
import * as lib_transitions from "../src/fx/transitions/_lib.js";
import * as lib_ui from "../src/fx/ui/_lib.js";
import * as lib_water from "../src/fx/water/_lib.js";
import * as lib_weather from "../src/fx/weather/_lib.js";

const CAT_LIBS = {
  arcane: lib_arcane,
  critters: lib_critters,
  explosions: lib_explosions,
  fire: lib_fire,
  holy: lib_holy,
  ice: lib_ice,
  impacts: lib_impacts,
  lightning: lib_lightning,
  melee: lib_melee,
  nature: lib_nature,
  pickups: lib_pickups,
  projectiles: lib_projectiles,
  scifi: lib_scifi,
  shadow: lib_shadow,
  spawn: lib_spawn,
  status: lib_status,
  transitions: lib_transitions,
  ui: lib_ui,
  water: lib_water,
  weather: lib_weather,
};

// ============================================================================
// 1. 纯浏览器版 sfx-core (22050Hz DSP 合成原语 + WASM Ogg Vorbis 编码 + 可选参考库)
// ============================================================================
const RATE = 22050;
const PEAK_LIMIT = Math.pow(10, -1.05 / 20);
const _usedRefIds = new Set();
const _refPcmCache = new Map(); // refId -> Float64Array (22050Hz mono)

function sfxRng(seed = 1) {
  let s = (Number(seed) >>> 0) || 0x6d2b79f5;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u = Math.max(1e-12, next());
    const v = next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    chance: (p = 0.5) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    normal,
    noise(len, amp = 1) {
      const out = new Float64Array(Math.max(0, Math.round(len)));
      for (let i = 0; i < out.length; i++) out[i] = normal() * amp;
      return out;
    },
  };
}

function biquadCoeffs(type, freqHz, q = Math.SQRT1_2) {
  const f = Math.max(12, Math.min(RATE * 0.485, freqHz));
  const w0 = (2 * Math.PI * f) / RATE;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lowpass") {
    b0 = (1 - cosW) / 2;
    b1 = 1 - cosW;
    b2 = (1 - cosW) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW;
    a2 = 1 - alpha;
  } else {
    b0 = (1 + cosW) / 2;
    b1 = -(1 + cosW);
    b2 = (1 + cosW) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW;
    a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function runBiquad(x, coeffs, reverse = false) {
  const [b0, b1, b2, a1, a2] = coeffs;
  const n = x.length;
  const y = new Float64Array(n);
  let z1 = 0, z2 = 0;
  if (!reverse) {
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      const yi = b0 * xi + z1;
      z1 = b1 * xi - a1 * yi + z2;
      z2 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      const xi = x[i];
      const yi = b0 * xi + z1;
      z1 = b1 * xi - a1 * yi + z2;
      z2 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
  }
  return y;
}

function zeroPhaseCascade(samples, sections) {
  const src = Float64Array.from(samples);
  if (src.length < 6) return src;
  let cur = src;
  for (const c of sections) cur = runBiquad(cur, c, false);
  for (const c of sections) cur = runBiquad(cur, c, true);
  return cur;
}

function lowpass(samples, cutoff) {
  return zeroPhaseCascade(samples, [biquadCoeffs("lowpass", cutoff, 0.5411961), biquadCoeffs("lowpass", cutoff, 1.306563)]);
}

function highpass(samples, cutoff) {
  return zeroPhaseCascade(samples, [biquadCoeffs("highpass", cutoff, 0.5411961), biquadCoeffs("highpass", cutoff, 1.306563)]);
}

function band(samples, low, high) {
  const lo = Math.max(15, low);
  const hi = Math.min(RATE * 0.48, Math.max(lo + 20, high));
  return lowpass(highpass(samples, lo), hi);
}

function resample(samples, srcRate, dstRate) {
  if (srcRate === dstRate || samples.length < 2) return Float64Array.from(samples);
  const ratio = srcRate / dstRate;
  let pre = samples;
  if (ratio > 1.04) {
    const nyq = 0.46 * dstRate;
    const c = (() => {
      const w0 = (2 * Math.PI * Math.min(srcRate * 0.48, nyq)) / srcRate;
      const cw = Math.cos(w0), sw = Math.sin(w0), al = sw / Math.SQRT2;
      const a0 = 1 + al;
      return [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0];
    })();
    pre = runBiquad(runBiquad(samples, c, false), c, true);
  }
  const outLen = Math.max(2, Math.round(pre.length / ratio));
  const out = new Float64Array(outLen);
  const maxIdx = pre.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const p0 = pre[Math.max(0, idx - 1)];
    const p1 = pre[Math.min(maxIdx, idx)];
    const p2 = pre[Math.min(maxIdx, idx + 1)];
    const p3 = pre[Math.min(maxIdx, idx + 2)];
    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    out[i] = ((a * frac + b) * frac + c) * frac + p1;
  }
  return out;
}

function pitchShift(samples, semitones) {
  if (Math.abs(semitones) < 0.02) return Float64Array.from(samples);
  const factor = Math.pow(2.0, semitones / 12.0);
  return resample(samples, Math.round(RATE * factor), RATE);
}

function resonate(excitation, modes, decay = 0.12) {
  const n = excitation.length;
  const out = new Float64Array(n);
  for (const [freq, q, gain] of modes) {
    if (freq >= RATE * 0.47 || freq < 16) continue;
    const w0 = (2 * Math.PI * freq) / RATE;
    const bw = w0 / Math.max(0.5, q);
    const gb = Math.SQRT1_2;
    const beta = Math.sqrt(1 - gb * gb) / gb * Math.tan(bw / 2);
    const kGain = 1 / (1 + beta);
    const b0 = 1 - kGain, b2 = -(1 - kGain);
    const a1 = -2 * kGain * Math.cos(w0), a2 = 2 * kGain - 1;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const x0 = excitation[i];
      const y0 = b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      out[i] += y0 * gain;
    }
  }
  if (decay > 0) {
    for (let i = 0; i < n; i++) out[i] *= Math.exp(-(i / RATE) / decay);
  }
  return out;
}

function edgeFade(samples, attack = 0.0007, release = 0.025) {
  const out = Float64Array.from(samples);
  const a = Math.min(Math.round(attack * RATE), Math.floor(out.length / 3));
  const r = Math.min(Math.round(release * RATE), Math.floor(out.length / 2));
  for (let i = 0; i < a; i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / (a + 1));
  for (let i = 0; i < r; i++) {
    const u = i / Math.max(1, r - 1);
    out[out.length - r + i] *= 0.5 + 0.5 * Math.cos(Math.PI * u);
  }
  return out;
}

function fit(samples, duration, release = 0.04) {
  const target = Math.round(duration * RATE);
  if (samples.length >= target) return edgeFade(samples.slice(0, target), 0.0007, release);
  const out = new Float64Array(target);
  out.set(edgeFade(samples, 0.0007, release), 0);
  return out;
}

function splice(samples, begin, end, overlap = 0.012) {
  const i0 = Math.max(0, Math.round(begin * RATE));
  const i1 = Math.min(samples.length, Math.round(end * RATE));
  const ov = Math.min(Math.round(overlap * RATE), i0, samples.length - i1);
  if (ov <= 4) {
    const out = new Float64Array(i0 + (samples.length - i1));
    out.set(samples.subarray(0, i0), 0);
    out.set(samples.subarray(i1), i0);
    return out;
  }
  const head = samples.subarray(0, i0 - ov);
  const tail = samples.subarray(i1 + ov);
  const out = new Float64Array(head.length + ov + tail.length);
  out.set(head, 0);
  for (let i = 0; i < ov; i++) {
    const fade = 0.5 + 0.5 * Math.cos((Math.PI * i) / Math.max(1, ov - 1));
    out[head.length + i] = samples[i0 - ov + i] * fade + samples[i1 + i] * (1 - fade);
  }
  out.set(tail, head.length + ov);
  return out;
}

function place(dest, fragment, offsetSeconds = 0, gain = 1.0) {
  const start = Math.max(0, Math.round(offsetSeconds * RATE));
  if (start >= dest.length) return dest;
  const end = Math.min(dest.length, start + fragment.length);
  for (let i = start; i < end; i++) dest[i] += fragment[i - start] * gain;
  return dest;
}

function windowRms(samples) {
  const n = samples.length;
  if (!n) return 1e-6;
  const win = Math.max(32, Math.min(n, Math.round(0.05 * RATE)));
  let sumSq = 0;
  for (let i = 0; i < win; i++) sumSq += samples[i] * samples[i];
  let maxMean = sumSq / win;
  for (let i = win; i < n; i++) {
    sumSq += samples[i] * samples[i] - samples[i - win] * samples[i - win];
    const m = sumSq / win;
    if (m > maxMean) maxMean = m;
  }
  let globalSq = 0;
  for (let i = 0; i < n; i++) globalSq += samples[i] * samples[i];
  return Math.max(Math.sqrt(Math.max(maxMean, 0)) * 0.72, Math.sqrt(globalSq / n), 1e-6);
}

function normLayer(samples, { low = null, high = null, attack = 0.0007, release = 0.025 } = {}) {
  let seg = Float64Array.from(samples);
  if (low != null && high != null) seg = band(seg, low, high);
  else if (low != null) seg = highpass(seg, low);
  else if (high != null) seg = lowpass(seg, high);
  seg = edgeFade(seg, attack, release);
  const rms = windowRms(seg);
  for (let i = 0; i < seg.length; i++) seg[i] /= rms;
  return seg;
}

function pixelTexture(samples, amount = 0.16) {
  if (amount <= 0) return Float64Array.from(samples);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return Float64Array.from(samples);
  const n = samples.length;
  const norm = new Float64Array(n);
  for (let i = 0; i < n; i++) norm[i] = samples[i] / peak;
  const detail = highpass(norm, 280);
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

function pixelTick(duration = 0.022, frequency = 440) {
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

function finish(samples, targetDb = -16.5, texture = 0.15) {
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

async function encodeVorbisOgg(float32Mono, rate = RATE) {
  const enc = await createOggEncoder();
  enc.configure({ sampleRate: rate, channels: 1, vbrQuality: 5 });
  const c1 = Uint8Array.from(enc.encode([float32Mono]));
  const c2 = Uint8Array.from(enc.finalize());
  const out = new Uint8Array(c1.length + c2.length);
  out.set(c1, 0);
  out.set(c2, c1.length);
  return out;
}

// ============================================================================
// 2. IndexedDB 浏览器持久化存储 (特效源码、配音 .ogg、历史快照、Undo 栈、参考音频包)
// ============================================================================
const DB_NAME = "pixelfx_browser_studio_v1";
const DB_VERSION = 1;
let _dbPromise = null;

function openStudioDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function idbGet(storeName, key, fallback = null) {
  try {
    const db = await openStudioDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result !== undefined ? req.result : fallback);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return fallback;
  }
}

async function idbSet(storeName, key, value) {
  const db = await openStudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(storeName, key) {
  const db = await openStudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================================
// 3. 浏览器端音频解码与动态音效参考库 (支持导入 ZIP / OGG / WAV / MP3)
// ============================================================================
let _decodeCtx = null;
async function decodeAudioBytesInBrowser(bytes) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext || window.AudioContext || window.webkitAudioContext;
  if (!_decodeCtx && (window.AudioContext || window.webkitAudioContext)) {
    const AC = window.AudioContext || window.webkitAudioContext;
    _decodeCtx = new AC();
  }
  const ctx = _decodeCtx || (Ctx ? new Ctx(1, 22050, 22050) : null);
  if (!ctx) return null;
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const audioBuf = await ctx.decodeAudioData(copy);
  const len = audioBuf.length;
  const mono = new Float64Array(len);
  const chs = audioBuf.numberOfChannels;
  for (let c = 0; c < chs; c++) {
    const ch = audioBuf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += ch[i] / chs;
  }
  return { mono, sampleRate: audioBuf.sampleRate };
}

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

async function readBrowserRefsCfg() {
  return (await idbGet("kv", "sfx_refs_cfg")) || { enabled: false, libraries: [], sounds: [] };
}

async function writeBrowserRefsCfg(cfg) {
  await idbSet("kv", "sfx_refs_cfg", cfg);
  return cfg;
}

async function getBrowserRefsStatus() {
  const cfg = await readBrowserRefsCfg();
  const enabledLibs = new Set((cfg.libraries || []).filter((l) => l.enabled !== false).map((l) => l.id));
  const sounds = cfg.sounds || [];
  const activeSoundCount = cfg.enabled ? sounds.filter((s) => enabledLibs.has(s.libId)).length : 0;
  return {
    enabled: Boolean(cfg.enabled),
    active: Boolean(cfg.enabled && activeSoundCount > 0),
    activeLibraryCount: cfg.enabled ? enabledLibs.size : 0,
    activeSoundCount,
    totalSoundCount: sounds.length,
    libraries: cfg.libraries || [],
  };
}

async function searchBrowserRefs(query = "", { libId = null, limit = 24 } = {}) {
  const cfg = await readBrowserRefsCfg();
  if (!cfg.enabled) return [];
  const enabledLibs = new Set((cfg.libraries || []).filter((l) => l.enabled !== false).map((l) => l.id));
  if (!enabledLibs.size) return [];
  const sounds = (cfg.sounds || []).filter((s) => enabledLibs.has(s.libId) && (!libId || s.libId === libId));
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

async function refSample(refId) {
  const cleanId = String(refId || "").trim().replace(/\\/g, "/");
  if (!_refPcmCache.has(cleanId)) {
    const bytes = await idbGet("blobs", `ref::${cleanId}`);
    if (!bytes) throw new Error(`浏览器参考库中未找到音频 '${cleanId}'，请确认已导入并启用该参考库。`);
    const dec = await decodeAudioBytesInBrowser(bytes);
    if (!dec) throw new Error(`无法解码参考音频: ${cleanId}`);
    const mono = dec.sampleRate === RATE ? dec.mono : resample(dec.mono, dec.sampleRate, RATE);
    _refPcmCache.set(cleanId, mono);
  }
  _usedRefIds.add(cleanId);
  return Float64Array.from(_refPcmCache.get(cleanId));
}

async function refLayer(refId, begin = 0, end = null, { low = null, high = null, semitones = 0, attack = 0.0008, release = 0.028 } = {}) {
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

let _activeCompilingFxId = null;
async function compileEffectVariants(effectId, variants) {
  const targetId = effectId || _activeCompilingFxId;
  if (!targetId) throw new Error("compileEffectVariants 缺少 effectId");

  const prevManifest = (await idbGet("kv", `sfx_manifest::${targetId}`)) || { variants: [] };
  for (const oldV of prevManifest.variants || []) {
    if (!variants[oldV.id]) {
      await idbDel("blobs", `sfx_ogg::${targetId}::${oldV.id}`);
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
    await idbSet("blobs", `sfx_ogg::${targetId}::${key}`, oggBytes);

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
      file: `/workspace/sfx/${targetId}/${key}.ogg`,
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
    effectId: targetId,
    refSamples: [...allRefs].sort(),
    variants: manifestItems,
  };
  await idbSet("kv", `sfx_manifest::${targetId}`, manifest);
  return manifest;
}

const BrowserSfxCore = {
  RATE,
  sfxRng,
  lowpass,
  highpass,
  band,
  resample,
  pitchShift,
  resonate,
  edgeFade,
  fit,
  splice,
  place,
  windowRms,
  normLayer,
  pixelTexture,
  pixelTick,
  finish,
  encodeVorbisOgg,
  searchRefs: searchBrowserRefs,
  refSample,
  refLayer,
  searchBank: searchBrowserRefs,
  bankSample: refSample,
  bankLayer: refLayer,
  compileEffectVariants,
};

// ============================================================================
// 4. 浏览器动态 ES Module 编译器 (将 import 重写至已打包的全局运行时并通过 Blob URL 加载)
// ============================================================================
globalThis.__PIXELFX_CORE__ = CoreExports;
globalThis.__PIXELFX_EFFECTS__ = LIB_MODULES;
globalThis.__PIXELFX_CAT_LIBS__ = CAT_LIBS;
globalThis.__PIXELFX_SFX_CORE__ = BrowserSfxCore;
globalThis.__PIXELFX_WS_MODS__ = {};

function resolveRelativeEffectId(curCat, spec) {
  const clean = spec.replace(/\.js$/, "");
  if (clean.startsWith("../")) {
    const rest = clean.slice(3);
    if (rest.includes("/")) return rest;
  } else if (clean.startsWith("./")) {
    return `${curCat}/${clean.slice(2)}`;
  }
  return clean;
}

function buildImportReplacement(clause, targetExpr) {
  const trimmed = clause.trim();
  if (trimmed.startsWith("*")) {
    const ns = trimmed.replace(/^\*\s+as\s+/, "").trim();
    return `const ${ns} = ${targetExpr};`;
  }
  if (trimmed.startsWith("{")) {
    const body = trimmed.slice(1, trimmed.lastIndexOf("}")).replace(/\bas\b/g, ":");
    return `const {${body}} = ${targetExpr};`;
  }
  if (trimmed.includes("{")) {
    const braceIdx = trimmed.indexOf("{");
    const defName = trimmed.slice(0, braceIdx).replace(/,$/, "").trim();
    const body = trimmed.slice(braceIdx + 1, trimmed.lastIndexOf("}")).replace(/\bas\b/g, ":");
    return `const ${defName} = (${targetExpr}).default ?? (${targetExpr}); const {${body}} = ${targetExpr};`;
  }
  return `const ${trimmed} = (${targetExpr}).default ?? (${targetExpr});`;
}

export function rewriteBrowserModuleImports(code, id) {
  const curCat = (id || "arcane/fx").split("/")[0];
  return String(code || "").replace(
    /\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/g,
    (_full, clause, spec) => {
      if (spec.includes("sfx-core")) {
        return buildImportReplacement(clause, "globalThis.__PIXELFX_SFX_CORE__");
      }
      if (spec.includes("core/index") || spec === "pixelfx" || spec.endsWith("/core")) {
        return buildImportReplacement(clause, "globalThis.__PIXELFX_CORE__");
      }
      if (spec === "./_lib.js" || spec === "./_lib") {
        return buildImportReplacement(clause, `(globalThis.__PIXELFX_CAT_LIBS__[${JSON.stringify(curCat)}] || {})`);
      }
      const relId = resolveRelativeEffectId(curCat, spec);
      return buildImportReplacement(
        clause,
        `(globalThis.__PIXELFX_WS_MODS__[${JSON.stringify(relId)}] || globalThis.__PIXELFX_EFFECTS__[${JSON.stringify(relId)}] || {})`,
      );
    },
  );
}

const _activeBlobUrls = new Map();
async function loadBrowserFxModule(id, code) {
  const prevUrl = _activeBlobUrls.get(id);
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  const transformed = `${rewriteBrowserModuleImports(code, id)}\n//# sourceURL=browser-ws-fx/${id}.js`;
  const blobUrl = URL.createObjectURL(new Blob([transformed], { type: "text/javascript" }));
  _activeBlobUrls.set(id, blobUrl);
  const mod = await import(blobUrl);
  const meta = {
    fps: 30,
    bg: "dark",
    loop: false,
    duration: 1,
    tags: [],
    size: [128, 128],
    origin: [64, 96],
    options: {},
    ...mod.meta,
  };
  const wrapped = { ...mod, meta };
  globalThis.__PIXELFX_WS_MODS__[id] = wrapped;
  return { id, moduleUrl: blobUrl, mod: wrapped, meta };
}

async function runBrowserSfxScript(id, code) {
  _activeCompilingFxId = id;
  const transformed = `${rewriteBrowserModuleImports(code, id)}\n//# sourceURL=browser-ws-sfx/${id}.js`;
  const blobUrl = URL.createObjectURL(new Blob([transformed], { type: "text/javascript" }));
  try {
    await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
    _activeCompilingFxId = null;
  }
}

// ============================================================================
// 5. 浏览器端工作区状态、像素规范诊断 (Check) 与初始模板
// ============================================================================
async function readBrowserWsStore() {
  return (await idbGet("kv", "ws_store")) || { effects: {} };
}

async function writeBrowserWsStore(store) {
  await idbSet("kv", "ws_store", store);
  return store;
}

async function fetchBuiltinEffectSource(id) {
  const paths = [`./src/fx/${id}.js`, `../src/fx/${id}.js`];
  for (const p of paths) {
    try {
      const r = await rawFetch(p);
      if (r.ok) {
        const txt = await r.text();
        if (!txt.trim().startsWith("<")) return txt;
      }
    } catch {}
  }
  throw new Error(`无法读取内置特效源码: ${id}`);
}

function buildStarterCode(id, { zhName, zhDesc, loop = false }) {
  const cat = id.split("/")[0];
  const engName = id.split("/")[1].replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (loop) {
    return `import { PAL, fit, at, cycle, TAU, WHITE } from "../../core/index.js";

export const meta = {
  name: ${JSON.stringify(engName)},
  desc: ${JSON.stringify(zhDesc || `${zhName || engName}：循环像素能量特效。`)},
  tags: [${JSON.stringify(cat)}, "loop", "custom"],
  size: [128, 128],
  origin: [64, 88],
  duration: 1.6,
  loop: true,
  fps: 24,
  bg: "dark",
  options: { palette: PAL.arcane, radius: 22, count: 18, seed: 7 },
};

export function draw(p, t, o) {
  const C = fit(o.palette, 8);
  const ph = t / meta.duration;
  const rad0 = o.radius ?? 22;
  const pulse = 1 + 0.14 * Math.sin(ph * TAU * 2);
  p.ellipse(0, 0, rad0 * pulse, rad0 * 0.28 * pulse, (d) => (d > 0.78 ? C[5] : d > 0.55 ? C[2] : 0));
  cycle(t, meta.duration, o.count ?? 18, o.seed, 0.85, (age, life, r) => {
    const k = age / life;
    const a = r.range(0, TAU) + k * 2.6;
    const rr = rad0 * (0.95 - 0.55 * k);
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr * 0.28 - k * 42;
    p.circle(x, y, (1 - k) * 1.8 + 0.6, k < 0.25 ? WHITE : at(C.slice(2), 1 - k));
    p.glow(x, y, 5, C[5], 0.25 * (1 - k));
  });
  p.circle(0, -18 + Math.sin(ph * TAU) * 2, 5.5 * pulse, C[5]);
  p.circle(-1, -19 + Math.sin(ph * TAU) * 2, 3 * pulse, WHITE);
  p.glow(0, -18, 32 * pulse, C[4], 0.42);
}
`;
  }
  return `import { Particles, Lights, P, Rng, PAL, fit, smooth, sparkle, WHITE, TAU } from "../../core/index.js";

export const meta = {
  name: ${JSON.stringify(engName)},
  desc: ${JSON.stringify(zhDesc || `${zhName || engName}：爆发像素打击特效。`)},
  tags: [${JSON.stringify(cat)}, "one-shot", "custom"],
  size: [128, 128],
  origin: [64, 92],
  duration: 1.0,
  loop: false,
  fps: 24,
  bg: "ground",
  options: { palette: PAL.water, power: 1, count: 32, seed: 12 },
};

export function create(o) {
  const C = fit(o.palette, 8);
  const R = new Rng(o.seed);
  const kPow = o.power ?? 1;
  const ps = new Particles({ rng: R, ground: () => 0 });
  const lights = new Lights();
  lights.add(0, -16, 48 * kPow, C[5], 0.8, 0.45);
  const n = Math.round((o.count ?? 32) * kPow);
  for (let i = 0; i < n; i++) {
    const a = R.range(0, TAU);
    const sp = R.range(55, 195) * kPow;
    ps.spawn(i % 5 === 0 ? P.STAR : P.SPARK, 0, -14, Math.cos(a) * sp, Math.sin(a) * sp - 55, R.range(0.24, 0.68), i % 4 === 0 ? WHITE : C[5], R.range(1, 2.2));
  }
  let t = 0;
  return {
    update(dt) { t += dt; ps.update(dt); lights.update(dt); },
    draw(p) {
      if (t >= meta.duration - 0.01) return;
      const fade = 1 - smooth(meta.duration - 0.18, meta.duration, t);
      if (t < 0.14) {
        const u = t / 0.14;
        p.circle(0, -14, 11 * (1 - u * 0.5) * kPow, u < 0.4 ? WHITE : C[6]);
        sparkle(p, 0, -14, 18 * (1 - u) * kPow, WHITE, C[5]);
      }
      if (t < 0.42) {
        const u = t / 0.42;
        const rx = (6 + 34 * u) * kPow;
        p.ellipse(0, 0, rx, rx * 0.24, (d) => (d > 0.82 ? C[6] : 0), (1 - u) * fade);
      }
      ps.draw(p);
      lights.draw(p);
    },
  };
}
`;
}

async function saveBrowserHistorySnapshot(id, code, tag = "edit") {
  const key = `history::${id}`;
  const list = (await idbGet("kv", key)) || [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  list.push({ file: `${stamp}_${tag}.js`, mtimeMs: Date.now(), size: code.length, code });
  while (list.length > 20) list.shift();
  await idbSet("kv", key, list);
}

async function getBrowserSfxInfo(id) {
  const sfxCode = await idbGet("kv", `sfx_code::${id}`);
  const manifest = (await idbGet("kv", `sfx_manifest::${id}`)) || { variants: [] };
  const store = await readBrowserWsStore();
  const variants = Array.isArray(manifest.variants) ? manifest.variants : [];
  const preferred = store.effects[id]?.activeSfxVariant || null;
  const activeVariant = variants.find((v) => v.id === preferred)?.id || variants[0]?.id || null;
  return {
    ok: true,
    id,
    hasScript: Boolean(sfxCode),
    scriptPath: sfxCode ? `workspace/sfx/${id}.js` : `workspace/sfx/${id}.js (待生成)`,
    activeVariant,
    variants,
  };
}

async function checkBrowserEffect(id, code) {
  const errors = [];
  const warnings = [];
  const stats = { maxPixels: 0, spillPixels: 0, medianMs: 0, bounds: null };

  if (typeof code !== "string") {
    return { ok: false, errors: [`未找到特效源码: ${id}`], warnings, stats };
  }
  if (/\bMath\.random\s*\(/.test(code)) {
    errors.push("禁止使用 Math.random()，请改用 new Rng(o.seed) 或 rand() 以保证每帧确定性复现");
  }
  if (/\bDate\.now\s*\(|\bnew\s+Date\s*\(/.test(code)) {
    warnings.push("检测到 Date 时间调用，特效渲染应完全仅依赖传入的时间参数 t 与 dt");
  }

  try {
    const loaded = await loadBrowserFxModule(id, code);
    const { mod, meta } = loaded;
    const { createFrame, clearFrame, painterFor, createFx, createAct, stockActor, BACKDROPS } = CoreExports;

    if (!mod.meta) errors.push("缺少 export const meta 元数据导出");
    if (!mod.draw && !mod.create) errors.push("缺少 export function draw(p, t, o) 或 export function create(o)");
    if (!Array.isArray(meta.size) || meta.size.some((v) => !Number.isInteger(v) || v < 8 || v > 640)) {
      errors.push("meta.size 必须是 [宽, 高] 整数像素数组（范围 8..640）");
    }
    if (!Array.isArray(meta.origin) || meta.origin.length !== 2) {
      errors.push("meta.origin 必须是 [ox, oy] 锚点坐标");
    }
    if (!(meta.duration > 0 && meta.duration <= 20)) {
      errors.push("meta.duration 时长需在 0..20 秒之间");
    }
    if (meta.bg && BACKDROPS && !BACKDROPS.includes(meta.bg)) {
      warnings.push(`meta.bg ("${meta.bg}") 建议使用标准值`);
    }
    if (errors.length) return { ok: false, errors, warnings, stats };

    const M = 24;
    const [W, H] = meta.size;
    const fw = W + M * 2, fh = H + M * 2;
    const frame = createFrame(fw, fh, -M, -M);
    const n = Math.max(2, Math.min(180, Math.round(meta.duration * meta.fps)));
    const opts = { ...(meta.options ?? {}), seed: meta.options?.seed ?? 1 };
    if (meta.actor) opts.actor = stockActor(meta.actor === 2 ? 2 : 1);

    let maxPx = 0, spill = 0;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const times = [];

    const inspectFrame = () => {
      let inCount = 0, outCount = 0;
      for (let j = 0; j < frame.color.length; j++) {
        const c = frame.color[j];
        const l = frame.light[j] & 0xffffff;
        if (!(c >>> 24) && !l) continue;
        const x = (j % fw) - M;
        const y = ((j / fw) | 0) - M;
        const inside = x >= 0 && y >= 0 && x < W && y < H;
        if (c >>> 24) {
          bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
          by0 = Math.min(by0, y); by1 = Math.max(by1, y);
        }
        if (inside) inCount++;
        else if (c >>> 24) outCount++;
      }
      maxPx = Math.max(maxPx, inCount);
      spill = Math.max(spill, outCount);
      return inCount;
    };

    let lastFramePixels = 0;
    if (!mod.create) {
      for (let i = 0; i <= n; i++) {
        const t = meta.loop ? ((i % n) / n) * meta.duration : (i / n) * meta.duration;
        clearFrame(frame);
        const p = painterFor(frame);
        p.place(meta.origin[0], meta.origin[1]);
        const t0 = performance.now();
        if (mod.drawBack) mod.drawBack(p, t, opts);
        mod.draw(p, t, opts);
        times.push(performance.now() - t0);
        lastFramePixels = inspectFrame();
      }
    } else {
      const inst = createFx(mod, { x: meta.origin[0], y: meta.origin[1], ...opts });
      for (let i = 0; i <= n; i++) {
        if (i > 0) inst.update(meta.duration / n);
        clearFrame(frame);
        const t0 = performance.now();
        inst.draw(frame);
        times.push(performance.now() - t0);
        lastFramePixels = inspectFrame();
      }
    }

    if (mod.act) {
      const actInst = createAct(mod, { x: 120, y: 120 });
      const af = createFrame(320, 240);
      for (let i = 0; i < 450 && !actInst.done(); i++) {
        actInst.update(1 / 30);
        if (i % 6 === 0) actInst.draw(clearFrame(af));
      }
    }

    times.sort((a, b) => a - b);
    stats.maxPixels = maxPx;
    stats.spillPixels = spill;
    stats.medianMs = +(times[times.length >> 1] || 0).toFixed(2);
    if (bx0 <= bx1) stats.bounds = [bx0, by0, bx1, by1];

    if (maxPx === 0) errors.push("全程未绘制任何可见像素，请检查坐标与锚点 (0, 0)");
    if (spill > 8) warnings.push(`有 ${spill} 个像素超出 ${W}×${H} 画布边界`);
    if (!meta.loop && lastFramePixels > 4) warnings.push(`一次性特效在结束帧仍有 ${lastFramePixels} 个残留像素`);
  } catch (e) {
    errors.push(`运行时错误: ${String(e.message || e).split("\n")[0]}`);
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}

async function listBrowserWorkspaceEffects() {
  const store = await readBrowserWsStore();
  const ids = Object.keys(store.effects || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const items = [];
  for (const id of ids) {
    const entry = store.effects[id];
    try {
      const loaded = await loadBrowserFxModule(id, entry.code);
      const sfxInfo = await getBrowserSfxInfo(id);
      items.push({
        id,
        cat: id.split("/")[0],
        mtimeMs: entry.mtimeMs || Date.now(),
        moduleUrl: loaded.moduleUrl,
        meta: loaded.meta,
        hasAct: !!loaded.mod.act,
        zhName: entry.zhName || loaded.meta.name || id.split("/")[1],
        zhDesc: entry.zhDesc || loaded.meta.desc || "",
        baseId: entry.baseId || null,
        preset: entry.preset || null,
        activeSfxVariant: sfxInfo.activeVariant,
        sfxVariantCount: sfxInfo.variants.length,
        hasSfxScript: sfxInfo.hasScript,
        updatedAt: entry.updatedAt || new Date().toISOString(),
        broken: false,
        error: null,
      });
    } catch (e) {
      items.push({
        id,
        cat: id.split("/")[0],
        mtimeMs: entry.mtimeMs || Date.now(),
        meta: {
          name: entry.zhName || id.split("/")[1],
          desc: String(e.message || e),
          size: [128, 128],
          origin: [64, 96],
          duration: 1,
          loop: false,
          fps: 30,
          bg: "dark",
          tags: ["error"],
          options: {},
        },
        hasAct: false,
        zhName: entry.zhName || id.split("/")[1],
        zhDesc: entry.zhDesc || "代码存在语法或运行时错误，请在源码编辑器中修复。",
        baseId: entry.baseId || null,
        preset: entry.preset || null,
        updatedAt: entry.updatedAt || new Date().toISOString(),
        broken: true,
        error: String(e.message || e),
      });
    }
  }
  return items;
}

function uniqueBrowserId(store, desiredId) {
  let [cat, name] = String(desiredId || "arcane/custom-fx").toLowerCase().split("/");
  cat = (cat || "arcane").replace(/[^a-z0-9-]/g, "");
  name = (name || "custom-fx").replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "custom-fx";
  let candidate = `${cat}/${name}`;
  let idx = 2;
  while (store.effects[candidate]) {
    candidate = `${cat}/${name}-v${idx++}`;
  }
  return candidate;
}

// ============================================================================
// 6. 浏览器端自定义密钥脱敏存储、大模型直连调用与原子级 Undo 检查点栈
// ============================================================================
const BROWSER_AGENT_CFG_KEY = "pixelfx_browser_agent_cfg_v1";

function obfEncode(str) {
  const txt = String(str || "");
  if (!txt) return "";
  const bytes = new TextEncoder().encode(txt);
  const salt = 0x5a;
  const xored = Array.from(bytes, (b, i) => b ^ ((salt + i * 17) & 0xff));
  return "obf1:" + btoa(String.fromCharCode(...xored));
}

function obfDecode(stored) {
  const s = String(stored || "");
  if (!s) return "";
  if (!s.startsWith("obf1:")) return s;
  try {
    const raw = atob(s.slice(5));
    const salt = 0x5a;
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) ^ ((salt + i * 17) & 0xff);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function maskSecretKey(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  if (k.length <= 8) return "••••••••";
  return `${k.slice(0, 3)}••••••••${k.slice(-2)}`;
}

function maskEndpointUrl(urlStr) {
  const u = String(urlStr || "").trim();
  if (!u) return "";
  try {
    const parsed = new URL(u);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    if (/^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(parsed.hostname)) {
      const portPart = parsed.port ? `:${parsed.port}` : "";
      return `${parsed.protocol}//***.***.***.***${portPart}${parsed.pathname.replace(/\/+$/, "")}`;
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return u;
  }
}

function redactSensitiveText(text, cfg = {}) {
  let out = String(text || "");
  if (cfg.apiKey && cfg.apiKey.length >= 4) out = out.split(cfg.apiKey).join("[REDACTED_KEY]");
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{8,})\b/g, "[REDACTED_KEY]");
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED_KEY]");
  out = out.replace(/([?&]key=)[^&\s"']+/gi, "$1[REDACTED_KEY]");
  return out;
}

function getBrowserAgentConfig(includeSecret = false) {
  const defaults = {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKey: "",
  };
  let raw = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(BROWSER_AGENT_CFG_KEY) || "null");
    if (saved) {
      raw = {
        provider: saved.provider || defaults.provider,
        baseUrl: saved.baseUrl || defaults.baseUrl,
        model: saved.model || defaults.model,
        apiKey: obfDecode(saved.apiKeyObf || saved.apiKey || ""),
      };
    }
  } catch {}
  if (!includeSecret) {
    return {
      provider: raw.provider,
      baseUrl: maskEndpointUrl(raw.baseUrl),
      model: raw.model,
      hasKey: Boolean(raw.apiKey),
      keySource: raw.apiKey ? "browser" : "none",
      apiKeyMasked: maskSecretKey(raw.apiKey),
      apiKey: "",
    };
  }
  return raw;
}

function saveBrowserAgentConfig(partial = {}) {
  if (partial.clearKey) {
    localStorage.removeItem(BROWSER_AGENT_CFG_KEY);
    return getBrowserAgentConfig(false);
  }
  const prev = getBrowserAgentConfig(true);
  const incomingUrl = String(partial.baseUrl ?? "").trim().replace(/\/+$/, "");
  const keepPrevUrl = !incomingUrl || incomingUrl.includes("***");
  const incomingKey = String(partial.apiKey ?? "").trim();
  const keepPrevKey = !incomingKey || incomingKey.includes("••••") || incomingKey.includes("[REDACTED");
  const next = {
    provider: partial.provider || prev.provider,
    baseUrl: keepPrevUrl ? prev.baseUrl : incomingUrl,
    model: (partial.model ?? prev.model).trim() || prev.model,
    apiKeyObf: obfEncode(keepPrevKey ? prev.apiKey : incomingKey),
  };
  localStorage.setItem(BROWSER_AGENT_CFG_KEY, JSON.stringify(next));
  return getBrowserAgentConfig(false);
}

const PIXELFX_SYSTEM_PROMPT = `你是 PixelFX 像素艺术游戏特效与专属配音专家 Agent。整个工程统一采用纯 JavaScript (ES Module)。你不仅能通过参数调优或编写双缓冲像素视觉特效（color 像素层 + light 加法发光层），还能针对每个特效的动作节奏独立编写专属 JS 配音脚本（生成当前特效的多个音效变种 .ogg）。

## 一、像素视觉特效规则与 API (import from "../../core/index.js")
1. 坐标系：局部锚点 (0, 0) 为特效原点（脚底/命中点/发射口），x 向右，y 向下（地面为 y=0，向上喷射 y 为负数），单位 1px。
2. 严禁使用 Math.random() 或 Date！所有随机数必须用 \`new Rng(o.seed)\`（方法：\`R.next()\`, \`R.range(a,b)\`, \`R.int(a,b)\`, \`R.chance(p)\`, \`R.sign()\`）或确定性哈希 \`rand(i, seed)\`。
3. 颜色系统：使用 \`const C = fit(o.palette, 8)\` 将调色板采样为暗->亮的 32位颜色数组，最亮高光可用 \`WHITE\`。平滑时间过渡用 \`smooth(t0, t1, t)\`、\`clamp(x, a, b)\`、\`ease.outQuart(u)\`、\`ease.inQuad(u)\`、\`noise(x, seed)\`、\`noise2(x, y, seed)\`、\`TAU\`。
4. 两种特效模式：
   - **模拟型（爆发/打击/投射/法术）**：\`export function create(o)\` 返回 \`{ update(dt), draw(p), drawBack?(p) }\`。可用粒子与灯光：\`Particles\`, \`P\`, \`Lights\`, \`sparkle\`, \`flare\`, \`band\`, \`crystal\`。
   - **纯函数型（无缝循环光环/法阵/火焰/生物）**：\`export function draw(p, t, o)\`，仅依赖相位 \`ph = t / meta.duration\`，循环粒子用 \`cycle(t, meta.duration, count, o.seed, lifeRatio, (age, life, r) => { ... })\`。
5. Painter \`p\` 常用方法：\`p.px\`, \`p.dot\`, \`p.blend\`, \`p.disc\`, \`p.line\`, \`p.beam\`, \`p.circle\`, \`p.ellipse\`, \`p.ring\`, \`p.rect\`, \`p.poly\`, \`p.shade(x0, y0, x1, y1, (x, y, out) => { out.c = color; out.a = 1; })\`, \`p.glow\`, \`p.glowLine\`, \`p.light\`。
6. 一次性特效在 \`t >= meta.duration\` 时必须清空不留残影；可选导出 \`export const act = { target: { x: 58 }, poses: [...], hits: [{ t, stop, shake, amp, push, straw, skin }] }\`。

## 二、专属特效配音与多变种生成规则 (action: "write_sfx")
每个特效拥有自己独立的 ES Module 配音脚本 \`workspace/sfx/<category>/<name>.js\`，一特效一音效集，下拉框为当前特效的各音效变种！
1. 若上下文提示「音效参考库状态: 已启用」，可通过 \`await refLayer(refId, begin, end, { low, high, semitones })\` 分层混音并结合 AI 合成；若提示「未启用」，严禁调用 \`refLayer\`/\`refSample\`，请完全使用 \`sfx-core\` 原语（\`sfxRng\`, \`band\`, \`lowpass\`, \`highpass\`, \`resonate\`, \`pixelTick\`, \`edgeFade\`, \`fit\`, \`place\`）独立程序化合成。
2. 从 \`../../sfx-core/index.js\` 导入原语，顶层调用 \`await compileEffectVariants("category/name", { default: { label, desc, samples: buildDefault, targetDb: -16.5, texture: 0.15, cues: [...] }, ... })\` 编译至少 3 个变种。

## 三、输出格式要求（严格只输出一个合法 JSON 对象）
{
  "action": "tune" | "edit_code" | "create_code" | "write_sfx",
  "targetId": "category/kebab-name",
  "zhName": "特效中文名（可选）",
  "zhDesc": "一句生动的中文视觉表现描述（可选）",
  "explanation": "简要说明你做了哪些视觉调整或设计了哪几个专属音效变种",
  "selectVariant": "默认激活的变种 key（如 default）",
  "preset": { ... },
  "code": "创建或修改视觉特效 JS 代码时提供完整 ES Module 源码；纯配音任务省略",
  "sfxCode": "当 action 为 write_sfx 时提供完整的 ES Module 配音脚本源码字符串"
}`;

function scanBalancedJsonObjects(text) {
  const results = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try { results.push(JSON.parse(text.slice(start, i + 1))); } catch {}
          start = -1;
        }
      }
    }
  }
  return results;
}

function parseProviderHttpBody(rawBody, provider) {
  const trimmed = String(rawBody || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) {
    const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const hint = titleMatch ? titleMatch[1].trim() : trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    throw new Error(`模型接口返回了 HTML 网页 (${hint}) 而非 JSON，请检查「配置 API Key」中的 API Base URL 是否填写正确（OpenAI 兼容地址通常需以 /v1 结尾）。`);
  }
  try {
    const single = JSON.parse(trimmed);
    if (single.error?.message) throw new Error(single.error.message);
    if (provider === "gemini") return single.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (provider === "anthropic") return single.content?.map((c) => c.text || "").join("") || "";
    return single.choices?.[0]?.message?.content ?? single.choices?.[0]?.delta?.content ?? "";
  } catch (e) {
    if (e.message && !e.message.includes("JSON")) throw e;
  }
  const objs = scanBalancedJsonObjects(trimmed);
  if (!objs.length) throw new Error(`接口返回内容不是有效 JSON: ${trimmed.slice(0, 160)}`);
  let acc = "";
  for (const obj of objs) {
    if (obj.error?.message) throw new Error(obj.error.message);
    if (provider === "gemini") acc += obj.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    else if (provider === "anthropic") {
      if (obj.delta?.text) acc += obj.delta.text;
      else if (Array.isArray(obj.content)) acc += obj.content.map((c) => c.text || "").join("");
    } else {
      const c = obj.choices?.[0];
      if (c?.delta?.content) acc += c.delta.content;
      else if (c?.message?.content) acc += c.message.content;
    }
  }
  return acc;
}

function extractJsonPayload(raw) {
  const cleaned = String(raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const jsonFence = cleaned.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    try { return JSON.parse(jsonFence[1].trim()); } catch {}
    const inner = scanBalancedJsonObjects(jsonFence[1]);
    if (inner.length) return inner[0];
  }
  const candidates = scanBalancedJsonObjects(cleaned);
  const hit = candidates.find((o) => o && (o.action || o.code || o.sfxCode || o.preset || o.targetId)) || candidates[0];
  if (hit) {
    if (!hit.code && !hit.sfxCode) {
      const jsFence = cleaned.match(/```(?:js|javascript)\s*([\s\S]*?)```/i);
      if (jsFence) {
        if (hit.action === "write_sfx" || jsFence[1].includes("compileEffectVariants")) hit.sfxCode = jsFence[1].trim();
        else hit.code = jsFence[1].trim();
      }
    }
    return hit;
  }
  const bareJs = cleaned.match(/```(?:js|javascript)\s*([\s\S]*?)```/i);
  if (bareJs) {
    const body = bareJs[1].trim();
    if (body.includes("compileEffectVariants") || body.includes("sfx-core")) {
      return { action: "write_sfx", sfxCode: body, explanation: "已提取生成的专属配音脚本并编译多变种音效。" };
    }
    return { action: "edit_code", code: body, explanation: "已提取生成的特效源码并热重载。" };
  }
  throw new Error("模型返回内容未能解析出有效的特效 JSON 或代码");
}

async function callBrowserLLM(cfg, systemPrompt, userMessage, historyMsgs = []) {
  const isLocal = cfg.baseUrl.includes("localhost") || cfg.baseUrl.includes("127.0.0.1");
  if (!cfg.apiKey && !isLocal) {
    throw new Error("尚未配置大模型 API Key，请先点击右上角「配置 API Key」填写密钥。");
  }

  const cleanHistory = Array.isArray(historyMsgs)
    ? historyMsgs.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).slice(-10)
    : [];

  try {
    if (cfg.provider === "gemini") {
      const base = cfg.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
      const url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`;
      const headers = { "content-type": "application/json" };
      if (cfg.apiKey) headers["x-goog-api-key"] = cfg.apiKey;
      const resp = await rawFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            ...cleanHistory.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
            { role: "user", parts: [{ text: userMessage }] },
          ],
          generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
        }),
      });
      const raw = await resp.text();
      if (!resp.ok) return parseProviderHttpBody(raw, "gemini");
      return parseProviderHttpBody(raw, "gemini");
    }

    if (cfg.provider === "anthropic") {
      const base = cfg.baseUrl || "https://api.anthropic.com/v1";
      const resp = await rawFetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: cfg.model || "claude-sonnet-4-20250514",
          max_tokens: 4096,
          temperature: 0.4,
          stream: false,
          system: systemPrompt,
          messages: [...cleanHistory, { role: "user", content: userMessage }],
        }),
      });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`Claude API 请求失败 (${resp.status}): ${raw.slice(0, 220)}`);
      return parseProviderHttpBody(raw, "anthropic");
    }

    const base = cfg.baseUrl || "https://api.openai.com/v1";
    const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const headers = { "content-type": "application/json" };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const resp = await rawFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model || "gpt-4o",
        temperature: 0.4,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          ...cleanHistory,
          { role: "user", content: userMessage },
        ],
      }),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      if (raw.trim().startsWith("<")) return parseProviderHttpBody(raw, "openai");
      throw new Error(`模型接口请求失败 (${resp.status}): ${raw.slice(0, 220)}`);
    }
    return parseProviderHttpBody(raw, "openai");
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      const httpNote =
        location.protocol === "https:" && cfg.baseUrl.startsWith("http://")
          ? "若正在使用 http:// 地址，可在浏览器地址栏左侧「网站设置 -> 不安全内容」中设为「允许」，并确认接口开启了 CORS。"
          : "请确认目标接口已开启浏览器跨域头 (Access-Control-Allow-Origin) 且网络可达。";
      throw new Error(`网络请求未送达（浏览器拦截或连接失败）：${httpNote}`);
    }
    throw new Error(redactSensitiveText(msg, cfg));
  }
}

// ============================================================================
// 7. 核心操作辅助 (Create / SaveCode / Tune / SaveSfx / Undo)
// ============================================================================
async function browserCreateEffect({ id, zhName, zhDesc, loop = false, cloneFrom = null, cloneSpace = "library", preset = null }) {
  const store = await readBrowserWsStore();
  const finalId = uniqueBrowserId(store, id || cloneFrom || "arcane/custom-fx");
  let code = "";
  let inheritedPreset = preset;

  if (cloneFrom) {
    if (cloneSpace === "workspace" && store.effects[cloneFrom]?.code) {
      code = store.effects[cloneFrom].code;
      if (!inheritedPreset && store.effects[cloneFrom]?.preset) {
        inheritedPreset = { ...store.effects[cloneFrom].preset };
      }
    } else {
      code = await fetchBuiltinEffectSource(cloneFrom);
    }
  } else {
    code = buildStarterCode(finalId, { zhName, zhDesc, loop });
  }

  const now = new Date().toISOString();
  store.effects[finalId] = {
    code,
    mtimeMs: Date.now(),
    zhName: zhName || finalId.split("/")[1],
    zhDesc: zhDesc || "",
    baseId: cloneFrom || null,
    createdAt: now,
    updatedAt: now,
    ...(inheritedPreset ? { preset: inheritedPreset } : {}),
  };
  await writeBrowserWsStore(store);
  await saveBrowserHistorySnapshot(finalId, code, cloneFrom ? "fork" : "init");

  const check = await checkBrowserEffect(finalId, code);
  const list = await listBrowserWorkspaceEffects();
  return { ok: true, id: finalId, check, item: list.find((x) => x.id === finalId) };
}

async function browserSaveCode({ id, code, zhName, zhDesc, preset, reason = "save" }) {
  const store = await readBrowserWsStore();
  const prev = store.effects[id] || { createdAt: new Date().toISOString() };
  if (prev.code) await saveBrowserHistorySnapshot(id, prev.code, reason);
  store.effects[id] = {
    ...prev,
    code,
    mtimeMs: Date.now(),
    ...(zhName !== undefined ? { zhName } : {}),
    ...(zhDesc !== undefined ? { zhDesc } : {}),
    ...(preset !== undefined ? { preset: { ...(prev.preset || {}), ...preset } } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeBrowserWsStore(store);
  const check = await checkBrowserEffect(id, code);
  const list = await listBrowserWorkspaceEffects();
  return { ok: check.errors.length === 0, id, check, item: list.find((x) => x.id === id) };
}

async function browserTuneEffect({ id, zhName, zhDesc, preset, autoForkFromLibrary = true }) {
  const store = await readBrowserWsStore();
  if (!store.effects[id] && autoForkFromLibrary) {
    const code = await fetchBuiltinEffectSource(id);
    store.effects[id] = {
      code,
      mtimeMs: Date.now(),
      zhName: zhName || id.split("/")[1],
      zhDesc: zhDesc || "",
      baseId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  if (!store.effects[id]) throw new Error(`未找到特效 ${id}`);
  const prev = store.effects[id];
  store.effects[id] = {
    ...prev,
    ...(zhName !== undefined ? { zhName } : {}),
    ...(zhDesc !== undefined ? { zhDesc } : {}),
    preset: { ...(prev.preset || {}), ...(preset || {}) },
    updatedAt: new Date().toISOString(),
  };
  await writeBrowserWsStore(store);
  const list = await listBrowserWorkspaceEffects();
  return { ok: true, id, item: list.find((x) => x.id === id) };
}

async function browserSaveSfxCode({ id, code, selectVariant = null, autoForkFromLibrary = true }) {
  const store = await readBrowserWsStore();
  if (!store.effects[id] && autoForkFromLibrary) {
    try {
      const fxCode = await fetchBuiltinEffectSource(id);
      store.effects[id] = {
        code: fxCode,
        mtimeMs: Date.now(),
        zhName: id.split("/")[1],
        zhDesc: "",
        baseId: id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeBrowserWsStore(store);
    } catch {}
  }

  await idbSet("kv", `sfx_code::${id}`, code);
  await runBrowserSfxScript(id, code);
  const info = await getBrowserSfxInfo(id);
  if (!info.variants.length) {
    throw new Error(`配音脚本运行完成但未生成任何有效变种，请确认顶层调用了 await compileEffectVariants("${id}", ...)`);
  }
  const chosen = (selectVariant && info.variants.find((v) => v.id === selectVariant)?.id) || info.activeVariant;
  if (chosen && store.effects[id]) {
    store.effects[id].activeSfxVariant = chosen;
    store.effects[id].updatedAt = new Date().toISOString();
    await writeBrowserWsStore(store);
    info.activeVariant = chosen;
  }
  return { ok: true, id, sfx: info };
}

// ============================================================================
// 8. 虚拟 HTTP 路由分发器 (拦截 /api/* 与 /workspace/sfx/*.ogg)
// ============================================================================
const rawFetch = window.fetch.bind(window);
let _staticModeActive = false;

function jsonResp(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function parseReqBody(init) {
  if (!init?.body) return {};
  if (typeof init.body === "string") return JSON.parse(init.body || "{}");
  return {};
}

async function handleVirtualApi(urlObj, method, init) {
  const pathname = decodeURIComponent(urlObj.pathname);

  // 拦截浏览器内生成的 /workspace/sfx/<cat>/<name>/<variant>.ogg
  const sfxOggMatch = pathname.match(/\/workspace\/sfx\/([a-z0-9-]+\/[a-z0-9-]+)\/([a-z0-9_-]+)\.ogg$/i);
  if (sfxOggMatch && method === "GET") {
    const [, effectId, varId] = sfxOggMatch;
    const bytes = await idbGet("blobs", `sfx_ogg::${effectId}::${varId}`);
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(bytes, { status: 200, headers: { "content-type": "audio/ogg", "cache-control": "no-store" } });
  }

  try {
    if (pathname.endsWith("/api/custom-meta")) {
      if (method === "GET") {
        const saved = JSON.parse(localStorage.getItem("pixelfx_custom_meta_v1") || "{}");
        return jsonResp(200, saved);
      }
      const body = await parseReqBody(init);
      localStorage.setItem("pixelfx_custom_meta_v1", JSON.stringify(body));
      return jsonResp(200, { ok: true });
    }

    // ---- Workspace 路由 ----
    if (pathname.endsWith("/api/workspace/list") && method === "GET") {
      return jsonResp(200, { ok: true, effects: await listBrowserWorkspaceEffects() });
    }
    if (pathname.endsWith("/api/workspace/source") && method === "GET") {
      const id = urlObj.searchParams.get("id") || "";
      const store = await readBrowserWsStore();
      if (!store.effects[id]) return jsonResp(404, { ok: false, error: "未找到工作区特效源码" });
      return jsonResp(200, { ok: true, id, code: store.effects[id].code });
    }
    if (pathname.endsWith("/api/workspace/create") && method === "POST") {
      return jsonResp(200, await browserCreateEffect(await parseReqBody(init)));
    }
    if (pathname.endsWith("/api/workspace/save-code") && method === "POST") {
      return jsonResp(200, await browserSaveCode(await parseReqBody(init)));
    }
    if (pathname.endsWith("/api/workspace/tune") && method === "POST") {
      return jsonResp(200, await browserTuneEffect(await parseReqBody(init)));
    }
    if (pathname.endsWith("/api/workspace/check") && method === "POST") {
      const body = await parseReqBody(init);
      const store = await readBrowserWsStore();
      const check = await checkBrowserEffect(body.id, store.effects[body.id]?.code);
      return jsonResp(200, { ok: true, id: body.id, check });
    }
    if (pathname.endsWith("/api/workspace/history") && method === "GET") {
      const id = urlObj.searchParams.get("id") || "";
      const list = ((await idbGet("kv", `history::${id}`)) || []).slice().reverse().map(({ file, mtimeMs, size }) => ({ file, mtimeMs, size }));
      return jsonResp(200, { ok: true, id, history: list });
    }
    if (pathname.endsWith("/api/workspace/restore") && method === "POST") {
      const { id, file } = await parseReqBody(init);
      const list = (await idbGet("kv", `history::${id}`)) || [];
      const hit = list.find((x) => x.file === file);
      if (!hit) throw new Error("未找到对应历史快照");
      return jsonResp(200, await browserSaveCode({ id, code: hit.code, reason: "restore" }));
    }
    if (pathname.endsWith("/api/workspace/delete") && method === "POST") {
      const { id } = await parseReqBody(init);
      const store = await readBrowserWsStore();
      if (store.effects[id]?.code) await saveBrowserHistorySnapshot(id, store.effects[id].code, "deleted");
      delete store.effects[id];
      delete globalThis.__PIXELFX_WS_MODS__[id];
      await writeBrowserWsStore(store);
      return jsonResp(200, { ok: true, id });
    }
    if (pathname.endsWith("/api/workspace/publish") && method === "POST") {
      const { id } = await parseReqBody(init);
      return jsonResp(200, { ok: true, id, output: "当前为纯浏览器静态版本，特效已持久保存在本地浏览器工作区；如需写入仓库 src/fx/ 请在本地克隆仓库运行 npm start。" });
    }
    if (pathname.endsWith("/api/workspace/active-context")) {
      return jsonResp(200, { ok: true });
    }
    if (pathname.endsWith("/api/workspace/harness-info") && method === "GET") {
      return jsonResp(200, {
        ok: true,
        workspaceDir: "./workspace",
        files: [
          { relPath: "AGENTS.md", kind: "entry" },
          { relPath: ".agents/rules/pixelfx-workspace.md", kind: "rule" },
          { relPath: ".agents/skills/pixelfx-sfx/SKILL.md", kind: "skill" },
          { relPath: ".agents/skills/pixelfx-studio/SKILL.md", kind: "skill" },
          { relPath: ".agents/skills/pixelfx-studio/references/painter-and-sim.md", kind: "ref" },
          { relPath: ".agents/skills/pixelfx-studio/scripts/studio.mjs", kind: "script" },
        ],
        feed: [
          {
            ts: new Date().toISOString(),
            type: "WEB",
            message: "纯浏览器无服务工作区已就绪：支持直接克隆特效、在线改码、配置自定义 API Key 生成视觉与 .ogg 配音",
          },
        ],
      });
    }
    if (pathname.endsWith("/api/workspace/agents-file") && method === "GET") {
      const rel = (urlObj.searchParams.get("path") || "").replace(/^\/+/, "");
      const tryUrls = [`./workspace/${rel}`, `../workspace/${rel}`];
      for (const u of tryUrls) {
        try {
          const r = await rawFetch(u);
          if (r.ok) {
            const txt = await r.text();
            if (!txt.trim().startsWith("<!DOCTYPE") && !txt.trim().startsWith("<html")) {
              return jsonResp(200, { ok: true, readonly: true, relPath: rel, content: txt });
            }
          }
        } catch {}
      }
      throw new Error(`静态页面未打包该技能文件: ${rel}`);
    }

    // ---- Agent 配置、直连对话与 Undo 回撤路由 ----
    if (pathname.endsWith("/api/agent/config")) {
      if (method === "GET") return jsonResp(200, { ok: true, config: getBrowserAgentConfig(false) });
      return jsonResp(200, { ok: true, config: saveBrowserAgentConfig(await parseReqBody(init)) });
    }

    if (pathname.endsWith("/api/agent/clear-chat") && method === "POST") {
      await idbSet("kv", "ai_checkpoints", []);
      return jsonResp(200, { ok: true });
    }

    if (pathname.endsWith("/api/agent/undo") && method === "POST") {
      const { checkpointId } = await parseReqBody(init);
      const stack = (await idbGet("kv", "ai_checkpoints")) || [];
      if (!stack.length) throw new Error("当前没有可撤回的 AI 操作记录");
      const idx = checkpointId ? stack.findIndex((c) => c.checkpointId === checkpointId) : stack.length - 1;
      if (idx < 0) throw new Error("未找到对应的对话回撤节点");
      const toRevert = stack.slice(idx).reverse();
      const remaining = stack.slice(0, idx);
      const store = await readBrowserWsStore();

      for (const cp of toRevert) {
        if (!cp.prevEntry) {
          delete store.effects[cp.targetId];
          delete globalThis.__PIXELFX_WS_MODS__[cp.targetId];
        } else {
          store.effects[cp.targetId] = cp.prevEntry;
        }
        if (cp.sfxTouched) {
          if (!cp.prevSfxCode) {
            await idbDel("kv", `sfx_code::${cp.targetId}`);
            await idbDel("kv", `sfx_manifest::${cp.targetId}`);
          } else {
            await idbSet("kv", `sfx_code::${cp.targetId}`, cp.prevSfxCode);
            if (cp.prevSfxManifest) await idbSet("kv", `sfx_manifest::${cp.targetId}`, cp.prevSfxManifest);
            for (const [varKey, bytes] of Object.entries(cp.prevSfxBlobs || {})) {
              await idbSet("blobs", `sfx_ogg::${cp.targetId}::${varKey}`, bytes);
            }
          }
        }
      }
      await writeBrowserWsStore(store);
      await idbSet("kv", "ai_checkpoints", remaining);
      const earliest = toRevert[toRevert.length - 1];
      return jsonResp(200, {
        ok: true,
        undoneCount: toRevert.length,
        checkpointId: earliest.checkpointId,
        restoredSpace: earliest.prevSpace || "workspace",
        restoredId: earliest.prevId || null,
        restoredCfg: earliest.prevCfg || null,
        restoredPrompt: earliest.prompt || "",
        remainingCount: remaining.length,
      });
    }

    if (pathname.endsWith("/api/agent/chat") && method === "POST") {
      const { prompt, currentId, currentSpace, currentCfg, history = [] } = await parseReqBody(init);
      const llmCfg = getBrowserAgentConfig(true);
      const store = await readBrowserWsStore();

      let currentCode = "";
      let currentSfxCode = "";
      let checkInfo = null;
      let fxSearchTerms = "";

      if (currentId) {
        if (currentSpace === "workspace" && store.effects[currentId]?.code) {
          currentCode = store.effects[currentId].code;
          checkInfo = await checkBrowserEffect(currentId, currentCode);
        } else {
          try { currentCode = await fetchBuiltinEffectSource(currentId); } catch {}
        }
        currentSfxCode = (await idbGet("kv", `sfx_code::${currentId}`)) || "";
        fxSearchTerms = currentId.replace(/[/-]/g, " ");
      }

      const refsStatus = await getBrowserRefsStatus();
      let refsHintBlock = "音效参考库状态: 未启用（严禁调用 refLayer/refSample，请完全使用 sfx-core 纯 JS 原语独立程序化合成）";
      if (refsStatus.active) {
        const matched = await searchBrowserRefs(`${fxSearchTerms} ${prompt}`, { limit: 20 });
        const sampleRefs = matched.length ? matched : await searchBrowserRefs("", { limit: 16 });
        if (sampleRefs.length) {
          refsHintBlock =
            `音效参考库状态: 已启用 (${refsStatus.activeSoundCount} 条音频)。匹配的参考采样候选 (通过 await refLayer("<id>", begin, end, opts) 分层混音):\n` +
            sampleRefs.map((r) => `- "${r.id}" (${r.duration}s, peak@${r.peakTime}s)`).join("\n");
        }
      }

      const contextBlock = [
        `当前选中空间: ${currentSpace}`,
        `当前特效 ID: ${currentId || "无"}`,
        `当前界面参数: ${JSON.stringify(currentCfg || {})}`,
        checkInfo ? `当前代码诊断结果: ${JSON.stringify(checkInfo)}` : "",
        currentCode ? `当前特效视觉源码 (JS):\n\`\`\`js\n${currentCode}\n\`\`\`` : "",
        currentSfxCode ? `当前特效已有专属配音源码 (JS):\n\`\`\`js\n${currentSfxCode}\n\`\`\`` : "当前特效尚无专属配音脚本。",
        refsHintBlock,
        `\n用户需求指令:\n${prompt}`,
      ].filter(Boolean).join("\n\n");

      let rawReply = await callBrowserLLM(llmCfg, PIXELFX_SYSTEM_PROMPT, contextBlock, history);
      let plan = extractJsonPayload(rawReply);

      const action = plan.action || (plan.sfxCode && !plan.code ? "write_sfx" : plan.code ? "edit_code" : "tune");
      let targetId = (plan.targetId || currentId || "arcane/agent-fx").toLowerCase();
      if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(targetId)) targetId = currentId || "arcane/agent-fx";
      if (action === "create_code") targetId = uniqueBrowserId(store, targetId);

      // 记录浏览器端 Undo 检查点
      const checkpointId = "CP-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
      const sfxTouched = Boolean(action === "write_sfx" || plan.sfxCode);
      const prevSfxCode = sfxTouched ? await idbGet("kv", `sfx_code::${targetId}`) : null;
      const prevSfxManifest = sfxTouched ? await idbGet("kv", `sfx_manifest::${targetId}`) : null;
      const prevSfxBlobs = {};
      if (sfxTouched && prevSfxManifest?.variants) {
        for (const v of prevSfxManifest.variants) {
          const b = await idbGet("blobs", `sfx_ogg::${targetId}::${v.id}`);
          if (b) prevSfxBlobs[v.id] = b;
        }
      }

      const stack = (await idbGet("kv", "ai_checkpoints")) || [];
      stack.push({
        checkpointId,
        prompt,
        action,
        targetId,
        prevSpace: currentSpace || "workspace",
        prevId: currentId || null,
        prevCfg: currentCfg || null,
        prevEntry: store.effects[targetId] ? JSON.parse(JSON.stringify(store.effects[targetId])) : null,
        sfxTouched,
        prevSfxCode,
        prevSfxManifest,
        prevSfxBlobs,
      });
      await idbSet("kv", "ai_checkpoints", stack.slice(-25));

      if (action === "write_sfx" && !plan.code) {
        if (!plan.sfxCode) throw new Error("模型未返回有效的 JS 配音脚本 (sfxCode)");
        let sfxSaved;
        try {
          sfxSaved = await browserSaveSfxCode({ id: targetId, code: plan.sfxCode, selectVariant: plan.selectVariant || null, autoForkFromLibrary: true });
        } catch (sfxErr) {
          const fixPrompt = `${contextBlock}\n\n你刚才生成的 JS 配音脚本运行报错：\n${String(sfxErr.message || sfxErr)}\n\n请确保 await compileEffectVariants 的第一个参数为 "${targetId}"，修复后重新输出完整 JSON 对象。`;
          rawReply = await callBrowserLLM(llmCfg, PIXELFX_SYSTEM_PROMPT, fixPrompt, history);
          plan = extractJsonPayload(rawReply);
          if (!plan.sfxCode) throw sfxErr;
          sfxSaved = await browserSaveSfxCode({ id: targetId, code: plan.sfxCode, selectVariant: plan.selectVariant || null, autoForkFromLibrary: true });
        }
        const list = await listBrowserWorkspaceEffects();
        return jsonResp(200, {
          ok: true,
          action: "write_sfx",
          id: targetId,
          checkpointId,
          explanation: plan.explanation || `已为 ${targetId} 编译 ${sfxSaved.sfx.variants.length} 个音效变种。`,
          sfx: sfxSaved.sfx,
          item: list.find((x) => x.id === targetId),
        });
      }

      if (action === "tune" && !plan.code) {
        const res = await browserTuneEffect({ id: targetId, zhName: plan.zhName, zhDesc: plan.zhDesc, preset: plan.preset || {}, autoForkFromLibrary: true });
        return jsonResp(200, { ok: true, action: "tune", id: res.id, checkpointId, explanation: plan.explanation || "已完成特效参数动态调优。", item: res.item });
      }

      let saved = await browserSaveCode({ id: targetId, code: plan.code, zhName: plan.zhName, zhDesc: plan.zhDesc, preset: plan.preset, reason: "agent" });
      if (saved.check.errors.length > 0) {
        const fixPrompt = `${contextBlock}\n\n生成的视觉代码存在错误：\n${saved.check.errors.join("\n")}\n\n请修复并重新输出完整合法 JSON 对象。`;
        rawReply = await callBrowserLLM(llmCfg, PIXELFX_SYSTEM_PROMPT, fixPrompt, history);
        plan = extractJsonPayload(rawReply);
        if (plan.code) {
          saved = await browserSaveCode({ id: targetId, code: plan.code, zhName: plan.zhName, zhDesc: plan.zhDesc, preset: plan.preset, reason: "agent-fix" });
        }
      }

      let sfxOut = null;
      if (plan.sfxCode) {
        try {
          sfxOut = (await browserSaveSfxCode({ id: targetId, code: plan.sfxCode, selectVariant: plan.selectVariant || null, autoForkFromLibrary: false })).sfx;
        } catch {}
      }

      return jsonResp(200, {
        ok: saved.check.errors.length === 0,
        action,
        id: saved.id,
        checkpointId,
        explanation: plan.explanation || "已完成特效代码生成并加载到浏览器工作区。",
        check: saved.check,
        ...(sfxOut ? { sfx: sfxOut } : {}),
        item: saved.item,
      });
    }

    // ---- SFX 与动态音效参考库路由 ----
    if (pathname.endsWith("/api/sfx/info") && method === "GET") {
      const id = urlObj.searchParams.get("id") || "";
      return jsonResp(200, await getBrowserSfxInfo(id));
    }
    if (pathname.endsWith("/api/sfx/source") && method === "GET") {
      const id = urlObj.searchParams.get("id") || "";
      const code = await idbGet("kv", `sfx_code::${id}`);
      return jsonResp(200, { ok: true, id, exists: Boolean(code), code: code || "" });
    }
    if (pathname.endsWith("/api/sfx/save-code") && method === "POST") {
      const body = await parseReqBody(init);
      return jsonResp(200, await browserSaveSfxCode(body));
    }
    if (pathname.endsWith("/api/sfx/compile") && method === "POST") {
      const { id, selectVariant } = await parseReqBody(init);
      const code = await idbGet("kv", `sfx_code::${id}`);
      if (!code) throw new Error(`尚未找到特效 ${id} 的配音脚本`);
      return jsonResp(200, await browserSaveSfxCode({ id, code, selectVariant, autoForkFromLibrary: false }));
    }
    if (pathname.endsWith("/api/sfx/select-variant") && method === "POST") {
      const { id, variantId } = await parseReqBody(init);
      const store = await readBrowserWsStore();
      if (store.effects[id]) {
        store.effects[id].activeSfxVariant = variantId;
        await writeBrowserWsStore(store);
      }
      return jsonResp(200, await getBrowserSfxInfo(id));
    }
    if (pathname.endsWith("/api/sfx/refs/status") && method === "GET") {
      return jsonResp(200, { ok: true, ...(await getBrowserRefsStatus()) });
    }
    if (pathname.endsWith("/api/sfx/refs/toggle-global") && method === "POST") {
      const { enabled } = await parseReqBody(init);
      const cfg = await readBrowserRefsCfg();
      cfg.enabled = Boolean(enabled);
      await writeBrowserRefsCfg(cfg);
      return jsonResp(200, { ok: true, ...(await getBrowserRefsStatus()) });
    }
    if (pathname.endsWith("/api/sfx/refs/add-dir") && method === "POST") {
      throw new Error("纯网页静态版受浏览器沙盒限制无法直接按路径扫描本地磁盘目录，请使用下方「方式 B · 选择 ZIP / 音频导入...」直接上传导入！");
    }
    if (pathname.endsWith("/api/sfx/refs/upload") && method === "POST") {
      const { name, files } = await parseReqBody(init);
      if (!Array.isArray(files) || !files.length) throw new Error("未选择任何音频或 ZIP 文件");
      const cfg = await readBrowserRefsCfg();
      const displayName = String(name || files[0].name.replace(/\.[^.]+$/, "")).trim() || "导入音效包";
      const baseId = asciiSlug(displayName);
      let libId = baseId, n = 2;
      while ((cfg.libraries || []).some((l) => l.id === libId)) libId = `${baseId}-${n++}`;

      const rawItems = [];
      for (const f of files) {
        const ext = (f.name || "").slice((f.name || "").lastIndexOf(".")).toLowerCase();
        const binStr = atob(f.base64 || "");
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        if (ext === ".zip") {
          const unzipped = unzipSync(bytes);
          for (const [relKey, fileBytes] of Object.entries(unzipped)) {
            if (relKey.endsWith("/") || relKey.includes("__MACOSX")) continue;
            const innerExt = relKey.slice(relKey.lastIndexOf(".")).toLowerCase();
            if ([".ogg", ".wav", ".mp3"].includes(innerExt)) {
              rawItems.push({ relPath: relKey, bytes: fileBytes });
            }
          }
        } else if ([".ogg", ".wav", ".mp3"].includes(ext)) {
          rawItems.push({ relPath: f.name, bytes });
        }
      }

      const indexed = [];
      const seen = new Set();
      for (const item of rawItems.slice(0, 600)) {
        const parts = item.relPath.replace(/\\/g, "/").split("/").filter(Boolean);
        const fName = parts.pop() || "sound.ogg";
        const stem = slugify(fName.replace(/\.[^.]+$/, ""));
        const subDirs = parts.map(slugify).filter(Boolean);
        const relSlug = [...subDirs, stem].join("/");
        let refId = `${libId}/${relSlug}`, k = 2;
        while (seen.has(refId)) refId = `${libId}/${relSlug}-${k++}`;
        seen.add(refId);

        try {
          const dec = await decodeAudioBytesInBrowser(item.bytes);
          if (!dec || dec.mono.length < 32) continue;
          const duration = Math.round((dec.mono.length / dec.sampleRate) * 1000) / 1000;
          let pk = 0, pkIdx = 0;
          for (let i = 0; i < dec.mono.length; i++) {
            const a = Math.abs(dec.mono[i]);
            if (a > pk) { pk = a; pkIdx = i; }
          }
          if (pk < 1e-5) continue;
          const peakTime = Math.round((pkIdx / dec.sampleRate) * 1000) / 1000;
          await idbSet("blobs", `ref::${refId}`, item.bytes);
          const tokens = [libId, ...subDirs, stem].join("-").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((t) => t.length >= 2);
          indexed.push({ id: refId, libId, duration, peakTime, tags: [...new Set(tokens)] });
        } catch {}
      }

      if (!indexed.length) throw new Error("导入的文件中未发现浏览器可解码的 .ogg / .wav / .mp3 音频");
      cfg.sounds = [...(cfg.sounds || []).filter((s) => s.libId !== libId), ...indexed];
      cfg.libraries = [
        ...(cfg.libraries || []),
        { id: libId, name: displayName, sourceType: "upload", dirPath: `IndexedDB://${libId}`, enabled: true, count: indexed.length, addedAt: new Date().toISOString() },
      ];
      cfg.enabled = true;
      await writeBrowserRefsCfg(cfg);
      return jsonResp(200, { ok: true, ...(await getBrowserRefsStatus()) });
    }
    if (pathname.endsWith("/api/sfx/refs/toggle-lib") && method === "POST") {
      const { id, enabled } = await parseReqBody(init);
      const cfg = await readBrowserRefsCfg();
      const hit = (cfg.libraries || []).find((l) => l.id === id);
      if (hit) hit.enabled = Boolean(enabled);
      await writeBrowserRefsCfg(cfg);
      return jsonResp(200, { ok: true, ...(await getBrowserRefsStatus()) });
    }
    if (pathname.endsWith("/api/sfx/refs/rescan") && method === "POST") {
      return jsonResp(200, { ok: true, ...(await getBrowserRefsStatus()) });
    }
    if (pathname.endsWith("/api/sfx/refs/remove") && method === "POST") {
      const { id } = await parseReqBody(init);
      const cfg = await readBrowserRefsCfg();
      for (const s of (cfg.sounds || []).filter((x) => x.libId === id)) {
        await idbDel("blobs", `ref::${s.id}`);
        _refPcmCache.delete(s.id);
      }
      cfg.sounds = (cfg.sounds || []).filter((x) => x.libId !== id);
      cfg.libraries = (cfg.libraries || []).filter((l) => l.id !== id);
      await writeBrowserRefsCfg(cfg);
      return jsonResp(200, { ok: true, ...(await getBrowserRefsStatus()) });
    }

    return jsonResp(404, { ok: false, error: `未识别的浏览器端接口: ${pathname}` });
  } catch (err) {
    return jsonResp(400, { ok: false, error: String(err?.message || err) });
  }
}

export function isStaticBrowserMode() {
  return _staticModeActive;
}

export async function initBrowserBackendIfNeeded() {
  let needVirtual = location.hostname.endsWith(".github.io") || location.protocol === "file:";
  if (!needVirtual) {
    try {
      const probe = await rawFetch("/api/custom-meta", { cache: "no-store" });
      const ct = probe.headers.get("content-type") || "";
      if (!probe.ok || !ct.includes("application/json")) {
        needVirtual = true;
      }
    } catch {
      needVirtual = true;
    }
  }

  if (!needVirtual) return false;

  _staticModeActive = true;
  window.fetch = async (input, init = {}) => {
    const reqUrl = typeof input === "string" ? input : input?.url || "";
    const method = (init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    const urlObj = new URL(reqUrl, location.href);
    if (
      urlObj.origin === location.origin &&
      (urlObj.pathname.includes("/api/") || /\/workspace\/sfx\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9_-]+\.ogg$/i.test(urlObj.pathname))
    ) {
      return handleVirtualApi(urlObj, method, init);
    }
    return rawFetch(input, init);
  };
  return true;
}

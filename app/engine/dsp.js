// MotorPulse DSP: audio -> log-mel features, per-window feature vectors and a clip summary.
// Pure ES module with no browser dependencies, so the same code runs in the app and in Node tests.
// ml/reference.py mirrors this file exactly (checked by tests/parity).

export const SR = 16000;          // sample rate the engine works at
export const N_FFT = 1024;        // 64 ms frames
export const HOP = 256;           // 16 ms hop
export const N_MELS = 64;
export const FMIN = 20;
export const FMAX = 8000;
export const WIN = SR;            // 1 s analysis windows
export const WIN_HOP = SR / 2;    // 50% overlap
export const NB = N_FFT / 2 + 1;  // spectrum bins
export const HIGH_HZ = 3000;      // "high band" boundary for descriptors
export const FEATURE_DIM = N_MELS + 4;

const EPS = 1e-10;

let _hann = null;
export function hann() {
  if (!_hann) {
    _hann = new Float64Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) _hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  }
  return _hann;
}

export const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
export const melToHz = (m) => 700 * (Math.pow(10, m / 2595) - 1);

let _fb = null;
/** Triangular HTK-style mel filterbank, stored sparsely as {start, weights}. */
export function melFilterbank() {
  if (_fb) return _fb;
  const mMin = hzToMel(FMIN), mMax = hzToMel(FMAX);
  const pts = [];
  for (let i = 0; i < N_MELS + 2; i++) pts.push(melToHz(mMin + ((mMax - mMin) * i) / (N_MELS + 1)));
  const binHz = SR / N_FFT;
  const filters = [];
  for (let m = 0; m < N_MELS; m++) {
    const l = pts[m], c = pts[m + 1], r = pts[m + 2];
    const w = new Float64Array(NB);
    for (let k = 0; k < NB; k++) {
      const f = k * binHz;
      if (f > l && f < c) w[k] = (f - l) / (c - l);
      else if (f >= c && f < r) w[k] = (r - f) / (r - c);
    }
    let start = 0; while (start < NB && w[start] === 0) start++;
    let end = NB - 1; while (end > start && w[end] === 0) end--;
    filters.push({ start, weights: w.slice(start, end + 1), centerHz: c });
  }
  _fb = filters;
  return filters;
}

/** In-place iterative radix-2 FFT. re/im are Float64Array of length N (power of two). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Power spectra of all full frames (no padding). Returns an array of Float64Array(NB). */
export function stftPower(x) {
  const w = hann();
  const frames = [];
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  for (let s = 0; s + N_FFT <= x.length; s += HOP) {
    for (let i = 0; i < N_FFT; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
    fft(re, im);
    const p = new Float64Array(NB);
    for (let k = 0; k < NB; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    frames.push(p);
  }
  return frames;
}

/** Per-frame log-mel (dB) and descriptors. */
function frameFeatures(p) {
  const fb = melFilterbank();
  const lm = new Float64Array(N_MELS);
  for (let m = 0; m < N_MELS; m++) {
    const { start, weights } = fb[m];
    let s = 0;
    for (let k = 0; k < weights.length; k++) s += weights[k] * p[start + k];
    lm[m] = 10 * Math.log10(s + EPS);
  }
  const binHz = SR / N_FFT;
  const hi0 = Math.ceil(HIGH_HZ / binHz);
  let tot = 0, cen = 0, hi = 0, logSum = 0;
  for (let k = 1; k < NB; k++) {          // skip DC
    const v = p[k];
    tot += v; cen += v * k * binHz; logSum += Math.log(v + 1e-12);
    if (k >= hi0) hi += v;
  }
  const nb = NB - 1;
  const centroid = cen / (tot + EPS);
  const flatness = Math.exp(logSum / nb) / (tot / nb + 1e-12);
  const highRatio = hi / (tot + EPS);
  const energyDb = 10 * Math.log10(tot + EPS);
  return { lm, centroid, flatness, highRatio, energyDb };
}

/** Excess kurtosis of the first difference (emphasises short impulsive events such as bearing defects). */
export function diffKurtosis(x) {
  const n = x.length - 1;
  if (n < 4) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i + 1] - x[i];
  m /= n;
  let m2 = 0, m4 = 0;
  for (let i = 0; i < n; i++) { const d = x[i + 1] - x[i] - m; const d2 = d * d; m2 += d2; m4 += d2 * d2; }
  m2 /= n; m4 /= n;
  return m4 / (m2 * m2 + 1e-20) - 3;
}

export const FINE_N = 16384;            // ~1 Hz resolution for shaft-rate and mains-hum lines
export const FINE_MAX_HZ = 400;
/** Welch-averaged, ~1 Hz resolution power spectrum from 0 to 400 Hz, normalised to sum to 1. */
export function fineLowSpectrum(x) {
  const n = FINE_N, keep = Math.round((FINE_MAX_HZ * n) / SR) + 1;
  const acc = new Float64Array(keep);
  const re = new Float64Array(n), im = new Float64Array(n);
  let cnt = 0;
  for (let s = 0; s + n <= x.length; s += n / 2) {
    for (let i = 0; i < n; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)); im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < keep; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    cnt++;
  }
  let tot = 0;
  for (let k = 1; k < keep; k++) tot += acc[k];
  return Array.from(acc, (v) => (cnt && tot > 0 ? v / tot : 0));
}

/**
 * Full analysis of a mono 16 kHz clip.
 * windows: array of FEATURE_DIM vectors (one per 1 s window, 50% overlap)
 * summary: clip-level spectrum statistics used for fault hints
 */
export function analyze(x) {
  const frames = stftPower(x);
  const ff = frames.map(frameFeatures);
  const nF = ff.length;
  const windows = [];
  for (let s = 0; s + WIN <= x.length; s += WIN_HOP) {
    const f0 = Math.ceil(s / HOP);
    const f1 = Math.floor((s + WIN - N_FFT) / HOP);
    const cnt = f1 - f0 + 1;
    if (cnt < 2) continue;
    const v = new Array(FEATURE_DIM).fill(0);
    let eMean = 0;
    for (let f = f0; f <= f1; f++) {
      const q = ff[f];
      for (let m = 0; m < N_MELS; m++) v[m] += q.lm[m];
      v[N_MELS] += q.centroid / 1000;
      v[N_MELS + 1] += q.flatness * 10;
      v[N_MELS + 2] += 10 * Math.log10(q.highRatio + 1e-6);
      eMean += q.energyDb;
    }
    for (let i = 0; i < N_MELS + 3; i++) v[i] /= cnt;
    eMean /= cnt;
    let eVar = 0;
    for (let f = f0; f <= f1; f++) eVar += (ff[f].energyDb - eMean) ** 2;
    v[N_MELS + 3] = Math.sqrt(eVar / cnt);
    windows.push(v);
  }
  const meanLogMel = new Array(N_MELS).fill(0);
  const meanPower = new Array(NB).fill(0);
  let flat = 0;
  for (let f = 0; f < nF; f++) {
    for (let m = 0; m < N_MELS; m++) meanLogMel[m] += ff[f].lm[m] / nF;
    for (let k = 0; k < NB; k++) meanPower[k] += frames[f][k] / nF;
    flat += ff[f].flatness / nF;
  }
  let ss = 0;
  for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
  const rmsDb = 10 * Math.log10(ss / Math.max(1, x.length) + EPS);
  return {
    windows,
    summary: { meanLogMel, meanPower, fineLow: fineLowSpectrum(x), flatness: flat, kurtosis: diffKurtosis(x), rmsDb },
    frameEnergyDb: ff.map((q) => q.energyDb),
  };
}

/**
 * Recording quality gate. Rejects audio that would give an unreliable diagnosis.
 * Returns {ok, issues:[code], stats}.
 */
export function qualityGate(x, { minSec = 4 } = {}) {
  const dur = x.length / SR;
  let clip = 0, ss = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a >= 0.99) clip++; ss += x[i] * x[i]; }
  const clipFrac = clip / Math.max(1, x.length);
  const rmsDb = 10 * Math.log10(ss / Math.max(1, x.length) + EPS);
  // Steadiness: machines hum steadily; talking or handling noise makes the level jump around.
  const blk = Math.floor(SR / 10);
  const lv = [];
  for (let s = 0; s + blk <= x.length; s += blk) {
    let e = 0; for (let i = s; i < s + blk; i++) e += x[i] * x[i];
    lv.push(10 * Math.log10(e / blk + EPS));
  }
  const mu = lv.reduce((a, b) => a + b, 0) / Math.max(1, lv.length);
  const sd = Math.sqrt(lv.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, lv.length));
  const issues = [];
  if (dur < minSec) issues.push("too_short");
  if (rmsDb < -60) issues.push("too_quiet");
  if (clipFrac > 0.01) issues.push("clipping");
  if (sd > 6) issues.push("unsteady");
  return { ok: issues.length === 0, issues, stats: { dur, clipFrac, rmsDb, levelSd: sd } };
}

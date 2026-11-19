// MotorPulse per-machine model: enrolment ("sound fingerprint") and scoring.
// Two complementary detectors are fitted on the machine's own healthy recordings:
//   A. PCA reconstruction error (a linear autoencoder): "is this sound made of the usual parts?"
//   B. Mahalanobis distance with shrinkage covariance: "how far is this from the usual sound?"
// Each score is calibrated on held-out healthy windows (leave-one-clip-out), then fused into a 0-100 health score.

import { FEATURE_DIM } from "./dsp.js";

export const MODEL_VERSION = "mp-fp-1.0";
const SHRINK = 0.5;      // covariance shrinkage toward identity (features are standardised)
const PCA_VAR = 0.9;     // variance kept by the PCA detector
const PCA_MAX = 10;

// ---------- small linear-algebra helpers ----------
const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function meanVec(rows) {
  const d = rows[0].length, m = new Array(d).fill(0);
  for (const r of rows) for (let i = 0; i < d; i++) m[i] += r[i];
  return m.map((v) => v / rows.length);
}

function covariance(rows, mean) {
  const d = mean.length, n = rows.length, C = zeros(d, d);
  for (const r of rows) {
    const c = r.map((v, i) => v - mean[i]);
    for (let i = 0; i < d; i++) { const ci = c[i]; if (ci === 0) continue; for (let j = i; j < d; j++) C[i][j] += ci * c[j]; }
  }
  const den = Math.max(1, n - 1);
  for (let i = 0; i < d; i++) for (let j = i; j < d; j++) { C[i][j] /= den; C[j][i] = C[i][j]; }
  return C;
}

/** Gauss-Jordan inverse with partial pivoting. */
export function invert(A) {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error("singular matrix");
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r) => r.slice(n));
}

/** Cyclic Jacobi eigen-decomposition of a symmetric matrix. Returns {values, vectors(columns)} sorted descending. */
export function jacobiEigen(S, maxSweeps = 60) {
  const n = S.length;
  const A = S.map((r) => [...r]);
  const V = zeros(n, n);
  for (let i = 0; i < n; i++) V[i][i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p][q];
        if (Math.abs(apq) < 1e-15) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [...Array(n).keys()].sort((a, b) => A[b][b] - A[a][a]);
  return { values: idx.map((i) => A[i][i]), vectors: idx.map((i) => V.map((r) => r[i])) };
}

// ---------- detectors ----------
function fitDetectors(Z) {
  const d = Z[0].length;
  const mean = meanVec(Z);
  const C = covariance(Z, mean);
  let tr = 0; for (let i = 0; i < d; i++) tr += C[i][i];
  const S = C.map((r, i) => r.map((v, j) => (1 - SHRINK) * v + (i === j ? SHRINK * (tr / d) : 0)));
  const inv = invert(S);
  const { values, vectors } = jacobiEigen(C);
  const total = values.reduce((a, v) => a + Math.max(0, v), 0) || 1;
  let k = 0, acc = 0;
  while (k < values.length && acc / total < PCA_VAR) { acc += Math.max(0, values[k]); k++; }
  k = Math.max(1, Math.min(k, PCA_MAX, Z.length - 1));
  return { mean, inv, comps: vectors.slice(0, k) };
}

function rawScores(det, z) {
  const d = z.length;
  const c = z.map((v, i) => v - det.mean[i]);
  // A: PCA reconstruction error
  const proj = det.comps.map((u) => u.reduce((s, ui, i) => s + ui * c[i], 0));
  let a = 0;
  for (let i = 0; i < d; i++) {
    let r = c[i];
    for (let j = 0; j < det.comps.length; j++) r -= proj[j] * det.comps[j][i];
    a += r * r;
  }
  // B: Mahalanobis distance (squared)
  let b = 0;
  for (let i = 0; i < d; i++) { let t = 0; const row = det.inv[i]; for (let j = 0; j < d; j++) t += row[j] * c[j]; b += c[i] * t; }
  return { a: a / d, b: b / d };
}

function robust(arr) {
  const med = median(arr);
  const mad = 1.4826 * median(arr.map((v) => Math.abs(v - med)));
  return { med, mad: Math.max(mad, 0.1 * Math.abs(med), 1e-6) };
}

function averageSummaries(sums) {
  const avg = (key) => sums.reduce((s, q) => s + q[key], 0) / sums.length;
  const avgArr = (key) => sums[0][key].map((_, i) => sums.reduce((s, q) => s + q[key][i], 0) / sums.length);
  return { meanLogMel: avgArr("meanLogMel"), meanPower: avgArr("meanPower"), fineLow: avgArr("fineLow"), flatness: avg("flatness"), kurtosis: avg("kurtosis"), rmsDb: avg("rmsDb") };
}

/**
 * Enrol a machine from healthy clips.
 * @param clips array of analyze() results (one per healthy recording)
 */
export function enrol(clips) {
  const clipWins = clips.map((c) => c.windows).filter((w) => w.length);
  const all = clipWins.flat();
  if (all.length < 8) throw new Error("not_enough_audio");
  const d = FEATURE_DIM;
  const mu = meanVec(all);
  const sd = mu.map((m, i) => Math.max(1e-3, Math.sqrt(all.reduce((s, r) => s + (r[i] - m) ** 2, 0) / Math.max(1, all.length - 1))));
  const std = (r) => r.map((v, i) => (v - mu[i]) / sd[i]);
  const Zc = clipWins.map((w) => w.map(std));
  // calibration on held-out healthy windows
  const A = [], B = [];
  let folds;
  if (Zc.length >= 2) folds = Zc.map((_, i) => ({ train: Zc.filter((__, j) => j !== i).flat(), test: Zc[i] }));
  else {
    const z = Zc[0];
    const ev = z.filter((_, i) => i % 2 === 0), od = z.filter((_, i) => i % 2 === 1);
    folds = [{ train: ev, test: od }, { train: od, test: ev }];
  }
  for (const f of folds) {
    if (f.train.length < 3) continue;
    const det = fitDetectors(f.train);
    for (const z of f.test) { const r = rawScores(det, z); A.push(r.a); B.push(r.b); }
  }
  const det = fitDetectors(Zc.flat());
  return {
    version: MODEL_VERSION,
    dim: d,
    createdAt: Date.now(),
    nWindows: all.length,
    nClips: clips.length,
    mu, sd,
    det,
    calib: { a: robust(A), b: robust(B) },
    baseline: averageSummaries(clips.map((c) => c.summary)),
  };
}

/** Map a fused anomaly z-score to a 0-100 health score (z=0 -> ~95, z=3 -> 50). */
export const healthFromZ = (z) => 100 / (1 + Math.exp(z - 3));

/** Score one analysed clip against an enrolled model. */
export function score(model, analysis) {
  const ws = analysis.windows;
  if (!ws.length) throw new Error("not_enough_audio");
  const per = ws.map((w) => {
    const z = w.map((v, i) => (v - model.mu[i]) / model.sd[i]);
    const r = rawScores(model.det, z);
    const za = (r.a - model.calib.a.med) / model.calib.a.mad;
    const zb = (r.b - model.calib.b.med) / model.calib.b.mad;
    return { za, zb, z: 0.5 * za + 0.5 * zb };
  });
  const z = median(per.map((p) => p.z));
  return {
    z,
    za: median(per.map((p) => p.za)),
    zb: median(per.map((p) => p.zb)),
    health: Math.round(healthFromZ(z)),
    windows: per.length,
  };
}

// Explainable fault hints: compare the new recording with the machine's own enrolled baseline.
// These are physics-informed rules (the reasoning a vibration analyst uses), not a trained classifier.
// All features are level-independent, because phone microphones apply automatic gain.
// A trained fault classifier is planned once labelled field data is collected (see docs).

import { SR, N_MELS, FINE_N, melFilterbank } from "./dsp.js";

const BANDS = { low: [20, 300], mid: [300, 2000], high: [2000, 8000] };
const HUM_LINES = [50, 100, 150, 200, 250, 300];
const FINE_HZ = SR / FINE_N;

/** Mean log-mel change in a band, relative to the average change over all bands (spectral SHAPE, not loudness). */
function shapeDelta(cur, base, [lo, hi]) {
  const fb = melFilterbank();
  let all = 0, s = 0, n = 0;
  for (let m = 0; m < N_MELS; m++) {
    const d = cur[m] - base[m];
    all += d;
    if (fb[m].centerHz >= lo && fb[m].centerHz < hi) { s += d; n++; }
  }
  return n ? s / n - all / N_MELS : 0;
}

const nearHum = (f) => HUM_LINES.some((h) => Math.abs(f - h) <= 2);
const K0 = Math.ceil(15 / FINE_HZ);

/** Broadband noise floor of the 15-400 Hz spectrum (median); tones are measured relative to it, so gain does not matter. */
function floorOf(fine) {
  const s = fine.slice(K0).sort((a, b) => a - b);
  return s[s.length >> 1] + 1e-15;
}

/** Mains-hum strength: power on 50 Hz-multiple lines relative to the floor (dB). */
function humLevel(fine) {
  const fl = floorOf(fine);
  let hum = 0;
  for (let k = K0; k < fine.length; k++) if (nearHum(k * FINE_HZ)) hum += fine[k];
  return 10 * Math.log10(hum / fl + 1e-9);
}

/**
 * Largest rise (dB) of any non-hum tone between 15 and 400 Hz versus the baseline: shaft-rate harmonics
 * (1x imbalance, 2x misalignment, higher harmonics looseness). Comparing with the same phone's baseline
 * cancels the microphone's weak low-frequency response.
 */
function toneRise(cur, base) {
  const fc = floorOf(cur), fb = floorOf(base);
  let best = 0;
  for (let k = K0 + 2; k < cur.length - 2; k++) {
    if (nearHum(k * FINE_HZ)) continue;
    let c = 0, b = 0;
    for (let j = k - 2; j <= k + 2; j++) { c = Math.max(c, cur[j]); b = Math.max(b, base[j]); }
    if (c < 30 * fc) continue;                       // only clear tones (~15 dB above floor)
    best = Math.max(best, 10 * Math.log10((c / fc) / (b / fb + 1e-12)));
  }
  return best;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * @returns {{feats, hints:[{id, confidence}]}} hints sorted by confidence (may be empty)
 */
export function faultHints(summary, baseline) {
  const f = {
    low: shapeDelta(summary.meanLogMel, baseline.meanLogMel, BANDS.low),
    mid: shapeDelta(summary.meanLogMel, baseline.meanLogMel, BANDS.mid),
    high: shapeDelta(summary.meanLogMel, baseline.meanLogMel, BANDS.high),
    hum: humLevel(summary.fineLow) - humLevel(baseline.fineLow),
    rot: toneRise(summary.fineLow, baseline.fineLow),
    kurt: summary.kurtosis - baseline.kurtosis,
    flat: summary.flatness - baseline.flatness,
  };
  const scores = {
    // Bearing wear: sharp, periodic clicks (impulsiveness) and extra high-frequency energy, spectrum stays tonal.
    bearing: (clamp01(f.kurt / 2) * 0.5 + clamp01(f.high / 3) * 0.5) * (f.flat > 0.12 ? 0.5 : 1),
    // Cavitation / dry running: broadband, noise-like hiss -> the whole spectrum gets flatter.
    cavitation: clamp01((f.flat - 0.04) / 0.1) * (f.high > 0 ? 1 : 0.6),
    // Imbalance / misalignment / looseness: stronger shaft-rate tones (1x, 2x) without more mains hum.
    // (healthy recordings vary by up to ~7 dB here, so only larger rises count)
    imbalance: clamp01((f.rot - 8) / 8) * (f.hum < 2 ? 1 : 0.4),
    // Electrical issue: stronger hum lines at multiples of 50 Hz.
    electrical: clamp01((f.hum - 1.5) / 5),
  };
  const hints = Object.entries(scores)
    .filter(([, c]) => c >= 0.2)
    .map(([id, c]) => ({ id, confidence: Math.round(c * 100) / 100 }))
    .sort((a, b) => b.confidence - a.confidence);
  return { feats: f, hints };
}

export const CRITICAL = new Set(["bearing", "cavitation"]);

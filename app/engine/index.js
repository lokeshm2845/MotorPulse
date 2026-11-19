// Public engine API used by the app and the tests.
import { analyze, qualityGate } from "./dsp.js";
import { enrol, score, MODEL_VERSION } from "./model.js";
import { faultHints } from "./faults.js";
import { trend, severity } from "./trend.js";

export { analyze, qualityGate, enrol, score, faultHints, trend, severity, MODEL_VERSION };

/**
 * Run a full check: quality gate -> features -> score -> fault hints -> trend -> severity.
 * @param model enrolled model
 * @param x Float32Array mono 16 kHz
 * @param previousHealths chronological health of earlier checks
 */
export function runCheck(model, x, previousHealths = []) {
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  const quality = qualityGate(x);
  if (!quality.ok) return { ok: false, quality };
  const a = analyze(x);
  const s = score(model, a);
  const fh = faultHints(a.summary, model.baseline);
  // Only surface a cause when the recording is actually abnormal.
  const hints = s.health < 75 ? fh.hints : [];
  const tr = trend([...previousHealths, s.health]);
  const sev = severity(s.health, tr.alarm, hints);
  const ms = (typeof performance !== "undefined" ? performance : Date).now() - t0;
  return { ok: true, quality, ...s, hints, faultFeatures: fh.feats, trendAlarm: tr.alarm, severity: sev, ms, modelVersion: MODEL_VERSION };
}

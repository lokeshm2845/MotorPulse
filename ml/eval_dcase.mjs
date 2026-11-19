// Evaluate the MotorPulse engine on the public DCASE 2020 Task 2 pump development set (real recordings, MIMII-based).
// Protocol mirrors the app: for each pump (machine id), ENROL with only K healthy training clips, then score every
// test clip (normal + anomalous) and report ROC AUC and partial AUC (FPR <= 0.1, the DCASE metric).
// Usage: node ml/eval_dcase.mjs <path-to>/pump  [K=3] [repeats=5]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, enrol, score } from "../app/engine/index.js";
import { decodeWav, resampleLinear } from "../app/engine/wav.js";

const [root, K = "3", REP = "5"] = process.argv.slice(2);
if (!root) { console.error("usage: node ml/eval_dcase.mjs <dir containing train/ and test/> [K] [repeats]"); process.exit(1); }
const k = +K, reps = +REP;

const load = (p) => { const { rate, samples } = decodeWav(readFileSync(p)); return rate === 16000 ? samples : resampleLinear(samples, rate, 16000); };

function auc(pos, neg) {           // probability a random anomaly scores above a random normal clip
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
function pauc(pos, neg, maxFpr = 0.1) {   // standardised partial AUC as used in DCASE 2020
  const negS = [...neg].sort((a, b) => b - a);
  const m = Math.max(1, Math.floor(negS.length * maxFpr));
  let s = 0;
  for (let i = 0; i < m; i++) { const thr = negS[i]; s += pos.filter((p) => p > thr).length / pos.length; }
  return s / m;
}
function rng(seed) { let x = seed; return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296); }

const trainFiles = readdirSync(join(root, "train")).filter((f) => f.endsWith(".wav"));
const testFiles = readdirSync(join(root, "test")).filter((f) => f.endsWith(".wav"));
const ids = [...new Set(testFiles.map((f) => f.match(/id_(\d+)/)[1]))].sort();
const results = [];
for (const id of ids) {
  const tr = trainFiles.filter((f) => f.includes(`id_${id}_`)).sort();
  const te = testFiles.filter((f) => f.includes(`id_${id}_`)).sort();
  const testA = te.map((f) => ({ anomalous: f.startsWith("anomaly"), a: analyze(load(join(root, "test", f))) }));
  const aucs = [], paucs = [];
  for (let r = 0; r < reps; r++) {
    const rnd = rng(1000 + r);
    const pick = [...tr].sort(() => rnd() - 0.5).slice(0, k);
    const model = enrol(pick.map((f) => analyze(load(join(root, "train", f)))));
    const sc = testA.map((t) => ({ anomalous: t.anomalous, z: score(model, t.a).z }));
    const pos = sc.filter((s) => s.anomalous).map((s) => s.z), neg = sc.filter((s) => !s.anomalous).map((s) => s.z);
    aucs.push(auc(pos, neg)); paucs.push(pauc(pos, neg));
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const row = { id, enrolClips: k, repeats: reps, testNormal: testA.filter((t) => !t.anomalous).length, testAnomaly: testA.filter((t) => t.anomalous).length,
    auc: +mean(aucs).toFixed(3), pauc: +mean(paucs).toFixed(3), aucMin: +Math.min(...aucs).toFixed(3), aucMax: +Math.max(...aucs).toFixed(3) };
  results.push(row);
  console.log(JSON.stringify(row));
}
const avg = (key) => +(results.reduce((s, r) => s + r[key], 0) / results.length).toFixed(3);
const summary = { dataset: "DCASE2020 Task2 dev, pump", enrolClips: k, repeats: reps, meanAUC: avg("auc"), meanPAUC: avg("pauc"), perMachine: results };
console.log("MEAN AUC", summary.meanAUC, "MEAN pAUC", summary.meanPAUC);
writeFileSync(`ml/results_dcase_pump_k${k}.json`, JSON.stringify(summary, null, 2));

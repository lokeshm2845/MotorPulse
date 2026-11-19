// Enrol on the three healthy samples, then check every sample and print the result table.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, enrol, runCheck } from "../app/engine/index.js";
import { decodeWav } from "../app/engine/wav.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "samples");
const load = (f) => decodeWav(readFileSync(join(dir, f))).samples;

export function evaluateSamples() {
  const t0 = performance.now();
  const model = enrol([1, 2, 3].map((i) => analyze(load(`SIMULATED_healthy_enrol_${i}.wav`))));
  const enrolMs = performance.now() - t0;
  const rows = readdirSync(dir).filter((f) => f.endsWith(".wav") && !f.includes("enrol")).sort().map((f) => {
    const r = runCheck(model, load(f));
    return { file: f.replace("SIMULATED_", "").replace(".wav", ""), health: r.health, severity: r.severity,
      top: r.hints?.[0]?.id ?? "-", conf: r.hints?.[0]?.confidence ?? "-", z: r.z?.toFixed(2), ms: Math.round(r.ms) };
  });
  return { model, rows, enrolMs };
}

if (process.argv[1] && process.argv[1].endsWith("run_samples.mjs")) {
  const { rows, enrolMs, model } = evaluateSamples();
  console.log(`enrolment: ${model.nWindows} windows, ${model.det.comps.length} PCA comps, ${Math.round(enrolMs)} ms`);
  console.table(rows);
}

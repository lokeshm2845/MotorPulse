// Engine unit + behaviour tests:  node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { fft, analyze, qualityGate, SR, FEATURE_DIM } from "../app/engine/dsp.js";
import { invert, jacobiEigen } from "../app/engine/model.js";
import { trend, severity } from "../app/engine/trend.js";
import { evaluateSamples } from "./run_samples.mjs";

test("FFT finds a pure tone in the right bin", () => {
  const n = 1024, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
  fft(re, im);
  const mag = Array.from(re, (r, k) => Math.hypot(r, im[k]));
  assert.equal(mag.slice(0, n / 2).indexOf(Math.max(...mag.slice(0, n / 2))), 64);
});

test("matrix inverse and eigen-decomposition are correct", () => {
  const A = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];
  const I = invert(A);
  const P = A.map((r) => I[0].map((_, j) => r.reduce((s, v, k) => s + v * I[k][j], 0)));
  P.forEach((r, i) => r.forEach((v, j) => assert.ok(Math.abs(v - (i === j ? 1 : 0)) < 1e-9)));
  const { values, vectors } = jacobiEigen(A);
  vectors.forEach((v, k) => A.forEach((row, i) => assert.ok(Math.abs(row.reduce((s, a, j) => s + a * v[j], 0) - values[k] * v[i]) < 1e-8)));
});

test("analysis produces 19 one-second windows for a 10 s clip", () => {
  const x = new Float32Array(SR * 10).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 100 * i) / SR) + 0.01 * (Math.random() - 0.5));
  const a = analyze(x);
  assert.equal(a.windows.length, 19);
  assert.equal(a.windows[0].length, FEATURE_DIM);
});

test("quality gate rejects short, silent, clipped and unsteady audio", () => {
  assert.ok(qualityGate(new Float32Array(SR * 2).fill(0.1)).issues.includes("too_short"));
  assert.ok(qualityGate(new Float32Array(SR * 10)).issues.includes("too_quiet"));
  assert.ok(qualityGate(new Float32Array(SR * 10).fill(1)).issues.includes("clipping"));
  const bursty = new Float32Array(SR * 10).map((_, i) => (Math.floor(i / 4000) % 2 ? 0.3 : 0.003) * Math.sin(i / 3));
  assert.ok(qualityGate(bursty).issues.includes("unsteady"));
});

test("trend engine raises an alarm on a steady decline and severity rules hold", () => {
  assert.equal(trend([92, 93, 91, 90, 92]).alarm, false);
  assert.equal(trend([94, 93, 92, 84, 78, 77]).alarm, true);
  assert.equal(severity(90, false, []), "green");
  assert.equal(severity(90, true, []), "yellow");
  assert.equal(severity(60, false, [{ id: "imbalance", confidence: 0.9 }]), "yellow");
  assert.equal(severity(60, false, [{ id: "bearing", confidence: 0.8 }]), "red");
  assert.equal(severity(40, false, []), "red");
});

test("simulated recordings: healthy stays green, every fault is flagged with the right cause", () => {
  const { rows } = evaluateSamples();
  const by = Object.fromEntries(rows.map((r) => [r.file, r]));
  assert.equal(by.healthy_check.severity, "green");
  assert.equal(by.healthy_check_noisy.severity, "green");
  // an early fault is caught (not green) even before its cause is clear
  assert.equal(by.fault_bearing_early.severity, "yellow");
  for (const [f, cause] of [["fault_bearing_severe", "bearing"], ["fault_imbalance", "imbalance"],
    ["fault_cavitation", "cavitation"], ["fault_electrical", "electrical"]]) {
    assert.notEqual(by[f].severity, "green", f);
    assert.equal(by[f].top, cause, f);
  }
});

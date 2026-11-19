// Minimal WAV reader/writer (PCM 16-bit and float 32-bit), used by tests and the demo sample loader.

export function decodeWav(buf) {
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const str = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => dv.getUint8(o + i)));
  if (str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= dv.byteLength) {
    const id = str(off, 4), size = dv.getUint32(off + 4, true);
    if (id === "fmt ") fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === "data") data = { off: off + 8, size: Math.min(size, dv.byteLength - off - 8) };
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("bad WAV");
  const bps = fmt.bits / 8, n = Math.floor(data.size / (bps * fmt.channels));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = data.off + (i * fmt.channels + c) * bps;
      if (fmt.format === 3 && fmt.bits === 32) s += dv.getFloat32(o, true);
      else if (fmt.bits === 16) s += dv.getInt16(o, true) / 32768;
      else if (fmt.bits === 24) { const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); s += v / 8388608; }
      else if (fmt.bits === 32) s += dv.getInt32(o, true) / 2147483648;
      else throw new Error("unsupported WAV bit depth");
    }
    out[i] = s / fmt.channels;
  }
  return { rate: fmt.rate, samples: out };
}

/** Linear-interpolation resampler (inputs are low-pass enough for engine use; the browser path uses OfflineAudioContext). */
export function resampleLinear(x, from, to) {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r, k = Math.floor(p), f = p - k; out[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f; }
  return out;
}

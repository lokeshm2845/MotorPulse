// Microphone capture (raw PCM, no browser noise suppression or auto-gain) and file decoding, both returning mono 16 kHz.
import { SR } from "./engine/dsp.js";

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("mp-tap", Tap);`;

/** Resample any mono buffer to 16 kHz with the browser's own (anti-aliased) resampler. */
export async function to16k(samples, rate) {
  if (rate === SR) return samples;
  const len = Math.ceil((samples.length * SR) / rate);
  const off = new OfflineAudioContext(1, len, SR);
  const buf = off.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice(0);
}

export async function decodeFile(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const ab = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const mono = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / ab.numberOfChannels;
    }
    return to16k(mono, ab.sampleRate);
  } finally { ctx.close(); }
}

/**
 * Record from the microphone.
 * @param seconds duration
 * @param onLevel callback(levelDb, secondsLeft)
 * @returns {{promise: Promise<Float32Array>, stop: Function}}
 */
export function recordMic(seconds, onLevel) {
  let stopFn = () => {};
  const promise = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "mp-tap");
    const chunks = [];
    let n = 0;
    const total = Math.round(seconds * ctx.sampleRate);
    return await new Promise((resolve) => {
      const finish = async () => {
        node.port.onmessage = null;
        src.disconnect(); node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const rate = ctx.sampleRate;
        await ctx.close();
        URL.revokeObjectURL(url);
        const all = new Float32Array(n);
        let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
        resolve(await to16k(all, rate));
      };
      stopFn = finish;
      node.port.onmessage = (e) => {
        const c = e.data; chunks.push(c); n += c.length;
        let s = 0; for (let i = 0; i < c.length; i++) s += c[i] * c[i];
        onLevel && onLevel(10 * Math.log10(s / c.length + 1e-10), Math.max(0, (total - n) / ctx.sampleRate));
        if (n >= total) finish();
      };
      // keep the node in the rendered graph (some browsers only pull nodes connected to the output)
      const mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    });
  })();
  return { promise, stop: () => stopFn() };
}

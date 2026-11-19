"""Generate synthetic pump/motor recordings for testing and demos.

The audio is SIMULATED (clearly labelled in file names and docs). It models a 4-pole induction motor
driving a centrifugal pump at ~1470 rpm: shaft-rate harmonics, 100 Hz electrical hum, impeller blade-pass
tone, broadband flow noise, slow load modulation and farm background noise.
Faults are injected using the textbook signatures used in vibration analysis:
  bearing     - periodic impacts at the outer-race defect frequency exciting a ~3.5 kHz resonance
  imbalance   - strong 1x shaft-rate component (plus 2x for misalignment / looseness)
  cavitation  - random bursts of broadband high-frequency noise (collapsing vapour bubbles)
  electrical  - stronger 50 Hz-multiple hum lines (supply imbalance / winding issue)
Usage: python -I ml/make_demo_audio.py <out_dir>
"""
import sys, os, wave
import numpy as np

SR = 16000
DUR = 10.0


def write_wav(path, x):
    x = np.clip(x, -1, 1)
    pcm = (x * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def colored_noise(rng, n, slope):
    """Noise with a 1/f^slope power spectrum."""
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR); f[0] = f[1]
    X /= f ** (slope / 2)
    x = np.fft.irfft(X, n)
    return x / (np.std(x) + 1e-12)


def bandpass_noise(rng, n, lo, hi):
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    X[(f < lo) | (f > hi)] = 0
    x = np.fft.irfft(X, n)
    return x / (np.std(x) + 1e-12)


def machine(rng, fault=None, severity=1.0, background=0.0):
    n = int(SR * DUR)
    t = np.arange(n) / SR
    rot = 24.5 * (1 + rng.uniform(-0.004, 0.004))          # shaft rate (Hz)
    load = 1 + 0.05 * np.sin(2 * np.pi * 0.3 * t + rng.uniform(0, 6.28))
    x = np.zeros(n)
    amps = {1: 0.10, 2: 0.05, 3: 0.03, 4: 0.02, 5: 0.015, 6: 0.01}
    for h, a in amps.items():
        x += a * np.sin(2 * np.pi * h * rot * t + rng.uniform(0, 6.28))
    for h, a in {100: 0.06, 200: 0.025, 300: 0.012}.items():          # electrical hum
        x += a * np.sin(2 * np.pi * h * t + rng.uniform(0, 6.28))
    bpf = 6 * rot                                                       # 6-vane impeller
    x += 0.05 * load * np.sin(2 * np.pi * bpf * t + rng.uniform(0, 6.28))
    x += 0.025 * load * np.sin(2 * np.pi * 2 * bpf * t + rng.uniform(0, 6.28))
    x += 0.06 * load * colored_noise(rng, n, 1.0)                       # flow / fan noise
    x += 0.012 * bandpass_noise(rng, n, 1500, 6000)                     # healthy bearing hiss

    if fault == "bearing":
        bpfo = 3.58 * rot
        imp = np.zeros(n)
        k = 0.0
        while k < n:
            imp[int(k)] = rng.uniform(0.6, 1.0)
            k += SR / bpfo * (1 + rng.uniform(-0.01, 0.01))
        tt = np.arange(int(0.006 * SR)) / SR
        ring = np.exp(-tt * 900) * np.sin(2 * np.pi * 3500 * tt)
        x += 0.35 * severity * np.convolve(imp, ring)[:n]
        x += 0.02 * severity * bandpass_noise(rng, n, 2500, 7000)
    elif fault == "imbalance":
        # imbalance raises 1x; misalignment raises 2x; mechanical looseness adds a series of shaft harmonics
        x += 0.30 * severity * np.sin(2 * np.pi * rot * t + rng.uniform(0, 6.28))
        x += 0.12 * severity * np.sin(2 * np.pi * 2 * rot * t + rng.uniform(0, 6.28))
        for h in range(3, 11):
            x += 0.04 * severity / (h - 2) ** 0.5 * np.sin(2 * np.pi * h * rot * t + rng.uniform(0, 6.28))
        x *= 1 + 0.15 * severity * np.sin(2 * np.pi * rot * t)
    elif fault == "cavitation":
        env = np.zeros(n)
        for _ in range(int(60 * severity)):
            c = rng.integers(0, n); w = int(rng.uniform(0.01, 0.05) * SR)
            env[max(0, c - w):c + w] += np.hanning(len(env[max(0, c - w):c + w])) * rng.uniform(0.5, 1)
        x += 0.10 * severity * (0.4 + env) * bandpass_noise(rng, n, 800, 7500)
    elif fault == "electrical":
        for h, a in {50: 0.05, 100: 0.16, 150: 0.05, 200: 0.08, 300: 0.05}.items():
            x += a * severity * np.sin(2 * np.pi * h * t + rng.uniform(0, 6.28))

    if background > 0:                                                   # wind + birds
        x += background * 0.04 * colored_noise(rng, n, 2.0)
        for _ in range(3):
            c = rng.integers(0, n - SR // 4); tt = np.arange(SR // 8) / SR
            chirp = np.sin(2 * np.pi * (3000 + 4000 * tt) * tt) * np.hanning(len(tt))
            x[c:c + len(tt)] += background * 0.03 * chirp
    # mild phone microphone response: high-pass around 80 Hz
    X = np.fft.rfft(x); f = np.fft.rfftfreq(n, 1 / SR)
    X *= 1 / np.sqrt(1 + (80 / np.maximum(f, 1)) ** 4)
    x = np.fft.irfft(X, n)
    return 0.25 * x / (np.max(np.abs(x)) + 1e-9)


def main(out):
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(2026)
    files = [
        ("healthy_enrol_1", None, 1.0, 0.0), ("healthy_enrol_2", None, 1.0, 0.3), ("healthy_enrol_3", None, 1.0, 0.0),
        ("healthy_check", None, 1.0, 0.2), ("healthy_check_noisy", None, 1.0, 0.8),
        ("fault_bearing_early", "bearing", 0.10, 0.0), ("fault_bearing_severe", "bearing", 1.0, 0.0),
        ("fault_imbalance", "imbalance", 1.0, 0.0), ("fault_cavitation", "cavitation", 1.0, 0.0),
        ("fault_electrical", "electrical", 1.0, 0.0),
    ]
    for name, fault, sev, bg in files:
        write_wav(os.path.join(out, f"SIMULATED_{name}.wav"), machine(rng, fault, sev, bg))
        print("wrote", name)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "samples")

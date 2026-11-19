"""Demo fleet for the dashboard. Every machine is flagged simulated=1, so the dashboard labels it SIMULATED.

Seeded at startup when the database is empty (Render's free plan resets the database on restart).
Disable with MOTORPULSE_SEED=0.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

DEVICE = "demo-seed"
MODEL = "mp-fp-1.0"

# (name, type, location, story) — story decides how health evolves over six weeks
FLEET = [
    ("Well pump – Patil farm", "submersible", "Shirpur", "bearing"),
    ("Canal lift pump", "surface_pump", "Thalner", "cavitation"),
    ("Borewell motor 2", "submersible", "Dondaicha", "early_bearing"),
    ("Drip line pump", "surface_pump", "Shindkheda", "imbalance"),
    ("Village water supply", "submersible", "Boradi", "electrical"),
    ("Flour mill motor", "mill", "Nardana", "healthy"),
    ("Orchard pump", "surface_pump", "Shirpur", "healthy"),
    ("Sugarcane field pump", "surface_pump", "Arthe", "healthy"),
    ("Dairy cooperative motor", "motor", "Thalner", "healthy"),
    ("Community borewell", "submersible", "Wadi", "healthy"),
    ("Farm pond pump", "surface_pump", "Dondaicha", "recovered"),
    ("New tubewell", "submersible", "Shirpur", "unchecked"),
]


def _healths(story: str, n: int, rng: random.Random) -> list[tuple[int, str | None, float | None]]:
    """Return (health, top_fault, confidence) per check, oldest first."""
    out = []
    for i in range(n):
        f = i / max(1, n - 1)                     # 0 -> 1 over the six weeks
        h, fault, conf = 92 + rng.uniform(-3, 3), None, None
        if story == "bearing":
            h = 93 - 70 * f ** 2.2; fault, conf = ("bearing", round(0.55 + 0.4 * f, 2)) if h < 75 else (None, None)
        elif story == "cavitation":
            h = 90 - 55 * f ** 3; fault, conf = ("cavitation", round(0.6 + 0.3 * f, 2)) if h < 75 else (None, None)
        elif story == "early_bearing":
            h = 94 - 30 * f ** 2; fault = None
        elif story == "imbalance":
            h = 91 - 28 * f ** 1.5; fault, conf = ("imbalance", 0.62) if h < 75 else (None, None)
        elif story == "electrical":
            h = 89 - 22 * f; fault, conf = ("electrical", 0.71) if h < 75 else (None, None)
        elif story == "recovered":                 # fault found, repaired, healthy again
            h = 92 - 40 * (1 - abs(2 * f - 1.2)) if 0.35 < f < 0.85 else 92
            fault, conf = ("imbalance", 0.8) if h < 75 else (None, None)
        h = int(max(0, min(100, round(h + rng.uniform(-2, 2)))))
        out.append((h, fault, conf))
    return out


def _severity(h: int, fault: str | None, conf: float | None) -> str:
    if h < 50 or (h < 75 and fault in ("bearing", "cavitation") and (conf or 0) >= 0.7):
        return "red"
    return "yellow" if h < 75 else "green"


def seed(con) -> int:
    rng = random.Random(2026)
    now = datetime.now(timezone.utc)
    n_checks = 0
    for idx, (name, typ, loc, story) in enumerate(FLEET):
        mid = f"demo-{idx + 1:02d}"
        first = (now - timedelta(days=45)).isoformat()
        con.execute(
            "INSERT OR IGNORE INTO machines(id, device_id, name, type, location, simulated, first_seen, last_seen) VALUES (?,?,?,?,?,1,?,?)",
            (mid, DEVICE, name, typ, loc, first, now.isoformat()))
        if story == "unchecked":
            continue
        n = rng.randint(6, 9)
        series = _healths(story, n, rng)
        hist = []
        for i, (h, fault, conf) in enumerate(series):
            ts = now - timedelta(days=42 * (1 - i / (n - 1)), hours=rng.uniform(0, 8))
            hist.append(h)
            ref = sum(hist[:3]) / min(3, len(hist))
            trend = len(hist) >= 3 and h < ref - 12
            sev = _severity(h, fault, conf)
            if sev == "green" and trend:
                sev = "yellow"
            if sev != "green" and fault is None and h < 75:
                fault = "unknown"
            con.execute(
                """INSERT OR IGNORE INTO checks(id, machine_id, ts, health, severity, z, top_fault, fault_confidence,
                   trend_alarm, model_version, analysis_ms, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (f"{mid}-c{i:02d}", mid, ts.isoformat(), h, sev, None, fault, conf, int(trend), MODEL,
                 rng.randint(40, 95), now.isoformat()))
            n_checks += 1
    return n_checks

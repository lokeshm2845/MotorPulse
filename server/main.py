"""MotorPulse sync API + fleet dashboard.

Receives check RESULTS (never audio) from phones in idempotent batches, stores them, and serves a fleet
dashboard for FPOs / panchayats / workshops. Also serves the phone app at /app so the whole prototype runs
from one command:  uvicorn server.main:app --host 0.0.0.0 --port 8000
SQLite is used for the prototype; the schema maps 1:1 to PostgreSQL + TimescaleDB for production.
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT.parent / "app"
DB_PATH = os.environ.get("MOTORPULSE_DB", str(ROOT / "motorpulse.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
  location TEXT, simulated INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id), ts TEXT NOT NULL,
  health INTEGER NOT NULL, severity TEXT NOT NULL, z REAL, top_fault TEXT, fault_confidence REAL,
  trend_alarm INTEGER NOT NULL DEFAULT 0, model_version TEXT, analysis_ms INTEGER, received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_machine_ts ON checks(machine_id, ts);
"""


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db() -> None:
    with db() as con:
        con.executescript(SCHEMA)
        # demo fleet (flagged SIMULATED) so a fresh deployment's dashboard is not empty
        if os.environ.get("MOTORPULSE_SEED", "1") == "1" and not con.execute("SELECT 1 FROM machines LIMIT 1").fetchone():
            from server.seed import seed
            seed(con)


class MachineIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=80)
    type: str = Field(max_length=32)
    location: str = Field(default="", max_length=120)
    simulated: bool = False


class CheckIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    machine_id: str = Field(min_length=1, max_length=64)
    ts: datetime
    health: int = Field(ge=0, le=100)
    severity: Literal["green", "yellow", "red"]
    z: Optional[float] = None
    top_fault: Optional[Literal["bearing", "cavitation", "imbalance", "electrical", "unknown"]] = None
    fault_confidence: Optional[float] = Field(default=None, ge=0, le=1)
    trend_alarm: bool = False
    model_version: Optional[str] = Field(default=None, max_length=32)
    analysis_ms: Optional[int] = Field(default=None, ge=0)


class BatchIn(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    machines: list[MachineIn] = Field(default_factory=list, max_length=500)
    checks: list[CheckIn] = Field(max_length=2000)


app = FastAPI(title="MotorPulse API", version="1.0.0",
              description="Sync and fleet API for MotorPulse. Receives check results only; audio never leaves the phone.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
init_db()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/health")
def health():
    return {"status": "ok"}


# ---------- live updates (Server-Sent Events) ----------
_listeners: set[asyncio.Queue] = set()


def _publish(event: dict) -> None:
    for q in list(_listeners):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


@app.get("/v1/stream")
async def stream(request: Request):
    """Push a 'checks' event to dashboards the moment a phone syncs new results."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _listeners.add(q)

    async def gen():
        try:
            yield "retry: 5000\nevent: hello\ndata: {}\n\n"
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"event: checks\ndata: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"          # keeps proxies (e.g. Render) from closing the stream
        finally:
            _listeners.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/v1/checks/batch")
async def checks_batch(batch: BatchIn):
    """Idempotent: re-sending the same check ids is safe (phones retry when the network drops)."""
    known = {m.id for m in batch.machines}
    accepted = duplicates = 0
    fresh = []
    with db() as con:
        for m in batch.machines:
            con.execute(
                """INSERT INTO machines(id, device_id, name, type, location, simulated, first_seen, last_seen)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type,
                   location=excluded.location, last_seen=excluded.last_seen""",
                (m.id, batch.device_id, m.name, m.type, m.location, int(m.simulated), now(), now()))
        for c in batch.checks:
            if c.machine_id not in known and not con.execute("SELECT 1 FROM machines WHERE id=?", (c.machine_id,)).fetchone():
                raise HTTPException(422, f"unknown machine {c.machine_id}")
            cur = con.execute(
                """INSERT OR IGNORE INTO checks(id, machine_id, ts, health, severity, z, top_fault, fault_confidence,
                   trend_alarm, model_version, analysis_ms, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (c.id, c.machine_id, c.ts.isoformat(), c.health, c.severity, c.z, c.top_fault, c.fault_confidence,
                 int(c.trend_alarm), c.model_version, c.analysis_ms, now()))
            if cur.rowcount:
                accepted += 1
                name = con.execute("SELECT name FROM machines WHERE id=?", (c.machine_id,)).fetchone()["name"]
                fresh.append({"machine_id": c.machine_id, "name": name, "health": c.health, "severity": c.severity,
                              "top_fault": c.top_fault, "ts": c.ts.isoformat()})
            else:
                duplicates += 1
    if fresh:
        _publish({"checks": fresh})
    return {"accepted": accepted, "duplicates": duplicates}


@app.get("/v1/fleet/summary")
def fleet_summary():
    with db() as con:
        rows = con.execute(
            """SELECT m.*, c.ts AS last_ts, c.health, c.severity, c.top_fault, c.fault_confidence, c.trend_alarm,
                      (SELECT COUNT(*) FROM checks x WHERE x.machine_id = m.id) AS n_checks
               FROM machines m
               LEFT JOIN checks c ON c.id = (SELECT id FROM checks y WHERE y.machine_id = m.id ORDER BY ts DESC LIMIT 1)
               ORDER BY CASE c.severity WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 WHEN 'green' THEN 2 ELSE 3 END,
                        c.health, m.name""").fetchall()
        machines = [dict(r) for r in rows]
        for m in machines:   # last 12 health scores, oldest first, for sparklines
            m["recent"] = [r["health"] for r in con.execute(
                "SELECT health FROM (SELECT health, ts FROM checks WHERE machine_id=? ORDER BY ts DESC LIMIT 12) ORDER BY ts",
                (m["id"],)).fetchall()]
    counts = {s: sum(1 for m in machines if m["severity"] == s) for s in ("red", "yellow", "green")}
    counts["unchecked"] = sum(1 for m in machines if m["severity"] is None)
    checked = [m["health"] for m in machines if m["health"] is not None]
    return {"counts": counts, "total": len(machines), "avg_health": round(sum(checked) / len(checked)) if checked else None,
            "server_time": now(), "machines": machines}


@app.get("/v1/activity")
def activity(limit: int = 12):
    """Latest checks across the fleet (newest first)."""
    with db() as con:
        rows = con.execute(
            """SELECT c.id, c.machine_id, m.name, m.location, m.simulated, c.ts, c.health, c.severity, c.top_fault
               FROM checks c JOIN machines m ON m.id = c.machine_id ORDER BY c.ts DESC LIMIT ?""", (min(limit, 100),)).fetchall()
    return {"items": [dict(r) for r in rows]}


@app.get("/v1/machines/{machine_id}/checks")
def machine_checks(machine_id: str, limit: int = 100):
    with db() as con:
        m = con.execute("SELECT * FROM machines WHERE id=?", (machine_id,)).fetchone()
        if not m:
            raise HTTPException(404, "machine not found")
        cs = con.execute("SELECT * FROM checks WHERE machine_id=? ORDER BY ts DESC LIMIT ?", (machine_id, min(limit, 1000))).fetchall()
    return {"machine": dict(m), "checks": [dict(c) for c in cs]}


@app.get("/", include_in_schema=False)
def root():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/dashboard", include_in_schema=False)
def dashboard():
    return FileResponse(ROOT / "static" / "dashboard.html")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(APP_DIR / "icons" / "favicon.ico")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.mount("/icons", StaticFiles(directory=APP_DIR / "icons"), name="icons")
if APP_DIR.exists():
    app.mount("/app", StaticFiles(directory=APP_DIR, html=True), name="app")

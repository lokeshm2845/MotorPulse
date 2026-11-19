// Outbox sync: unsynced check results (never audio) are sent in batches when a network is available.
import { machines, checks, getDeviceId } from "./store.js";
import { DEFAULT_SERVER } from "./config.js";

export function serverUrl() {
  try {
    const s = localStorage.getItem("mp_server");
    if (s !== null) return s.replace(/\/$/, "");
  } catch {}
  // served by the MotorPulse server itself (/app): sync to the same origin; hosted elsewhere: default server
  if (location.pathname.startsWith("/app")) return location.origin;
  return location.hostname === "localhost" || location.protocol === "file:" ? "" : DEFAULT_SERVER;
}
export function setServerUrl(u) { try { localStorage.setItem("mp_server", (u || "").trim()); } catch {} }

export async function syncNow() {
  const url = serverUrl();
  if (!url || !navigator.onLine) return { sent: 0, skipped: true };
  const pending = await checks.unsynced();
  if (!pending.length) return { sent: 0 };
  const ms = await machines.all();
  const used = new Set(pending.map((c) => c.machineId));
  const body = {
    device_id: getDeviceId(),
    machines: ms.filter((m) => used.has(m.id)).map((m) => ({ id: m.id, name: m.name, type: m.type, location: m.location || "", simulated: !!m.demo })),
    checks: pending.map((c) => ({
      id: c.id, machine_id: c.machineId, ts: new Date(c.ts).toISOString(), health: c.health, severity: c.severity,
      z: c.z, top_fault: c.hints?.[0]?.id ?? null, fault_confidence: c.hints?.[0]?.confidence ?? null,
      trend_alarm: !!c.trendAlarm, model_version: c.modelVersion, analysis_ms: Math.round(c.ms || 0),
    })),
  };
  const r = await fetch(url + "/v1/checks/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("sync failed " + r.status);
  await checks.markSynced(pending.map((c) => c.id));
  return { sent: pending.length };
}

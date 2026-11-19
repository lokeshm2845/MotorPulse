import { t, setLang, getLang, LANGS, SPEECH_LANG } from "./i18n.js";
import { machines, checks, uid } from "./store.js";
import { recordMic, decodeFile, to16k } from "./audio.js";
import { analyze, qualityGate, enrol, runCheck, MODEL_VERSION } from "./engine/index.js";
import { decodeWav } from "./engine/wav.js";
import { SR } from "./engine/dsp.js";
import { syncNow, serverUrl, setServerUrl } from "./sync.js";

const view = document.getElementById("view");
const render = (...nodes) => view.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
const ENROL_CLIPS = 3;
const SAMPLES = [
  ["healthy_check", "Healthy"], ["healthy_check_noisy", "Healthy + farm noise"], ["fault_bearing_early", "Bearing wear (early)"],
  ["fault_bearing_severe", "Bearing wear (severe)"], ["fault_imbalance", "Imbalance / looseness"], ["fault_cavitation", "Cavitation / dry run"],
  ["fault_electrical", "Electrical hum"],
];
const SEV_COLOR = { green: "#14825F", yellow: "#F5A524", red: "#E5484D" };

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const svgNS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("show"), 2800);
}
const fmtDate = (ts) => new Date(ts).toLocaleString(getLang() === "en" ? "en-IN" : getLang() + "-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const typeName = (m) => t("t_" + m.type);
const causeId = (c) => c.hints?.[0]?.id || (c.severity !== "green" ? "unknown" : null);

function adviceText(c) {
  if (c.severity === "green") return t("a_green");
  const id = causeId(c);
  return t("a_" + id) + " " + t(c.severity === "red" ? "a_red_extra" : "a_yellow_extra");
}
function sayText(c, m) {
  const cause = causeId(c);
  return t("say_" + c.severity, { name: m.name, h: c.health, cause: cause ? t("f_" + cause) : "", advice: adviceText(c) });
}
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const want = SPEECH_LANG[getLang()];
  const vs = speechSynthesis.getVoices();
  const v = vs.find((x) => x.lang === want) || vs.find((x) => x.lang.startsWith(want.slice(0, 2))) ||
    (getLang() === "mr" ? vs.find((x) => x.lang.startsWith("hi")) : null);
  if (v) u.voice = v;
  u.lang = v ? v.lang : want; u.rate = 0.95;
  speechSynthesis.speak(u);
}
const voiceOn = () => { try { return localStorage.getItem("mp_voice") !== "0"; } catch { return true; } };

// ---------- icons ----------
const ICON = {
  pump: '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M4 9h3V7h2v2h2a5 5 0 0 1 9.9 1H22v4h-1.1A5 5 0 0 1 11 15H9v2H7v-2H4a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2Zm12 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2Z"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3Zm13.5 2A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7l-6.7 3.4a3 3 0 1 0 0 3.2L15 17a3 3 0 1 0 3-1Z"/></svg>',
};

function sevPill(c) {
  if (!c) return h("span", { class: "pill grey" }, t("never"));
  return h("span", { class: "pill " + c.severity }, h("span", { class: "dot" }), `${t("sev_" + c.severity)} · ${c.health}`);
}

function ring(health, sev) {
  const r = 62, c = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, health / 100));
  return s("svg", { viewBox: "0 0 150 150", class: "ring", role: "img", "aria-label": `${t("health")} ${health}/100` },
    s("circle", { cx: 75, cy: 75, r, fill: "none", stroke: "rgba(0,0,0,.08)", "stroke-width": 12 }),
    s("circle", { cx: 75, cy: 75, r, fill: "none", stroke: SEV_COLOR[sev], "stroke-width": 12, "stroke-linecap": "round",
      "stroke-dasharray": `${c * frac} ${c}`, transform: "rotate(-90 75 75)" }),
    s("text", { x: 75, y: 82, "text-anchor": "middle", "font-size": 40, fill: "#1B2420" }, String(health)),
    s("text", { x: 75, y: 104, "text-anchor": "middle", "font-size": 13, fill: "#5B6B66" }, t("health")));
}

function trendChart(list) {
  const W = 320, H = 130, pl = 28, pr = 8, pt = 8, pb = 18;
  const y = (v) => pt + (1 - v / 100) * (H - pt - pb);
  const n = list.length;
  const x = (i) => pl + (n === 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (n - 1));
  const g = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": t("history") });
  g.append(s("rect", { x: pl, y: y(100), width: W - pl - pr, height: y(75) - y(100), fill: "#E6F4EE" }));
  g.append(s("rect", { x: pl, y: y(75), width: W - pl - pr, height: y(50) - y(75), fill: "#FDF0D5" }));
  g.append(s("rect", { x: pl, y: y(50), width: W - pl - pr, height: y(0) - y(50), fill: "#FBE0E1" }));
  for (const v of [0, 50, 75, 100]) g.append(s("text", { x: pl - 4, y: y(v) + 4, "text-anchor": "end", "font-size": 10, fill: "#5B6B66" }, String(v)));
  if (n > 1) g.append(s("polyline", { points: list.map((c, i) => `${x(i)},${y(c.health)}`).join(" "), fill: "none", stroke: "#0B3D2E", "stroke-width": 2 }));
  list.forEach((c, i) => g.append(s("circle", { cx: x(i), cy: y(c.health), r: 4.5, fill: SEV_COLOR[c.severity], stroke: "#fff", "stroke-width": 1.5 })));
  return g;
}

// ---------- audio sources ----------
async function loadSample(name) {
  const r = await fetch(`samples/SIMULATED_${name}.wav`);
  if (!r.ok) throw new Error("sample missing");
  const { rate, samples } = decodeWav(await r.arrayBuffer());
  return rate === SR ? samples : to16k(samples, rate);
}

// ---------- screens ----------
async function home() {
  const ms = await machines.all();
  const rows = [];
  for (const m of ms) {
    const cs = await checks.byMachine(m.id);
    const last = cs[cs.length - 1];
    rows.push(h("a", { class: "card machine", href: `#/m/${m.id}` },
      h("span", { class: "ic", html: ICON.pump }),
      h("span", { class: "meta" },
        h("div", { class: "nm" }, m.name, " ", m.demo ? h("span", { class: "badge" }, t("sim_badge")) : null),
        h("div", { class: "muted small" }, typeName(m), m.location ? " · " + m.location : "", last ? " · " + fmtDate(last.ts) : ""),
        h("div", { style: "margin-top:6px" }, m.model ? sevPill(last) : h("span", { class: "pill grey" }, t("not_enrolled"))))));
  }
  const hasDemo = ms.some((m) => m.demo);
  render(
    h("h1", {}, t("tagline")),
    h("h2", {}, t("my_machines")),
    ...(rows.length ? rows : [h("p", { class: "muted" }, t("no_machines"))]),
    h("div", { style: "margin-top:18px" },
      h("a", { class: "btn primary", href: "#/add" }, "+ " + t("add_machine")),
      hasDemo ? null : h("button", { class: "btn secondary", onclick: createDemo }, t("try_demo"))),
    hasDemo ? null : h("p", { class: "muted small", style: "text-align:center" }, t("demo_note")),
    h("p", { class: "muted small", style: "text-align:center;margin-top:18px" }, "🔒 " + t("privacy")),
  );
}

async function createDemo() {
  render(h("div", { class: "spinner" }), h("p", { class: "muted", style: "text-align:center" }, t("analysing")));
  const clips = [];
  for (let i = 1; i <= ENROL_CLIPS; i++) clips.push(analyze(await loadSample(`healthy_enrol_${i}`)));
  const m = { id: uid(), name: "Demo pump", type: "surface_pump", location: "Shirpur", demo: true, createdAt: Date.now(),
    enrolClips: clips.map((c) => ({ windows: c.windows, summary: c.summary })), model: enrol(clips) };
  await machines.put(m);
  // seed three weeks of healthy history so the trend chart has context
  const prev = [];
  for (const [i, name] of ["healthy_check", "healthy_check_noisy", "healthy_check"].entries()) {
    const r = runCheck(m.model, await loadSample(name), prev);
    prev.push(r.health);
    await checks.put(checkRecord(m, r, Date.now() - (3 - i) * 7 * 86400000));
  }
  location.hash = `#/m/${m.id}`;
}

function checkRecord(m, r, ts = Date.now()) {
  return { id: uid(), machineId: m.id, ts, health: r.health, severity: r.severity, z: r.z, hints: r.hints, trendAlarm: r.trendAlarm,
    ms: r.ms, modelVersion: r.modelVersion || MODEL_VERSION, synced: false };
}

function addForm() {
  const name = h("input", { id: "f-name", required: true, maxlength: 40, placeholder: "e.g. Well pump" });
  const type = h("select", { id: "f-type" }, ...["surface_pump", "submersible", "motor", "mill", "other"].map((k) => h("option", { value: k }, t("t_" + k))));
  const loc = h("input", { id: "f-loc", maxlength: 60 });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    if (!name.value.trim()) { name.focus(); return; }
    const m = { id: uid(), name: name.value.trim(), type: type.value, location: loc.value.trim(), createdAt: Date.now(), enrolClips: [], model: null };
    await machines.put(m);
    location.hash = `#/m/${m.id}`;
  } },
  h("label", { for: "f-name" }, t("name")), name,
  h("label", { for: "f-type" }, t("type")), type,
  h("label", { for: "f-loc" }, t("location")), loc,
  h("div", { style: "margin-top:22px" }, h("button", { class: "btn primary", type: "submit" }, t("save")), h("a", { class: "btn ghost", href: "#/" }, t("cancel"))));
  render(h("h1", {}, t("add_machine")), form);
  name.focus();
}

async function machinePage(id) {
  const m = await machines.get(id);
  if (!m) { location.hash = "#/"; return; }
  const cs = await checks.byMachine(id);
  const last = cs[cs.length - 1];
  const n = (m.enrolClips || []).length;
  const head = [
    h("a", { class: "btn ghost", href: "#/", style: "justify-content:flex-start;padding-left:0" }, "← " + t("back")),
    h("h1", {}, m.name, " ", m.demo ? h("span", { class: "badge" }, t("sim_badge")) : null),
    h("p", { class: "muted" }, typeName(m), m.location ? " · " + m.location : ""),
  ];
  if (!m.model) {
    render(...head,
      h("div", { class: "card tint" }, h("p", { style: "font-weight:700" }, t("enrol_needed")), h("p", { class: "muted" }, t("enrol_tip")),
        h("div", { class: "steps" }, ...[0, 1, 2].map((i) => h("span", { class: i < n ? "on" : "" }))),
        h("p", { class: "muted small" }, t("enrol_step", { n: n + 1 }))),
      h("a", { class: "btn primary", href: `#/rec/${id}/enrol` }, t("enrol_title")),
      h("button", { class: "btn danger", onclick: () => removeMachine(m) }, t("delete_m")));
    return;
  }
  const status = last
    ? h("a", { class: `hero ${last.severity}`, href: `#/r/${last.id}`, style: "display:block;text-decoration:none;color:inherit" },
        ring(last.health, last.severity), h("div", { class: "sev" }, t("sev_" + last.severity)),
        h("div", { class: "muted small" }, `${t("last")}: ${fmtDate(last.ts)}`))
    : h("div", { class: "card tint" }, h("p", {}, t("no_checks")));
  render(...head, status,
    h("div", { style: "margin-top:14px" }, h("a", { class: "btn primary", href: `#/rec/${id}/check` }, h("span", { html: ICON.mic.replace(/40/g, "26") }), t("check_now"))),
    cs.length ? h("h2", {}, t("history")) : null,
    cs.length ? h("div", { class: "card" }, trendChart(cs.slice(-12)),
      h("ul", { class: "hist" }, ...cs.slice().reverse().slice(0, 15).map((c) => h("li", {}, h("a", { href: `#/r/${c.id}` },
        h("span", {}, h("div", {}, fmtDate(c.ts)), h("div", { class: "muted small" }, causeId(c) ? t("f_" + causeId(c)) : "")),
        sevPill(c)))))) : null,
    h("a", { class: "btn ghost", href: `#/rec/${id}/enrol` }, t("re_enrol")),
    h("button", { class: "btn danger", onclick: () => removeMachine(m) }, t("delete_m")));
}

async function removeMachine(m) {
  if (!confirm(t("confirm_delete"))) return;
  await machines.remove(m.id);
  location.hash = "#/";
}

async function recordPage(id, mode) {
  const m = await machines.get(id);
  if (!m) { location.hash = "#/"; return; }
  if (mode === "enrol" && m.model) { m.model = null; m.enrolClips = []; await machines.put(m); }
  const n = (m.enrolClips || []).length;
  const meter = h("i"), count = h("div", { class: "count", "aria-live": "polite" });
  const msg = h("div", { "aria-live": "assertive" });
  let rec = null;
  const btn = h("button", { class: "rec", type: "button", html: `${ICON.mic}<span>${t("start")}</span>` });
  btn.addEventListener("click", async () => {
    if (rec) { rec.stop(); return; }
    msg.replaceChildren();
    try {
      btn.classList.add("live"); btn.innerHTML = `${ICON.mic}<span>${t("stop")}</span>`;
      count.textContent = t("recording");
      rec = recordMic(10, (db, left) => {
        meter.style.width = Math.max(0, Math.min(100, (db + 70) * 1.6)) + "%";
        count.textContent = t("sec_left", { s: Math.ceil(left) });
      });
      const x = await rec.promise;
      rec = null;
      await process(x);
    } catch (e) {
      rec = null;
      btn.classList.remove("live"); btn.innerHTML = `${ICON.mic}<span>${t("start")}</span>`; count.textContent = "";
      msg.replaceChildren(h("div", { class: "alert" }, e && e.name === "NotAllowedError" ? t("mic_denied") : String(e.message || e)));
    }
  });
  const file = h("input", { type: "file", accept: "audio/*,.wav", class: "hidden", onchange: async (e) => {
    const f = e.target.files[0]; if (!f) return;
    await process(await decodeFile(await f.arrayBuffer()));
  } });

  async function process(x) {
    render(h("div", { class: "spinner" }), h("p", { class: "muted", style: "text-align:center" }, t("analysing")));
    await new Promise((r) => setTimeout(r, 30));
    if (mode === "enrol") {
      const q = qualityGate(x);
      if (!q.ok) return showIssue(q);
      const a = analyze(x);
      m.enrolClips = [...(m.enrolClips || []), { windows: a.windows, summary: a.summary }];
      if (m.enrolClips.length >= ENROL_CLIPS) {
        m.model = enrol(m.enrolClips);
        await machines.put(m);
        toast(t("enrol_done"));
        location.hash = `#/m/${m.id}`;
      } else {
        await machines.put(m);
        toast(t("enrol_saved", { n: m.enrolClips.length }));
        recordPage(id, mode);
      }
      return;
    }
    const prev = (await checks.byMachine(m.id)).map((c) => c.health);
    const r = runCheck(m.model, x, prev);
    if (!r.ok) return showIssue(r.quality);
    const c = checkRecord(m, r);
    await checks.put(c);
    syncNow().catch(() => {});
    location.hash = `#/r/${c.id}`;
  }
  function showIssue(q) {
    recordPage(id, mode).then(() => {
      const box = document.querySelector("[data-msg]");
      if (box) box.replaceChildren(h("div", { class: "alert" }, ...q.issues.map((i) => h("div", {}, t("q_" + i)))));
    });
  }

  const sampleList = m.demo ? h("div", {},
    h("h2", {}, t("use_sample")),
    h("div", { class: "samples" }, ...(mode === "enrol" ? [[`healthy_enrol_${Math.min(n + 1, 3)}`, "Healthy (enrolment)"]] : SAMPLES).map(([k, label]) =>
      h("button", { type: "button", onclick: async () => process(await loadSample(k)) }, h("b", {}, label), h("span", { class: "muted small" }, t("sim_badge")))))) : null;

  msg.setAttribute("data-msg", "");
  render(
    h("a", { class: "btn ghost", href: `#/m/${id}`, style: "justify-content:flex-start;padding-left:0" }, "← " + m.name),
    h("h1", {}, mode === "enrol" ? t("enrol_title") : t("check_title")),
    mode === "enrol" ? h("div", {}, h("div", { class: "steps" }, ...[0, 1, 2].map((i) => h("span", { class: i < n ? "on" : "" }))),
      h("p", { class: "muted small" }, t("enrol_step", { n: n + 1 }))) : null,
    h("div", { class: "card tint guide" },
      h("span", { html: `<svg viewBox="0 0 100 80" aria-hidden="true"><rect x="2" y="30" width="52" height="34" rx="8" fill="#14825F"/><circle cx="28" cy="47" r="10" fill="#C8E6D6"/><rect x="54" y="40" width="10" height="14" fill="#0B3D2E"/><rect x="74" y="20" width="22" height="40" rx="4" fill="#1B2420"/><rect x="77" y="25" width="16" height="28" rx="2" fill="#F5A524"/><path d="M60 26q6-6 12 0M58 18q10-10 20 0" stroke="#F5A524" stroke-width="3" fill="none"/></svg>` }),
      h("p", {}, t("guide"))),
    msg,
    h("div", { class: "rec-wrap" }, btn),
    h("div", { class: "meter" }, meter), count,
    h("button", { class: "btn secondary", type: "button", onclick: () => file.click() }, t("use_file")), file,
    sampleList,
  );
}

async function resultPage(id) {
  const c = await checks.get(id);
  if (!c) { location.hash = "#/"; return; }
  const m = await machines.get(c.machineId);
  const cid = causeId(c);
  const say = sayText(c, m);
  const report = () => t("report", { name: m.name, type: typeName(m), loc: m.location || "-", date: fmtDate(c.ts), sev: t("sev_" + c.severity), h: c.health,
    cause: cid ? t("f_" + cid) : "-", advice: adviceText(c) }) + (m.demo ? "\n(" + t("sim_badge") + ")" : "");
  render(
    h("a", { class: "btn ghost", href: `#/m/${m.id}`, style: "justify-content:flex-start;padding-left:0" }, "← " + m.name),
    h("div", { class: `hero ${c.severity}` }, ring(c.health, c.severity), h("div", { class: "sev" }, t("sev_" + c.severity)),
      h("div", { class: "muted small" }, m.name, " · ", fmtDate(c.ts))),
    c.trendAlarm ? h("div", { class: "alert" }, "📉 " + t("trend_warn")) : null,
    cid ? h("div", { class: "card" }, h("div", { class: "cause" },
      h("span", { class: "ic", style: `background:${SEV_COLOR[c.severity]}` }, "!"),
      h("div", { style: "flex:1" }, h("div", { class: "muted small" }, t("likely_cause")), h("div", { style: "font-weight:800;font-size:19px" }, t("f_" + cid)),
        c.hints?.[0] ? h("div", {}, h("div", { class: "bar" }, h("i", { style: `width:${Math.round(c.hints[0].confidence * 100)}%` })),
          h("div", { class: "muted small" }, `${t("conf")} ${Math.round(c.hints[0].confidence * 100)}%`)) : null))) : null,
    h("div", { class: "card" }, h("div", { class: "muted small" }, t("do_now")), h("p", { style: "font-weight:600" }, adviceText(c)),
      cid ? h("p", { class: "muted small" }, `${t("cost")}: ${t("c_" + cid)}`) : null),
    h("p", { class: "muted small", style: "text-align:center" }, "⚡ " + t("ms", { ms: Math.max(1, Math.round(c.ms)) })),
    h("div", { class: "row" },
      h("button", { class: "btn secondary", type: "button", onclick: () => speak(say) }, h("span", { html: ICON.speaker }), t("play")),
      h("button", { class: "btn secondary", type: "button", onclick: async () => {
        const text = report();
        if (navigator.share) { try { await navigator.share({ title: "MotorPulse", text }); return; } catch {} }
        try { await navigator.clipboard.writeText(text); toast("✓ Copied"); } catch { window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener"); }
      } }, h("span", { html: ICON.share }), t("share"))),
    h("a", { class: "btn primary", href: `#/m/${m.id}`, style: "margin-top:10px" }, t("done")));
  if (voiceOn() && sessionStorage.getItem("mp_spoken") !== id) { sessionStorage.setItem("mp_spoken", id); setTimeout(() => speak(say), 400); }
}

function settingsPage() {
  const sel = h("select", { id: "s-lang", onchange: (e) => { setLang(e.target.value); renderLangs(); settingsPage(); } },
    ...Object.entries(LANGS).map(([k, v]) => h("option", { value: k, selected: k === getLang() }, v)));
  const voice = h("input", { type: "checkbox", id: "s-voice", checked: voiceOn(), onchange: (e) => { try { localStorage.setItem("mp_voice", e.target.checked ? "1" : "0"); } catch {} } });
  const srv = h("input", { id: "s-srv", type: "url", placeholder: "https://…", value: serverUrl() });
  const status = h("p", { class: "muted small", "aria-live": "polite" });
  render(
    h("h1", {}, t("settings")),
    h("label", { for: "s-lang" }, t("language")), sel,
    h("div", { class: "card switch" }, h("label", { for: "s-voice", style: "margin:0" }, t("voice")), voice),
    h("label", { for: "s-srv" }, t("server")), srv,
    h("button", { class: "btn secondary", style: "margin-top:10px", onclick: async () => {
      setServerUrl(srv.value);
      if (!navigator.onLine) { status.textContent = t("sync_off"); return; }
      try { const r = await syncNow(); status.textContent = t("synced", { n: r.sent }); } catch (e) { status.textContent = String(e.message || e); }
    } }, t("sync_now")), status,
    h("p", { class: "muted small", style: "margin-top:24px" }, "🔒 " + t("privacy")),
    h("p", { class: "muted small" }, `MotorPulse prototype · engine ${MODEL_VERSION} · Team Vertex Victors, SVKM'S NMIMS MPSTME Shirpur`));
}

// ---------- router ----------
function renderLangs() {
  const box = document.getElementById("langs");
  const short = { en: "EN", hi: "हि", mr: "म" };
  box.replaceChildren(...Object.keys(LANGS).map((k) => h("button", { type: "button", class: k === getLang() ? "on" : "", "aria-pressed": k === getLang() ? "true" : "false",
    "aria-label": LANGS[k], onclick: () => { setLang(k); renderLangs(); route(); } }, short[k])));
  document.documentElement.lang = getLang();
}

async function route() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  const p = (location.hash || "#/").slice(2).split("/");
  try {
    if (p[0] === "add") addForm();
    else if (p[0] === "m") await machinePage(p[1]);
    else if (p[0] === "rec") await recordPage(p[1], p[2]);
    else if (p[0] === "r") await resultPage(p[1]);
    else if (p[0] === "settings") settingsPage();
    else await home();
  } catch (e) {
    console.error(e);
    render(h("div", { class: "alert" }, String(e.message || e)), h("a", { class: "btn secondary", href: "#/" }, t("back")));
  }
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
window.addEventListener("online", () => syncNow().catch(() => {}));
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredInstall = e;
  const b = document.getElementById("installBtn"); b.classList.remove("hidden");
  b.onclick = async () => { b.classList.add("hidden"); deferredInstall.prompt(); deferredInstall = null; };
});
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
if ("speechSynthesis" in window) speechSynthesis.getVoices();
renderLangs();
route();

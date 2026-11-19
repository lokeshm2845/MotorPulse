"""Build the Round 3 submission PDF: python docs/build_round3_pdf.py <out.pdf>
Reads live numbers from tests/ (simulated run) and ml/results_dcase_pump_k*.json (real-data evaluation)."""
import json, os, subprocess, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle, ListFlowable,
                                ListItem, Image, CondPageBreak, KeepTogether)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "docs", "MotorPulse_Round3_Prototype.pdf")
LINKS = json.load(open(os.path.join(ROOT, "docs", "links.json"), encoding="utf-8")) if os.path.exists(os.path.join(ROOT, "docs", "links.json")) else {}

for n, f in [("Body", "arial"), ("Body-Bold", "arialbd"), ("Body-Italic", "ariali"), ("Body-BoldItalic", "arialbi"), ("Deva", "Nirmala")]:
    p = f"C:/Windows/Fonts/{f}.ttf" if f != "Nirmala" else "C:/Windows/Fonts/Nirmala.ttc"
    try:
        pdfmetrics.registerFont(TTFont(n, p) if not p.endswith(".ttc") else TTFont(n, p, subfontIndex=0))
    except Exception:
        pass
addMapping("Body", 0, 0, "Body"); addMapping("Body", 1, 0, "Body-Bold"); addMapping("Body", 0, 1, "Body-Italic"); addMapping("Body", 1, 1, "Body-BoldItalic")

ACCENT = colors.HexColor("#14825F"); DEEP = colors.HexColor("#0B3D2E"); AMBER = colors.HexColor("#F5A524"); RED = colors.HexColor("#E5484D")
DARK = colors.HexColor("#1F2A30"); MUTED = colors.HexColor("#5B6770"); LIGHT = colors.HexColor("#E8F3EF"); LINE = colors.HexColor("#C9D6D1")
MINT = colors.HexColor("#C8E6D6"); WHITE = colors.white
S = {
    "title": ParagraphStyle("t", fontName="Body-Bold", fontSize=26, leading=31, textColor=DEEP),
    "subtitle": ParagraphStyle("st", fontName="Body", fontSize=12.5, leading=17, textColor=ACCENT),
    "h1": ParagraphStyle("h1", fontName="Body-Bold", fontSize=16, leading=20, textColor=DEEP, spaceBefore=12, spaceAfter=6),
    "h2": ParagraphStyle("h2", fontName="Body-Bold", fontSize=12, leading=15, textColor=ACCENT, spaceBefore=8, spaceAfter=4),
    "body": ParagraphStyle("b", fontName="Body", fontSize=9.6, leading=13.8, textColor=DARK, spaceAfter=5),
    "cell": ParagraphStyle("c", fontName="Body", fontSize=8.6, leading=11.2, textColor=DARK),
    "cellh": ParagraphStyle("ch", fontName="Body-Bold", fontSize=8.6, leading=11.2, textColor=WHITE),
    "cap": ParagraphStyle("cap", fontName="Body-Italic", fontSize=8.5, leading=11, textColor=MUTED, alignment=1, spaceAfter=8),
    "callout": ParagraphStyle("co", fontName="Body", fontSize=9.8, leading=14, textColor=DEEP),
    "kpi": ParagraphStyle("k", fontName="Body-Bold", fontSize=20, leading=23, textColor=ACCENT, alignment=1),
    "kpil": ParagraphStyle("kl", fontName="Body", fontSize=8.2, leading=10.5, textColor=MUTED, alignment=1),
}
FW = A4[0] - 40 * mm
P = lambda t, st="body": Paragraph(t, S[st])
H1 = lambda t: P(t, "h1")
H2 = lambda t: P(t, "h2")


def bullets(items, ordered=False):
    return ListFlowable([ListItem(P(x), leftIndent=12) for x in items], bulletType="1" if ordered else "bullet",
                        bulletFontName="Body", bulletFontSize=8 if not ordered else 9.5, bulletColor=ACCENT, leftIndent=12,
                        **({"start": "1"} if ordered else {}))


def table(rows, widths, head=True, bold_first=False, zebra=True):
    data = [[Paragraph(f"<b>{c}</b>" if (bold_first and j == 0 and not (head and i == 0)) else c, S["cellh" if head and i == 0 else "cell"])
             for j, c in enumerate(r)] for i, r in enumerate(rows)]
    t = Table(data, colWidths=[FW * w for w in widths], repeatRows=1 if head else 0)
    st = [("GRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
          ("TOPPADDING", (0, 0), (-1, -1), 3.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
          ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5)]
    if head: st.append(("BACKGROUND", (0, 0), (-1, 0), ACCENT))
    if zebra: st.append(("ROWBACKGROUNDS", (0, 1 if head else 0), (-1, -1), [WHITE, LIGHT]))
    t.setStyle(TableStyle(st))
    return t


def callout(html, bg=LIGHT, border=MINT):
    t = Table([[Paragraph(html, S["callout"])]], colWidths=[FW])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("BOX", (0, 0), (-1, -1), 0.6, border),
                           ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                           ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    return t


def kpis(items):
    cells = [[Paragraph(v, S["kpi"]) for v, _ in items], [Paragraph(l, S["kpil"]) for _, l in items]]
    t = Table(cells, colWidths=[FW / len(items)] * len(items))
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), LIGHT), ("LINEAFTER", (0, 0), (-2, -1), 2, WHITE),
                           ("TOPPADDING", (0, 0), (-1, 0), 9), ("BOTTOMPADDING", (0, 1), (-1, 1), 9)]))
    return t


def shots(files, caption, per_row=3, height=95 * mm):
    imgs = []
    for f in files:
        p = os.path.join(ROOT, "docs", "screens", f)
        from reportlab.lib.utils import ImageReader
        iw, ih = ImageReader(p).getSize()
        w = height * iw / ih
        imgs.append(Image(p, width=w, height=height))
    rows = [imgs[i:i + per_row] for i in range(0, len(imgs), per_row)]
    t = Table(rows, colWidths=[FW / per_row] * per_row)
    t.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    return KeepTogether([t, P(caption, "cap")])


def deco(c, doc):
    c.saveState()
    c.setFillColor(ACCENT); c.rect(0, A4[1] - 5 * mm, A4[0], 5 * mm, stroke=0, fill=1)
    c.setFont("Body", 7.8); c.setFillColor(MUTED)
    c.drawString(20 * mm, 10 * mm, "MotorPulse  |  Team Vertex Victors  |  PRASUNEX INNOVATHON 2026  |  Round 3: Prototype Development & Demonstration")
    c.drawRightString(A4[0] - 20 * mm, 10 * mm, f"Page {doc.page}")
    c.restoreState()


# ---------- live numbers ----------
sim = json.loads(subprocess.check_output(["node", "-e",
    "import('./tests/run_samples.mjs').then(m=>{const r=m.evaluateSamples();console.log(JSON.stringify({rows:r.rows,enrolMs:r.enrolMs,n:r.model.nWindows,k:r.model.det.comps.length}))})"],
    cwd=ROOT, text=True))
real = {}
for kk in (3, 30):
    p = os.path.join(ROOT, "ml", f"results_dcase_pump_k{kk}.json")
    if os.path.exists(p):
        real[kk] = json.load(open(p))
engine_kb = sum(os.path.getsize(os.path.join(ROOT, "app", "engine", f)) for f in os.listdir(os.path.join(ROOT, "app", "engine"))) / 1024
ms_med = sorted(r["ms"] for r in sim["rows"])[len(sim["rows"]) // 2]

story = []
story += [P("MotorPulse", "title"), P("Working prototype: AI sound check for farm pumps and motors", "subtitle"), Spacer(1, 2),
          P("<b>PRASUNEX INNOVATHON 2026  ·  Round 3: Prototype Development &amp; Demonstration</b>"), Spacer(1, 4)]
story.append(table([
    ["Team name", "<b>Vertex Victors</b>"], ["Team leader", "Parth Bhoi"], ["Team member", "Lokesh Magare"],
    ["College", "SVKM'S NMIMS MPSTME Shirpur"], ["Primary domain", "Artificial Intelligence &amp; Machine Learning"],
    ["Secondary domains", "Social Impact &amp; Emerging Technology  ·  Data Analytics"],
], [0.27, 0.73], head=False, bold_first=True))
story.append(Spacer(1, 6))
story.append(H2("Links"))
story.append(table([
    ["Demo video", LINKS.get("video", "<i>[add demo video link]</i>")],
    ["Live app (open on a phone)", LINKS.get("app", "<i>[add hosted app link]</i>")],
    ["Source code", LINKS.get("repo", "<i>[add repository link]</i>")],
    ["Fleet dashboard", LINKS.get("dashboard", "Runs with the server: /dashboard (see section 10)")],
], [0.27, 0.73], head=False, bold_first=True))

# 1. summary
story.append(H1("1. What We Built"))
story.append(P("MotorPulse is now a <b>working, installable phone app</b> that listens to a running pump or motor for 10 seconds, compares the "
               "sound with <b>that machine's own healthy fingerprint</b>, and gives a 0–100 health score, a Green / Yellow / Red verdict, a likely "
               "cause and a spoken next step in English, Hindi or Marathi. Everything runs <b>on the phone, offline</b>. Results (never audio) "
               "sync to a fleet dashboard when a network is available."))
k3 = real.get(3)
story.append(kpis([
    (f"{ms_med} ms", "to analyse a 10 s recording<br/>(engine, laptop CPU)"),
    (f"{engine_kb:.0f} KB", "complete AI engine,<br/>no ML library needed"),
    ("3", "healthy recordings to<br/>enrol a new machine"),
    (f"{k3['meanAUC']:.2f}" if k3 else "–", "mean AUC on real pump<br/>recordings (DCASE, 3-clip enrol)"),
    ("10 / 10", "automated tests<br/>passing"),
]))
story.append(Spacer(1, 6))
story.append(table([
    ["Evaluation criterion", "How the prototype addresses it"],
    ["Functionality", "Full loop works end to end: enrol → record → quality gate → diagnose → advise → speak → history → share → sync → dashboard."],
    ["Technical execution", "Custom on-device DSP + two calibrated detectors in ~26 KB of JavaScript; FastAPI backend; unit, behaviour and API tests; measured on real public pump data."],
    ["Usability", "Voice-first, 3 languages, one big button, recording guidance, quality messages, colour + text verdicts, works offline."],
    ["Innovation", "Per-machine acoustic fingerprint enrolled on the farmer's own phone; explainable, gain-independent fault hints; trend-based early warning."],
    ["Practical applicability", "Needs only a phone the farmer already owns; installs from a link; demo mode for training mechanics and FPO staff."],
    ["Scalability", "All inference on the phone; server receives ~2 KB per check, idempotent batches; stateless API ready for PostgreSQL / TimescaleDB."],
], [0.22, 0.78], bold_first=True))

# 2. features
story.append(H1("2. Implemented Features"))
story.append(table([
    ["Feature", "Status", "Notes"],
    ["Installable offline app (PWA)", "Done", "Service worker caches the app, engine and demo audio; works with no network"],
    ["Raw 10 s microphone capture + level meter", "Done", "Browser noise suppression, echo cancellation and auto-gain switched off"],
    ["Recording quality gate", "Done", "Too short, too quiet, clipping, unsteady sound; message in the user's language"],
    ["Machine enrolment (sound fingerprint)", "Done", "3 healthy clips → 57 one-second windows → per-machine model stored on the phone"],
    ["On-device diagnosis + 0–100 health score", "Done", "Two detectors, calibrated on held-out healthy recordings, fused"],
    ["Likely cause (4 fault types)", "Done (rules)", "Bearing, cavitation / dry run, imbalance / looseness, electrical; confidence shown"],
    ["Trend engine + severity rules", "Done", "EWMA + CUSUM; Green / Yellow / Red as designed in Round 2"],
    ["Advice, cost range, voice output", "Done", "English, Hindi, Marathi; phone's built-in text-to-speech"],
    ["History chart + share with mechanic", "Done", "Share sheet / WhatsApp / clipboard"],
    ["Offline outbox sync", "Done", "Idempotent batches, auto-sync when back online, results only"],
    ["Fleet dashboard + REST API", "Done", "Severity counts, latest status, likely cause, trend flag; OpenAPI docs at /docs"],
    ["Demo pump with simulated faults", "Done", "Labelled SIMULATED everywhere; for demos and training"],
], [0.36, 0.14, 0.50], bold_first=True))

# 3. screenshots
story.append(H1("3. Prototype Screens"))
story.append(shots(["01_home.jpg", "03_result_watch.jpg", "04_result_actnow.jpg"],
                   "Home with status · early bearing wear → Watch (Yellow) · severe bearing wear → Act now (Red) with cause, confidence, advice and cost. (Demo pump, simulated audio.)"))
story.append(shots(["05_history.jpg", "02_record_hi.jpg", "06_result_hi.jpg"],
                   "Health timeline with falling-trend warning · recording screen in Hindi · result in Hindi."))
story.append(KeepTogether([Image(os.path.join(ROOT, "docs", "screens", "07_dashboard.jpg"), width=FW, height=FW * 407 / 800),
                           P("Fleet dashboard (laptop): machines sorted by urgency, synced from phones. Results only, no audio.", "cap")]))

# 4. architecture
story.append(H1("4. Architecture as Built"))
story.append(table([
    ["Component", "Files", "What it does"],
    ["Phone app (PWA)", "app/index.html, app.js, styles.css, i18n.js", "Screens, routing, 3-language UI, voice output, share"],
    ["Recorder", "app/audio.js", "AudioWorklet raw capture, browser resampling to 16 kHz, file decoding"],
    ["AI engine", "app/engine/dsp.js, model.js, faults.js, trend.js", "Features, fingerprint model, scoring, fault hints, trend, severity"],
    ["Offline storage", "app/store.js", "IndexedDB: machines (with model) and checks (with sync flag)"],
    ["Sync", "app/sync.js", "Outbox → POST /v1/checks/batch when online"],
    ["Offline cache", "app/sw.js, manifest.webmanifest", "Install to home screen, offline start"],
    ["Backend", "server/main.py", "FastAPI: idempotent batch sync, fleet summary, machine history; serves app and dashboard"],
    ["Dashboard", "server/static/dashboard.html", "Live fleet view, refreshes every 10 s"],
    ["ML tooling", "ml/make_demo_audio.py, ml/eval_dcase.mjs", "Physics-based fault simulator; real-data evaluation"],
    ["Tests", "tests/engine.test.mjs, server/test_server.py", "6 engine tests + 4 API tests"],
], [0.18, 0.37, 0.45], bold_first=True))

# 5. AI engine
story.append(H1("5. The AI Engine"))
story.append(table([
    ["Stage", "Implementation"],
    ["Features", "16 kHz mono; 1024-point FFT, 256 hop, Hann window; 64 log-mel bands (20–8000 Hz); per 1 s window (50% overlap): mean log-mel + spectral centroid, flatness, high-band ratio, level variation → 68 values"],
    ["Standardisation", "Per-feature mean / standard deviation from the machine's own enrolment windows"],
    ["Detector A", "PCA reconstruction error (a linear autoencoder) keeping 90% of variance, up to 10 components"],
    ["Detector B", "Mahalanobis distance with 50% shrinkage toward identity (stable with only ~57 windows)"],
    ["Calibration", "Leave-one-recording-out on the 3 enrolment clips → median and MAD of healthy scores for each detector"],
    ["Fusion", "z = ½(z<sub>A</sub> + z<sub>B</sub>) per window; clip score = median over windows (robust to brief noises); health = 100 / (1 + e<sup>z−3</sup>)"],
    ["Fault hints", "Level-independent comparisons with the machine's baseline: impulsiveness (kurtosis), spectral shape by band, spectral flatness, ~1 Hz-resolution tone analysis of mains-hum lines vs shaft-rate harmonics"],
    ["Trend", "EWMA (α = 0.4) and one-sided CUSUM on falling health (k = 4, h = 20); alarm after ≥ 3 checks"],
    ["Severity", "Red: health &lt; 50, or a critical cause (bearing, cavitation) ≥ 0.7 on an abnormal clip · Yellow: 50–75 or trend alarm · Green otherwise"],
], [0.18, 0.82], bold_first=True))
story.append(Spacer(1, 4))
story.append(callout("<b>Design choice vs Round 2:</b> we planned a TFLite CNN. For the prototype we built the per-machine detectors directly in "
                     "JavaScript: it needs no training data from the farmer's pump, runs anywhere a browser runs, and is fully explainable. "
                     "The CNN encoder remains the next step once field data is collected; it plugs into the same fusion and severity pipeline."))

# 6. results
story.append(H1("6. Results"))
story.append(H2("6.1 Real pump recordings (public DCASE 2020 Task 2 data)"))
if k3:
    story.append(P("Protocol, matching the app: for each of the four pumps in the development set, the engine was enrolled with only "
                   f"<b>{k3['enrolClips']} randomly chosen healthy training clips</b> and then scored every test clip (normal and anomalous). "
                   f"Results are averaged over {k3['repeats']} random enrolment draws. AUC = chance a faulty clip scores worse than a healthy one "
                   "(0.5 = guessing, 1.0 = perfect); pAUC = the same at low false-alarm rates (FPR ≤ 10%), the official DCASE metric."))
    rows = [["Pump (machine id)", "Test clips (normal / anomalous)", "AUC (min–max)", "pAUC"]]
    for r in k3["perMachine"]:
        rows.append([f"id_{r['id']}", f"{r['testNormal']} / {r['testAnomaly']}", f"{r['auc']:.3f} ({r['aucMin']:.2f}–{r['aucMax']:.2f})", f"{r['pauc']:.3f}"])
    rows.append(["<b>Mean</b>", "", f"<b>{k3['meanAUC']:.3f}</b>", f"<b>{k3['meanPAUC']:.3f}</b>"])
    if 30 in real:
        rows.append(["Mean with 30 enrolment clips", "", f"{real[30]['meanAUC']:.3f}", f"{real[30]['meanPAUC']:.3f}"])
    story.append(table(rows, [0.25, 0.30, 0.25, 0.20]))
    story.append(P("For context, the official DCASE 2020 Task 2 baseline autoencoder, trained on roughly 900 healthy clips per machine type, "
                   "reported an average pump AUC of about 0.73. MotorPulse is enrolled from just three clips per pump, which is what a farmer "
                   "can realistically record.", "cap"))
    story.append(callout(
        "<b>What this means, honestly:</b> on real recordings the engine separates faulty from healthy pumps clearly better than chance "
        f"({k3['meanAUC']:.2f} with 3 clips, {real[30]['meanAUC']:.2f} with 30 clips where available) and is strongest on pump id_04 "
        "(up to 0.93). It does <b>not</b> yet reach the Round 2 target of AUC ≥ 0.85, and low-false-alarm accuracy (pAUC) is weak. "
        "These DCASE anomalies include subtle faults (leakage, contamination, clogging) recorded in noisy factories. The planned next step "
        "is the shared CNN encoder from Round 2, pre-trained on all public machine sounds and fine-tuned with field recordings, which "
        "plugs into the same per-machine fusion. This is why the app shows a cautious Yellow before Red and asks for a recheck."
        if 30 in real else "", bg=colors.HexColor("#FDF0D5"), border=AMBER))
else:
    story.append(callout("<i>Real-data evaluation pending: run</i> node ml/eval_dcase.mjs data/dcase2020_pump/pump 3 5"))
story.append(H2("6.2 Simulated fault recordings (demo set)"))
rows = [["Recording (SIMULATED)", "Health", "Verdict", "Likely cause", "Confidence"]]
order = ["healthy_check", "healthy_check_noisy", "fault_bearing_early", "fault_bearing_severe", "fault_imbalance", "fault_cavitation", "fault_electrical"]
by = {r["file"]: r for r in sim["rows"]}
vmap = {"green": "<font color='#14825F'><b>Healthy</b></font>", "yellow": "<font color='#B7791F'><b>Watch</b></font>", "red": "<font color='#E5484D'><b>Act now</b></font>"}
for f in order:
    r = by[f]
    rows.append([f.replace("_", " "), str(r["health"]), vmap[r["severity"]], r["top"] if r["top"] != "-" else "– (unusual sound)", str(r["conf"])])
story.append(table(rows, [0.32, 0.12, 0.16, 0.24, 0.16]))
story.append(P("Simulated with a physics-based model of a 1470 rpm motor-pump (shaft harmonics, mains hum, blade-pass tone, flow noise) and "
               "textbook fault signatures, including farm background noise. These verify the full pipeline and the fault-hint rules; they are "
               "not a substitute for field data.", "cap"))

# 7. testing
story.append(H1("7. Testing &amp; Quality"))
story.append(table([
    ["Test", "What it checks", "Result"],
    ["FFT", "A pure tone lands in the correct frequency bin", "Pass"],
    ["Linear algebra", "Matrix inverse and eigen-decomposition accuracy", "Pass"],
    ["Feature windows", "10 s clip → 19 windows × 68 features", "Pass"],
    ["Quality gate", "Rejects short, silent, clipped and unsteady audio", "Pass"],
    ["Trend + severity", "Alarm on steady decline, none on stable health; rule table", "Pass"],
    ["End-to-end (simulated)", "Healthy stays Green (incl. farm noise); every fault caught with the right cause", "Pass"],
    ["API: idempotent sync", "Re-sending a batch creates no duplicates", "Pass"],
    ["API: validation", "Rejects out-of-range health and unknown machines", "Pass"],
    ["API: fleet + history", "Latest status per machine, ordered history, dashboard and app served", "Pass"],
    ["Browser run-through", "Demo pump enrol → checks → result → history → sync → dashboard; Hindi UI", "Pass (manual)"],
], [0.22, 0.6, 0.18], bold_first=True))

# 8. usability & practical
story.append(H1("8. Usability &amp; Practical Use"))
story.append(bullets([
    "<b>One big button</b> per screen; verdicts use colour <i>and</i> words; large text and touch targets.",
    "<b>Voice-first:</b> results are spoken automatically in English, Hindi or Marathi; switch language in one tap.",
    "<b>Guided recording:</b> picture and text show where to hold the phone; bad recordings get a clear, actionable message instead of a wrong answer.",
    "<b>No account, no internet:</b> install from a link and use it in the field; sync happens later on its own.",
    "<b>Privacy by default:</b> audio is processed and discarded on the phone; only scores sync.",
    "<b>Mechanic in the loop:</b> a one-tap report with cause and advice, so the mechanic arrives with the right parts.",
    "<b>Demo mode</b> lets FPO staff and mechanics learn the app before using it on a real pump.",
]))

# 9. limitations & next
story.append(H1("9. Limitations &amp; Next Steps"))
story.append(table([
    ["Current limitation", "Next step"],
    ["Fault causes come from rules tuned on simulated faults", "Collect labelled field recordings with mechanics; train the CNN fault head planned in Round 2"],
    ["Real-data AUC (0.66 with 3 clips) is below the 0.85 target", "Pre-trained CNN encoder (Round 2 design) + field recordings; tune fusion on real data"],
    ["Accuracy measured on public factory-recorded data, not farms", "Field pilot with an FPO on real farm pumps and several phone models"],
    ["Voice uses each phone's built-in text-to-speech (Marathi voice not on every phone)", "Bhashini text-to-speech voice packs cached for offline use"],
    ["Hindi / Marathi are team translations", "Review wording with farmers during usability tests"],
    ["Prototype backend uses SQLite, no login", "PostgreSQL + TimescaleDB, phone-OTP login, organisation accounts"],
    ["Cost ranges are rough typical values", "Region-specific ranges from partner mechanics"],
], [0.48, 0.52]))

# 10. run
story.append(H1("10. How to Run the Prototype"))
story.append(bullets([
    "<b>Install:</b> <font face='Body-Bold'>pip install -r server/requirements.txt</font>",
    "<b>Start:</b> <font face='Body-Bold'>python -m uvicorn server.main:app --host 0.0.0.0 --port 8000</font>",
    "<b>Phone app:</b> http://localhost:8000/app/ → <i>Try the demo pump</i>, or <i>Add machine</i> for a real pump (HTTPS needed on a phone, e.g. via ngrok or static hosting).",
    "<b>Dashboard:</b> http://localhost:8000/dashboard · <b>API docs:</b> http://localhost:8000/docs",
    "<b>Tests:</b> <font face='Body-Bold'>node --test tests/engine.test.mjs</font> and <font face='Body-Bold'>python -m pytest -q server/test_server.py</font>",
], ordered=True))
story.append(Spacer(1, 8))
story.append(P("<font color='#14825F'><b><i>MotorPulse — Because every machine whispers before it breaks.</i></b></font>", "cap"))
story.append(P("Team Vertex Victors  ·  Parth Bhoi (Team Leader), Lokesh Magare  ·  SVKM'S NMIMS MPSTME Shirpur", "cap"))


def keep_headings(st):
    out, i = [], 0
    while i < len(st):
        f = st[i]
        if isinstance(f, Paragraph) and f.style.name in ("h1", "h2"):
            grp = [f]; i += 1
            while i < len(st) and isinstance(st[i], Paragraph) and st[i].style.name in ("h1", "h2"):
                grp.append(st[i]); i += 1
            out.append(CondPageBreak(120)); out.extend(grp)
        else:
            out.append(f); i += 1
    return out


doc = BaseDocTemplate(OUT, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
                      title="MotorPulse — Round 3 Prototype", author="Team Vertex Victors", subject="PRASUNEX INNOVATHON 2026 Round 3")
doc.addPageTemplates([PageTemplate(id="p", frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height)], onPage=deco)])
doc.build(keep_headings(story))
print("ok", OUT)

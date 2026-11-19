// Offline-first service worker: the whole app (including the AI engine and demo recordings) is cached on install.
const CACHE = "motorpulse-v2";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "i18n.js", "store.js", "audio.js", "sync.js", "config.js", "manifest.webmanifest",
  "engine/index.js", "engine/dsp.js", "engine/model.js", "engine/faults.js", "engine/trend.js", "engine/wav.js",
  "icons/icon-192.png", "icons/icon-512.png",
  ...["healthy_enrol_1", "healthy_enrol_2", "healthy_enrol_3", "healthy_check", "healthy_check_noisy", "fault_bearing_early",
    "fault_bearing_severe", "fault_imbalance", "fault_cavitation", "fault_electrical"].map((n) => `samples/SIMULATED_${n}.wav`),
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin || new URL(req.url).pathname.includes("/v1/")) return;
  // stale-while-revalidate: instant from cache, refreshed in the background when online
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

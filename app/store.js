// Offline storage in IndexedDB: machines (with their enrolled sound fingerprint) and checks (with a sync flag).
const DB_NAME = "motorpulse", VER = 1;
let _db;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("machines", { keyPath: "id" });
      const c = db.createObjectStore("checks", { keyPath: "id" });
      c.createIndex("machineId", "machineId");
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const machines = {
  all: () => tx("machines", "readonly", (s) => req(s.getAll())).then((a) => a.sort((x, y) => x.createdAt - y.createdAt)),
  get: (id) => tx("machines", "readonly", (s) => req(s.get(id))),
  put: (m) => tx("machines", "readwrite", (s) => req(s.put(m))),
  remove: async (id) => {
    const cs = await checks.byMachine(id);
    await tx("checks", "readwrite", (s) => Promise.all(cs.map((c) => req(s.delete(c.id)))));
    return tx("machines", "readwrite", (s) => req(s.delete(id)));
  },
};

export const checks = {
  get: (id) => tx("checks", "readonly", (s) => req(s.get(id))),
  put: (c) => tx("checks", "readwrite", (s) => req(s.put(c))),
  byMachine: (mid) => tx("checks", "readonly", (s) => req(s.index("machineId").getAll(mid))).then((a) => a.sort((x, y) => x.ts - y.ts)),
  unsynced: () => tx("checks", "readonly", (s) => req(s.getAll())).then((a) => a.filter((c) => !c.synced)),
  markSynced: (ids) => tx("checks", "readwrite", async (s) => {
    for (const id of ids) { const c = await req(s.get(id)); if (c) { c.synced = true; await req(s.put(c)); } }
  }),
};

export function getDeviceId() {
  let d = null;
  try { d = localStorage.getItem("mp_device"); if (!d) { d = uid(); localStorage.setItem("mp_device", d); } } catch { d = "anon"; }
  return d;
}

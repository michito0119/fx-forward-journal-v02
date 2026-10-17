const CACHE = "mk-forward-v02-20261015-2";
const DB_NAME = "mk-forward-journal-v02";
const DB_VERSION = 4;
const ASSETS = ["./", "./index.html", "./style.css?v=20261015-2", "./app.js?v=20261015-2", "./utils.mjs", "./oanda.mjs", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("mk-forward-v02-") && key !== CACHE).map(key => caches.delete(key))))); self.clients.claim(); });
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL("./", self.location).pathname)) return;
  if (event.request.method === "POST" && url.pathname.endsWith("/share/")) {
    event.respondWith(receiveSharedImage(event.request));
    return;
  }
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === "navigate" ? await caches.match("./index.html") : null) || Response.error()));
});

async function receiveSharedImage(request) {
  let db;
  try {
    const form = await request.formData();
    const accepted = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const files = form.getAll("image");
    if (!files.length || files.some(value => !(value instanceof File) || !accepted.has(value.type) || !value.size)) return Response.redirect(new URL("./index.html?shareError=no-image", self.location), 303);
    if (files.length > 20 || files.some(file => file.size > 25 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) return Response.redirect(new URL("./index.html?shareError=too-large", self.location), 303);
    db = await openShareDb();
    const batchId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("shareInbox", "readwrite");
      const store = tx.objectStore("shareInbox");
      const receivedAt = new Date().toISOString();
      for (const file of files) store.add({ id: `R-${crypto.randomUUID()}`, batchId, file, name: file.name || "共有画像", mime: file.type, receivedAt, status: "unassigned" });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("共有画像の保存が中断されました"));
    });
    return Response.redirect(new URL(`./index.html?shared=${batchId}`, self.location), 303);
  } catch {
    return Response.redirect(new URL("./index.html?shareError=storage", self.location), 303);
  } finally {
    db?.close();
  }
}

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ["candidates", "trades", "images", "shareInbox", "oandaRows", "oandaFiles"]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    let blocked = false;
    request.onsuccess = () => { if (blocked) request.result.close(); else { request.result.onversionchange = () => request.result.close(); resolve(request.result); } };
    request.onblocked = () => { blocked = true; reject(new Error("古いアプリ画面がデータベースを使用中です")); };
    request.onerror = () => reject(request.error);
  });
}

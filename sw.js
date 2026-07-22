// キャッシュ名にバージョンを付与（設計書 §7）。ファイル更新時は v2, v3... に上げる
const CACHE_NAME = "kids-point-app-v11";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sync.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// cache-first: キャッシュにあれば返し、なければネットワークへ
self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});

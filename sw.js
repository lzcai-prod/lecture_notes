// sw.js
// Caches the app shell so it opens with no internet connection in the
// lecture hall, but prefers a fresh copy whenever the network is reachable
// (network-first, falling back to cache when offline). This means a new
// deploy is picked up automatically the next time the app opens with
// connectivity, with no manual cache-name bump required.

const CACHE_NAME = "lecture-app-v2";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./manifest.json",
  "./vendor/pdfjs/pdf.min.mjs",
  "./vendor/pdfjs/pdf.worker.min.mjs",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell: try the network, cache what comes back,
// and only fall back to the cache when there is no connectivity. This keeps
// the app usable offline while no longer requiring a cache-name bump for
// every update to reach an already-installed PWA.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

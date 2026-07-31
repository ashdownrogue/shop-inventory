/* Cache-first app shell so the audit works with no signal in the garage. */
/* Bump on every shipped change to index.html / app.js / styles.css, or
   returning devices keep booting the previous shell from cache.
   v2: sync UI, checklist editor, multi-level undo. */
var CACHE = 'shop-inv-v2';
var CORE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'data/checklist.md',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(CORE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' }))['catch'](function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches['delete'](k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) {
        /* refresh the shell quietly in the background */
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        })['catch'](function () {});
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); })['catch'](function () {});
        }
        return res;
      })['catch'](function () {
        return caches.match('index.html');
      });
    })
  );
});

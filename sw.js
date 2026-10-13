// 離線快取：網站本體先用快取，登入與資料一律走網路。改版時把 VERSION 加 1。
var VERSION = "hydrotrack-v1";
var SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
var SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }).concat([c.add(SDK).catch(function () {})]));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && req.url !== SDK) return;             // Supabase API 不快取
  if (req.mode === "navigate" || sameOrigin) {
    // 先試網路，失敗再用快取，這樣改版後很快就會更新
    e.respondWith(fetch(req).then(function (r) { var cp = r.clone(); caches.open(VERSION).then(function (c) { c.put(req, cp); }); return r; })
      .catch(function () { return caches.match(req).then(function (m) { return m || caches.match("index.html"); }); }));
  } else {
    e.respondWith(caches.match(req).then(function (m) { return m || fetch(req).then(function (r) { var cp = r.clone(); caches.open(VERSION).then(function (c) { c.put(req, cp); }); return r; }); }));
  }
});

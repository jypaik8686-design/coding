// 망 먼저, 끊기면 저장해 둔 것. 온라인이면 고친 파일이 바로 보이고, 오프라인이면 마지막으로 받은 것이 뜬다.
// 대가: 망이 아주 느리면 첫 화면도 그만큼 느리다. 그게 문제가 되면 그때 캐시 먼저로 바꾸고 VERSION을 올려 가며 쓴다.
const VERSION = "{{앱이름}}-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== location.origin) return; // 밖으로 나가는 요청은 건드리지 않는다
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});

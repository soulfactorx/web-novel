// 서비스 워커: 항상 서버에서 최신 파일을 먼저 확인하고(network-first),
// 오프라인이거나 서버에 닿지 않을 때만 저장해 둔 사본을 쓴다.
const VERSION = 'dev'; // 배포 시 커밋 해시로 바뀐다 (.github/workflows/pages.yml)
const CACHE = 'web-novel';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' }); // 캐시돼 있어도 서버에 변경 여부를 확인
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source.postMessage({ version: VERSION });
});

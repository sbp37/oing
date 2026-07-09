// 오잉게임 서비스워커 — 설치 가능(installable) 조건만 충족시키는 최소 버전.
// 캐싱을 하지 않아서 랭킹·점수 등 Firebase 실시간 데이터에는 전혀 영향을 주지 않는다.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 아무 캐싱도 하지 않고 그대로 네트워크로 흘려보냄 (그대로 두면 브라우저 기본 동작과 동일)
self.addEventListener('fetch', (event) => {
  // 의도적으로 아무 처리도 하지 않음
});

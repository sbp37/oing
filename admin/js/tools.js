// ══════════════════════════════════════════════════════════════
//  tools.js — 🛠 관리 (2026-07 개편)
//  가끔 쓰는 "도구"를 접이식(아코디언)으로 모은다. 전부 기본 접힘.
//   · 🎁 유저에게 보내기 — rewards.js (조회 0)
//   · 🎮 게임 운영 — operations.js (열 때만 thanks/hall/version 조회)
//   · 🛡 보안 도구 / 🔴 백업·위험 — security.js (전부 버튼 클릭 시에만 조회)
//  마지막으로 연 아코디언은 localStorage로 기억(선택 편의).
// ══════════════════════════════════════════════════════════════
import { initRewardsTab } from './rewards.js';
import { initOperationsTab, loadOperations } from './operations.js';
import { initSecurityTab } from './security.js';

const LAST_ACC_KEY = 'admin_last_acc';
let opsLoaded = false;

export function initToolsTab() {
  // 바인딩은 1회 — Firestore 조회 없음 (기존 init들은 전부 버튼 바인딩만 한다)
  initRewardsTab();
  initOperationsTab();
  initSecurityTab();

  // 게임 운영 아코디언을 처음 열 때만 데이터(함께해주신 분·명예의전당·앱버전) 조회
  const opsAcc = document.getElementById('acc-ops');
  opsAcc.addEventListener('toggle', () => {
    if (opsAcc.open && !opsLoaded) { opsLoaded = true; loadOperations(); }
  });

  // 마지막으로 연 아코디언 기억 (위험 구역은 실수 방지를 위해 기억하지 않음 — 항상 접힘)
  document.querySelectorAll('#tab-tools .tool-acc').forEach(acc => {
    acc.addEventListener('toggle', () => {
      if (acc.open && acc.id !== 'acc-danger') {
        try { localStorage.setItem(LAST_ACC_KEY, acc.id); } catch {}
      }
    });
  });
  try {
    const last = localStorage.getItem(LAST_ACC_KEY);
    if (last && last !== 'acc-danger') {
      const acc = document.getElementById(last);
      if (acc) acc.open = true; // toggle 이벤트 발생 → 게임 운영이면 lazy 로드도 이때
    }
  } catch {}
}

// 관리 탭 진입 자체는 조회 0 — 데이터는 아코디언을 열거나 버튼을 눌러야만
export async function loadTools({ force = false } = {}) {
  if (force && opsLoaded && document.getElementById('acc-ops').open) loadOperations({ force: true });
}

// 배지/할 일에서 바로 진입 — 해당 아코디언을 펼치고 화면에 보이게 스크롤
export function openToolAcc(accId) {
  const acc = document.getElementById(accId);
  if (!acc) return;
  acc.open = true; // toggle 이벤트 발생 → 게임 운영이면 lazy 로드
  acc.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

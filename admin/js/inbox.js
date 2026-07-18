// ══════════════════════════════════════════════════════════════
//  inbox.js — 📥 처리함 (2026-07 개편)
//  운영자가 확인·답변·승인해야 하는 "도착한 항목"만 모은다.
//   · 점수 검토: 서버 자동 판정(보류/거부) — security.js의 loadVerdicts 재사용
//   · 문의: operations.js의 loadFeedback 재사용 (기본 10건 + 더 보기)
//   · 처리 완료: 확인 끝난 의심 기록(검증불가·오탐 포함)
//  서브탭은 처음 열 때만 조회(lazy) — 안 연 탭은 Firestore 조회 0.
// ══════════════════════════════════════════════════════════════
import { guardBtn } from './admin.js';
import { loadVerdicts, ackAllVerdicts } from './security.js';
import { initFeedbackUI, loadFeedback } from './operations.js';

const sub = { verdicts: { inited: false, loaded: false }, feedback: { inited: false, loaded: false }, done: { inited: false, loaded: false } };
let currentSub = 'verdicts';

async function openSub(name, { force = false } = {}) {
  currentSub = name;
  document.querySelectorAll('#inboxSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.sub === name));
  document.querySelectorAll('#tab-inbox .sub-panel').forEach(p => { p.style.display = p.dataset.subpanel === name ? '' : 'none'; });
  const st = sub[name];
  if (st.loaded && !force) return;
  if (name === 'verdicts' || name === 'done') {
    // 같은 쿼리(캐시 공유) — 검토 대기와 처리 완료를 한 번에 렌더
    await loadVerdicts({ force });
    sub.verdicts.loaded = true; sub.done.loaded = true;
  } else if (name === 'feedback') {
    if (!st.inited) { initFeedbackUI(); st.inited = true; }
    await loadFeedback({ reset: force });
    st.loaded = true;
  }
}

export function initInbox() {
  document.getElementById('inboxSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) openSub(btn.dataset.sub);
  });
  const ackBtn = document.getElementById('verdictAckBtn');
  if (ackBtn) ackBtn.addEventListener('click', guardBtn(ackBtn, ackAllVerdicts));
}

export async function loadInbox({ force = false } = {}) {
  if (force) { sub.verdicts.loaded = false; sub.feedback.loaded = false; sub.done.loaded = false; }
  await openSub(currentSub, { force });
}

// 상단 배지에서 바로 진입할 때 사용 — 처리함 탭이 열린 뒤 원하는 서브탭으로
export function gotoInboxSub(name) { openSub(name); }

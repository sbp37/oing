// ══════════════════════════════════════════════════════════════
//  dashboard.js — 🏠 오늘 (2026-07 개편)
//  운영자가 매일 30초 안에 확인하는 화면. 세션 전량 조회를 없애고
//  집계(count/sum) + 최근 5건만 읽는다.
//   · 오늘 확인할 일: 상단 배지 값 재사용 — 추가 Firestore 조회 0
//   · 오늘 게임 현황 타일: count 3 + sum 1 (문서 다운로드 0)
//     - "오늘 방문"은 세션 수 기준(고유 방문자 수는 distinct 집계가 없어
//       전량 조회가 필요 → 유저 탭 '전체 보기'에서만 계산)
//   · 최근 플레이: visit_sessions 최근 5건만
//   · 데이터 사용 배지: 이번 세션 readStats 기반(조회 0)
// ══════════════════════════════════════════════════════════════
import {
  db, collection, query, where, orderBy, limit,
  countQuery, sumQuery, fetchDocs,
  getTodayDateStr, fmtNum, fmtAgo, escapeHtml, humanError, readStats,
} from './firebase.js';
import { todayNewUsersCount, ONLINE_WINDOW_MS } from './stats.js';

function tile(label, valueHtml) {
  return `<div class="stat-tile big"><div class="stat-label">${label}</div><div class="stat-value">${valueHtml}</div></div>`;
}

// ── 오늘 확인할 일 — 상단 배지 숫자를 그대로 읽음(추가 조회 0), 클릭 시 처리함/관리로 ──
export function renderTasks() {
  const el = document.getElementById('todayTasks');
  const num = (id) => {
    const b = document.getElementById(id);
    const visible = b && b.style.display !== 'none';
    return visible ? parseInt((b.querySelector('b') || {}).textContent || '0', 10) || 0 : 0;
  };
  const verdicts = num('verdictBadge');
  const feedback = num('feedbackNewBadge');
  const reviews = num('reviewPendingBadge');
  const rows = [];
  if (verdicts > 0) rows.push({ icon: '🚨', text: `점수 검토 ${verdicts}건`, go: 'inbox:verdicts' });
  if (feedback > 0) rows.push({ icon: '💬', text: `새 문의 ${feedback}건`, go: 'inbox:feedback' });
  if (reviews > 0) rows.push({ icon: '📝', text: `보류 리뷰 ${reviews}건`, go: 'tools:acc-ops' });
  el.innerHTML = rows.length
    ? rows.map(r => `<div class="list-row clickable task-row" data-go="${r.go}"><span class="main">${r.icon} ${escapeHtml(r.text)}</span><span class="sub">→</span></div>`).join('')
    : `<div class="list-row"><span class="main">✅ 지금 처리할 항목이 없어요</span></div>`;
}

// ── 오늘 게임 현황 타일 — 전부 집계(문서 다운로드 0) ──
async function renderTiles() {
  const grid = document.getElementById('todayGrid');
  const labels = ['오늘 방문(세션)', '현재 접속', '오늘 플레이', '오늘 신규'];
  grid.innerHTML = labels.map(l => tile(l, '…')).join('');
  const today = getTodayDateStr();
  const jobs = [
    countQuery(collection(db, 'visit_sessions'), where('date', '==', today)),
    countQuery(collection(db, 'visit_sessions'), where('lastSeenTs', '>=', Date.now() - ONLINE_WINDOW_MS)),
    sumQuery('playCount', collection(db, 'visit_sessions'), where('date', '==', today)),
    todayNewUsersCount(),
  ];
  const res = await Promise.allSettled(jobs);
  grid.innerHTML = res.map((r, i) => tile(labels[i],
    r.status === 'fulfilled' ? fmtNum(r.value) + (i === 1 && r.value > 0 ? ' 🟢' : '') : '⚠️')).join('');
}

// ── 최근 플레이 5건 ──
async function renderRecent() {
  const el = document.getElementById('todayRecentList');
  try {
    const rows = await fetchDocs(query(collection(db, 'visit_sessions'), orderBy('lastSeenTs', 'desc'), limit(5)));
    el.innerHTML = rows.length ? rows.map(s => `
      <div class="list-row">
        <span class="main"><span class="nick">${escapeHtml(s.nickname || '익명')}</span>${s.playCount ? ` · ${s.playCount}판` : ''}</span>
        <span class="sub">${fmtAgo(s.lastSeenTs)}</span>
      </div>`).join('') : `<div class="list-empty">아직 기록이 없어요</div>`;
  } catch (e) { el.innerHTML = `<div class="list-error">⚠️ ${humanError(e)}</div>`; }
}

// ── 데이터 사용 상태 배지 — 이번 세션 누적 읽기 기준(조회 0) ──
export function renderDataBadge() {
  const btn = document.getElementById('todayDataBadge');
  if (!btn) return;
  const d = readStats.docs;
  const [icon, label] = d < 300 ? ['🟢', '낮음'] : d < 1500 ? ['🟡', '보통'] : d < 5000 ? ['🟠', '많음'] : ['🔴', '확인 필요'];
  btn.textContent = `${icon} 이번 세션 데이터 사용량 ${label} — 자세히 보기`;
}

export function initTodayTab({ goto }) {
  document.getElementById('todayTasks').addEventListener('click', (e) => {
    const row = e.target.closest('.task-row');
    if (row) goto(row.dataset.go);
  });
  document.getElementById('todayRecentAllBtn').addEventListener('click', () => goto('users'));
  document.getElementById('todayDataBadge').addEventListener('click', () => goto('stats:datause'));
}

export async function loadDashboard() {
  renderTasks();
  await Promise.allSettled([renderTiles(), renderRecent()]);
  renderDataBadge();
}

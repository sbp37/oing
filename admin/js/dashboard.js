// ══════════════════════════════════════════════════════════════
//  dashboard.js — 🏠 오늘
//  운영자가 매일 확인하는 화면. 오늘 세션 1쿼리(최대 SESSION_FETCH_CAP건)로
//  고유 방문자/현재 접속/오늘 플레이/최근 플레이·점수/접속 중인 닉네임을 전부 계산한다.
//   · 오늘 확인할 일: 상단 배지 값 재사용 — 추가 조회 0
//   · 오늘 신규: count 집계 1회 + (신규가 있을 때만) 닉네임 목록 1회
//   · 데이터 사용 배지: 이번 세션 readStats 기반(조회 0)
//   · "↻ 새로고침" 전까지는 세션 내 캐시를 재사용(analytics 탭과도 공유)
// ══════════════════════════════════════════════════════════════
import {
  db, getTodayDateStr, fmtNum, fmtAgo, fmtDuration, escapeHtml, humanError,
  readStats, getUserDocByNick, cache,
} from './firebase.js';
import {
  getTodaySessions, aggregateSessions, ONLINE_WINDOW_MS,
  todayNewUsersCount, todayNewUsersList, SESSION_FETCH_CAP,
} from './stats.js';

const MAX_ONLINE_SHOW = 10;
const MAX_NEW_SHOW = 10;
const MAX_RECENT_SHOW = 10;

function tile(label, valueHtml, sub = '') {
  return `<div class="stat-tile big"><div class="stat-label">${label}</div><div class="stat-value">${valueHtml}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
}
function nameOf(key, v) { return v.nickname || key.replace(/^nick:/, ''); }

// "더보기" 누르면 숨겨둔 나머지를 그 자리에서 펼치는 칩 목록 공용 렌더러
function renderMoreChips(namesEl, moreBtn, allNames, chipClass) {
  const shown = allNames.slice(0, MAX_ONLINE_SHOW);
  const rest = allNames.slice(MAX_ONLINE_SHOW);
  namesEl.innerHTML =
    shown.map(n => `<span class="${chipClass}">${escapeHtml(n)}</span>`).join('') +
    rest.map(n => `<span class="${chipClass}" data-extra style="display:none;">${escapeHtml(n)}</span>`).join('');
  if (rest.length) {
    moreBtn.textContent = `더보기 (+${rest.length}명)`;
    moreBtn.style.display = '';
    moreBtn.onclick = () => {
      namesEl.querySelectorAll('[data-extra]').forEach(s => { s.style.display = ''; });
      moreBtn.style.display = 'none';
    };
  } else {
    moreBtn.style.display = 'none';
  }
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

// 🟢 현재 접속 중 — 오늘 세션 조회 결과에서 계산 (추가 조회 0). lastSeenTs 5분 이내만.
function renderOnlineCard(entries) {
  const el = document.getElementById('todayOnlineCard');
  el.style.display = '';
  if (!entries.length) {
    el.innerHTML = '<div class="online-head off">⚪ 현재 접속 중인 유저 없음</div>';
    return;
  }
  const names = entries.map(([key, v]) => nameOf(key, v));
  el.innerHTML = `
    <div class="online-head">🟢 현재 접속 중 <b>${fmtNum(names.length)}명</b> <span class="card-note">최근 5분 활동 기준</span></div>
    <div class="online-names" id="todayOnlineNames"></div>
    <button type="button" class="online-chip more" id="todayOnlineMoreBtn" style="display:none; margin-top:6px;"></button>`;
  renderMoreChips(document.getElementById('todayOnlineNames'), document.getElementById('todayOnlineMoreBtn'), names, 'online-chip');
}

// 🌱 오늘 신규 — count는 이미 나온 값 재사용, 닉네임은 신규가 있을 때만 별도 조회(최대 count건)
async function renderNewCard(newCount) {
  const el = document.getElementById('todayNewCard');
  if (!newCount) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `
    <div class="new-head">🌱 오늘 신규 <b>${fmtNum(newCount)}명</b> <span class="card-note">오늘 처음 플레이</span></div>
    <div class="online-names" id="todayNewNames"><div class="list-loading">불러오는 중...</div></div>
    <button type="button" class="online-chip more" id="todayNewMoreBtn" style="display:none; margin-top:6px;"></button>`;
  try {
    const names = await todayNewUsersList(Math.min(newCount, 50));
    renderMoreChips(document.getElementById('todayNewNames'), document.getElementById('todayNewMoreBtn'), names, 'new-chip');
  } catch (e) {
    document.getElementById('todayNewNames').innerHTML = `<div class="list-error">⚠️ ${humanError(e)}</div>`;
  }
}

// 🎮 최근 플레이 — 오늘 실제로 게임을 한 사람만, 최근 접속순 10명 + 최근 점수 배지
async function renderRecentList(agg) {
  const el = document.getElementById('todayRecentList');
  const rows = [...agg._byVisitor.entries()]
    .filter(([, v]) => v.plays > 0)
    .sort((a, b) => b[1].lastSeenTs - a[1].lastSeenTs)
    .slice(0, MAX_RECENT_SHOW);
  if (!rows.length) { el.innerHTML = '<div class="list-empty">오늘 플레이 기록이 아직 없어요</div>'; return; }
  const capNote = agg.truncated
    ? `<div class="list-error">⚠️ 오늘 세션이 ${SESSION_FETCH_CAP}건을 넘어 최근 ${SESSION_FETCH_CAP}건 기준 근사치입니다</div>` : '';
  el.innerHTML = capNote + '<div class="list-loading">불러오는 중...</div>';
  // 닉네임 옆 "최근 점수" 배지 — 화면에 보이는 ≤10명만 개별 조회(읽기 최대 10건/새로고침)
  const scored = await Promise.all(rows.map(async ([key, v]) => {
    const nick = nameOf(key, v);
    let lastScore = null;
    if (nick) {
      try {
        const { data } = await getUserDocByNick('user_stats', nick);
        if (data && typeof data.lastScore === 'number') lastScore = data.lastScore;
      } catch { /* 점수 조회 실패해도 행은 그대로 표시 */ }
    }
    return { key, v, nick, lastScore };
  }));
  el.innerHTML = capNote + scored.map(({ v, nick, lastScore }) => `
    <div class="list-row">
      <span class="main"><span class="nick">${escapeHtml(nick)}</span>
        ${lastScore != null ? `<span class="badge green">${fmtNum(lastScore)}점</span>` : ''}</span>
      <span class="sub">${v.plays}판 · ${fmtDuration(v.dur)} · ${fmtAgo(v.lastSeenTs)}</span>
    </div>`).join('');
}

// 오늘 세션 1쿼리 결과로 타일 4개 + 접속중 카드 + 최근 플레이까지 전부 계산
async function renderFromSessions({ force = false } = {}) {
  const grid = document.getElementById('todayGrid');
  grid.innerHTML = ['오늘 방문자', '현재 접속', '오늘 플레이', '오늘 신규'].map(l => tile(l, '…')).join('');
  document.getElementById('todayRecentList').innerHTML = '<div class="list-loading">불러오는 중...</div>';
  if (force) cache.bust('shared:todayList:newUsers'); // 세션 캐시는 getTodaySessions가 스스로 비움

  const today = getTodayDateStr();
  let sessions, newCount;
  try {
    [sessions, newCount] = await Promise.all([
      getTodaySessions({ force }),
      todayNewUsersCount().catch(() => null),
    ]);
  } catch (e) {
    grid.innerHTML = tile('오늘 방문자', '⚠️') + tile('현재 접속', '⚠️') + tile('오늘 플레이', '⚠️') + tile('오늘 신규', '⚠️');
    document.getElementById('todayRecentList').innerHTML = `<div class="list-error">⚠️ ${humanError(e)}</div>`;
    document.getElementById('todayOnlineCard').style.display = 'none';
    document.getElementById('todayNewCard').style.display = 'none';
    return;
  }
  const agg = aggregateSessions(today, sessions);

  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  const onlineEntries = [...agg._byVisitor.entries()]
    .filter(([, v]) => (v.lastSeenTs || 0) >= cutoff)
    .sort((a, b) => b[1].lastSeenTs - a[1].lastSeenTs);

  grid.innerHTML = [
    tile('오늘 방문자', `${fmtNum(agg.uniqueVisitors)}<span class="unit">명</span>`, '고유 방문자 기준'),
    tile('현재 접속', `${fmtNum(onlineEntries.length)}${onlineEntries.length > 0 ? '<span class="online-dot"></span>' : ''}`),
    tile('오늘 플레이', `${fmtNum(agg.gamePlays)}<span class="unit">판</span>`),
    tile('오늘 신규', newCount != null ? `${fmtNum(newCount)}<span class="unit">명</span>` : '⚠️'),
  ].join('');

  renderOnlineCard(onlineEntries);
  renderNewCard(newCount || 0);
  await renderRecentList(agg);
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

export async function loadDashboard({ force = false } = {}) {
  renderTasks();
  try {
    await renderFromSessions({ force });
  } catch (e) {
    console.warn('[dashboard] 오늘 데이터 로드 실패:', e);
  }
  renderDataBadge();
}

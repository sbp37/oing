// ══════════════════════════════════════════════════════════════
//  statstab.js — 📊 통계 (2026-07 개편)
//  서브탭 4개를 lazy 로 관리한다. 안 연 서브탭은 Firestore 조회 0.
//   · 📅 활동: analytics.js 재사용 (14일 그래프 — dailyStats 캐시)
//     상세(신규/시간대/주간)는 같은 데이터라 추가 조회 없이 접기만 한다.
//   · 🧭 유입: 버튼을 눌러야만 조회 (analytics.js loadReferrerData)
//   · 👆 사용자 행동: 자주 보는 3개(내정보/공유/리뷰버튼)는 열 때 로드,
//     나머지는 그룹 아코디언을 열어야만 컬렉션당 최근 5건 조회
//   · 💾 데이터 사용: 이번 세션 readStats 표시 — 조회 0
// ══════════════════════════════════════════════════════════════
import {
  db, collection, query, orderBy, limit, where,
  fetchDocs, countQuery, makePager,
  getTodayDateStr, fmtDateTime, fmtNum, escapeHtml, humanError, readStats, normalizeNickname,
} from './firebase.js';
import { initAnalyticsTab, loadAnalytics } from './analytics.js';
import { setError } from './admin.js';
import { renderDataBadge } from './dashboard.js';

// 제작자(운영자) 본인 닉네임 — 사용자 행동 목록에서 제외(개발 중 테스트 클릭이 목록을 덮는 문제 방지).
// 게임(index.html)도 v4.6.7부터 제작자 행동은 아예 기록하지 않으므로, 여기 필터는 과거 잔재 숨김용.
// 게임 CREATOR_NICKS와 같은 값으로 유지 — 제작자 닉을 바꾸면 양쪽 한 줄씩 갱신.
const CREATOR_NICKS = new Set(['오잉이'].map(normalizeNickname));
const isCreatorNick = (n) => CREATOR_NICKS.has(normalizeNickname(n));

// ── 서브탭 상태 ──
const sub = { activity: { loaded: false }, referrer: { loaded: true }, behavior: { loaded: false }, datause: { loaded: true } };
let currentSub = 'activity';

// ── 사용자 행동: 컬렉션 정의 ──
// 자주 보는 3개는 바로 카드로, 나머지는 그룹 아코디언 안에서 열 때만 조회.
const BH_FAV = [
  { col: 'myinfo_clicks',       label: '👤 내 정보 열람' },
  { col: 'share_clicks',        label: '📤 카카오톡 공유' },
  { col: 'review_entry_clicks', label: '⭐ 리뷰 버튼 클릭' },
];
const BH_GROUPS = [
  { id: 'game',   label: '🎮 게임 이용',    cols: [
    { col: 'updatelog_clicks',     label: '📜 업데이트로그 열람' },
    { col: 'thanks_toggle_clicks', label: '🐾 감사메시지 열람' },
  ]},
  { id: 'review', label: '📣 리뷰 요청 반응', cols: [
    { col: 'review_prompt_shown',  label: '📣 리뷰요청 팝업' },
  ]},
  { id: 'shop',   label: '💛 후원·상점',    cols: [
    { col: 'donate_clicks',         label: '💛 990원 응원' },
    { col: 'support_topbtn_clicks', label: '🛍 스킨샵 버튼' },
    { col: 'snack_clicks',          label: '🍪 간식 버튼' },
  ]},
];
const DETAIL_PAGE = 20;
const bhState = {}; // { [col]: { rows, pager, todayCount } }

const SOURCE_LABEL = { rank: '랭킹탭', main: '메인' };
function bhRowHtml(col, r) {
  // ⭐리뷰버튼/👤내정보 — 어디서 눌렀는지, 📣리뷰요청 — 어떤 반응인지 배지로 구분
  let badge = '';
  if (col === 'review_entry_clicks' || col === 'myinfo_clicks') {
    badge = `<span class="badge">${escapeHtml(SOURCE_LABEL[r.source] || '알 수 없음')}</span>`;
  } else if (col === 'review_prompt_shown') {
    const A = {
      write:   { t: '✍️ 리뷰 남기기', c: 'green' },
      dismiss: { t: '그냥 계속할래',  c: 'warn' },
      shown:   { t: '노출만(무응답)', c: '' },
    };
    const a = A[r.action] || A.shown;
    badge = `<span class="badge ${a.c}">${a.t}</span>`;
  }
  return `
    <div class="list-row">
      <span class="main"><span class="nick">${escapeHtml(r.nickname || '익명')}</span> ${badge}</span>
      <span class="sub">${fmtDateTime(r.ts)}</span>
    </div>`;
}

// 컬렉션 하나의 목록 로드 — 처음 5건. '상세 보기'부터는 20건씩 pager.
async function bhLoadRecent(col, { withCount = false } = {}) {
  const listEl = document.getElementById('bh-list-' + col);
  const metaEl = document.getElementById('bh-meta-' + col);
  if (!listEl || bhState[col]) return;
  bhState[col] = { rows: [], pager: null, todayCount: null };
  listEl.innerHTML = '<div class="list-loading">불러오는 중...</div>';
  try {
    // 제작자 제외 후에도 최근 5건이 남도록 넉넉히(12) 가져온 뒤 필터
    const jobs = [fetchDocs(query(collection(db, col), orderBy('ts', 'desc'), limit(12)))];
    if (withCount) jobs.push(countQuery(collection(db, col), where('date', '==', getTodayDateStr())).catch(() => null));
    const [raw, todayCount] = await Promise.all(jobs);
    const rows = raw.filter(r => !isCreatorNick(r.nickname)).slice(0, 5);
    bhState[col].rows = rows;
    bhState[col].todayCount = withCount ? todayCount : null;
    if (metaEl && withCount) metaEl.textContent = todayCount != null ? `오늘 ${fmtNum(todayCount)}회` : '';
    listEl.innerHTML = rows.length ? rows.map(r => bhRowHtml(col, r)).join('')
      : '<div class="list-empty">아직 기록이 없어요</div>';
    const moreBtn = document.getElementById('bh-more-' + col);
    if (moreBtn) moreBtn.style.display = raw.length >= 12 ? '' : 'none';
  } catch (e) {
    delete bhState[col]; // 실패 시 재시도 가능하게
    listEl.innerHTML = `<div class="list-error">⚠️ ${humanError(e)}</div>`;
  }
}

// '상세 보기 / 더 보기' — 20건씩 커서 페이지네이션
async function bhLoadMore(col, btn) {
  const listEl = document.getElementById('bh-list-' + col);
  const st = bhState[col];
  if (!st || !listEl) return;
  btn.disabled = true;
  try {
    if (!st.pager) {
      st.pager = makePager(() => [collection(db, col), orderBy('ts', 'desc')], DETAIL_PAGE);
      st.rows = []; // 첫 20건이 최근 5건을 포함하므로 목록을 교체
    }
    const page = await st.pager.next();
    st.rows.push(...page.filter(r => !isCreatorNick(r.nickname))); // 제작자 제외
    listEl.innerHTML = st.rows.length ? st.rows.map(r => bhRowHtml(col, r)).join('')
      : '<div class="list-empty">아직 기록이 없어요</div>';
    btn.textContent = '더 보기 (20건씩)';
    btn.style.display = st.pager.done ? 'none' : '';
  } catch (e) {
    setError(listEl, humanError(e));
  } finally {
    btn.disabled = false;
  }
}

function bhSectionHtml({ col, label }, { withCount = false } = {}) {
  return `
    <div class="bh-card">
      <div class="bh-name">${label} <span class="bh-meta" id="bh-meta-${col}" style="display:inline;"></span></div>
      <div id="bh-list-${col}" class="list" style="margin-top:6px;"></div>
      <button class="btn btn-ghost btn-sm btn-block bh-more" id="bh-more-${col}" data-col="${col}" style="display:none; margin-top:6px;">상세 보기 (20건씩)</button>
    </div>`;
}

function renderBehaviorSkeleton() {
  const favEl = document.getElementById('behaviorFav');
  const grpEl = document.getElementById('behaviorGroups');
  favEl.innerHTML = `
    <div class="card-note" style="margin-bottom:8px;">자주 보는 기록이에요. 나머지는 아래 묶음을 열면 그때만 불러와요.</div>
    ${BH_FAV.map(f => bhSectionHtml(f, { withCount: true })).join('')}`;
  grpEl.innerHTML = BH_GROUPS.map(g => `
    <details class="bh-group" id="bh-group-${g.id}">
      <summary>${g.label}</summary>
      <div class="bh-body">${g.cols.map(c => bhSectionHtml(c)).join('')}</div>
    </details>`).join('');
}

async function loadBehavior() {
  renderBehaviorSkeleton();
  // 자주 보는 3개: 오늘 카운트(count 집계) + 최근 5건
  await Promise.allSettled(BH_FAV.map(f => bhLoadRecent(f.col, { withCount: true })));
}

function initBehavior() {
  // 그룹 아코디언 — 처음 열 때만 그 그룹의 컬렉션당 최근 5건 조회
  document.getElementById('behaviorGroups').addEventListener('toggle', (e) => {
    const grp = e.target.closest('.bh-group');
    if (!grp || !grp.open) return;
    const g = BH_GROUPS.find(x => 'bh-group-' + x.id === grp.id);
    if (g) g.cols.forEach(c => bhLoadRecent(c.col));
  }, true); // toggle 은 버블링하지 않으므로 캡처로 위임
  // 상세 보기 / 더 보기
  document.getElementById('tab-stats').addEventListener('click', (e) => {
    const btn = e.target.closest('.bh-more');
    if (btn) bhLoadMore(btn.dataset.col, btn);
  });
}

// ── 💾 데이터 사용 — 이번 세션 readStats 기반 (조회 0) ──
function renderDatause() {
  const el = document.getElementById('datauseSummary');
  const d = readStats.docs, q = readStats.queries;
  const [icon, label] = d < 300 ? ['🟢', '낮음 — 걱정 없어요'] : d < 1500 ? ['🟡', '보통'] : d < 5000 ? ['🟠', '많음 — 큰 목록 조회를 줄여보세요'] : ['🔴', '확인 필요 — 새로고침 남발/전체 목록 반복 조회가 있었는지 확인'];
  el.innerHTML = `
    <div class="list-row"><span class="main">데이터 불러오기</span><span class="sub"><b>${fmtNum(d)}</b>건</span></div>
    <div class="list-row"><span class="main">서버 조회 요청</span><span class="sub"><b>${fmtNum(q)}</b>회</span></div>
    <div class="list-row"><span class="main">상태</span><span class="sub">${icon} ${label}</span></div>
    <div class="list-row"><span class="main sub" style="font-weight:400;">이 숫자는 관리자 화면을 연 뒤부터의 누적이고, 화면을 새로 열면 0부터 다시 세요.</span></div>`;
  renderDataBadge(); // 🏠오늘 탭 하단 배지도 같은 값으로 갱신
}

function renderDatauseDev() {
  const box = document.getElementById('datauseDevBox');
  box.innerHTML = `readStats — docs(문서 읽기): <b>${fmtNum(readStats.docs)}</b> · queries(쿼리 실행): <b>${fmtNum(readStats.queries)}</b><br>
    count/sum 집계는 문서 다운로드 없이 queries 1회로 집니다. 탭 재방문은 세션 캐시를 써서 재조회하지 않아요.`;
}

// ── 서브탭 전환 ──
async function openSub(name, { force = false } = {}) {
  currentSub = name;
  document.querySelectorAll('#statsSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.sub === name));
  document.querySelectorAll('#tab-stats .sub-panel').forEach(p => { p.style.display = p.dataset.subpanel === name ? '' : 'none'; });
  if (name === 'datause') { renderDatause(); return; }        // 항상 최신 값 (조회 0)
  const st = sub[name];
  if (st.loaded && !force) return;
  if (name === 'activity') {
    await loadAnalytics({ force });
    st.loaded = true;
  } else if (name === 'behavior') {
    if (force) Object.keys(bhState).forEach(k => delete bhState[k]);
    await loadBehavior();
    st.loaded = true;
    // 이미 열려 있는 그룹은 다시 채워준다 (force 새로고침 시)
    document.querySelectorAll('#behaviorGroups .bh-group[open]').forEach(grp => {
      const g = BH_GROUPS.find(x => 'bh-group-' + x.id === grp.id);
      if (g) g.cols.forEach(c => bhLoadRecent(c.col));
    });
  }
  // referrer 는 버튼("불러오기")을 눌러야만 조회 — 여기서는 아무것도 안 함
}

export function initStatsTab() {
  initAnalyticsTab(); // referrerLoadBtn + recomputeBtn 바인딩 (조회 없음)
  initBehavior();
  document.getElementById('statsSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) openSub(btn.dataset.sub);
  });
  // 활동 상세(신규/시간대/주간) 접기 — 데이터는 loadAnalytics 가 이미 채움(추가 조회 0)
  const detailToggle = document.getElementById('statsDetailToggle');
  detailToggle.addEventListener('click', () => {
    const box = document.getElementById('statsDetailBox');
    const open = box.style.display === 'none';
    box.style.display = open ? 'block' : 'none';
    detailToggle.textContent = open ? '상세 통계 접기 ▴' : '상세 통계 보기 ▾';
  });
  // 데이터 사용 — 개발자용 상세
  const devToggle = document.getElementById('datauseDevToggle');
  devToggle.addEventListener('click', () => {
    const box = document.getElementById('datauseDevBox');
    const open = box.style.display === 'none';
    if (open) renderDatauseDev();
    box.style.display = open ? 'block' : 'none';
    devToggle.textContent = open ? '개발자용 상세 ▴' : '개발자용 상세 ▾';
  });
}

export async function loadStats({ force = false } = {}) {
  if (force) { sub.activity.loaded = false; sub.behavior.loaded = false; }
  await openSub(currentSub, { force });
}

// 배지/오늘 화면에서 바로 진입 — goto('stats:datause') 등
export function gotoStatsSub(name) { openSub(name); }

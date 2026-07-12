// ══════════════════════════════════════════════════════════════
//  dashboard.js — 홈 탭 (관리자 최초 진입 시 로드되는 유일한 탭)
//
//  읽기 비용 설계:
//   · 오늘 방문자/체류시간/시작률/이탈률/판수/MVP/최근접속
//       → visit_sessions(오늘) "단 1개의 쿼리"에서 전부 계산
//   · 각종 클릭 수 / 유저 수 → count 집계 (문서 다운로드 없음, 쿼리당 1읽기)
//   · WAU/재방문율 → dailyStats 캐시(날짜당 문서 1개) — 타일만 비동기로 채움
//   · 실시간 리스너 없음 — "↻ 홈 새로고침" 버튼으로만 갱신
// ══════════════════════════════════════════════════════════════
import {
  db, collection, where, countQuery,
  getTodayDateStr, todayStartTs,
  fmtAgo, fmtDuration, fmtNum, escapeHtml, cache, humanError,
} from './firebase.js';
import { getTodaySessions, aggregateSessions, getDailyStatsRange, computeWeeklyMetrics, SESSION_FETCH_CAP } from './stats.js';
import { setError, setEmpty } from './admin.js';

// ── 홈 화면 구성 (정보 위계) ──
// A. 핵심 4개 — 크게 / B. 운영 4개 — 컴팩트 타일 /
// C. 클릭 5종 — 카드 1개 안의 행 / D. 주간 2종 — 카드 1개 안의 행
// 화면에는 내부 컬렉션·필드명을 쓰지 않는다 (사람이 읽는 설명만).
const CORE_TILES = [
  ['visitors', '오늘 방문자', '고유 방문자 기준'],
  ['plays',    '오늘 플레이', ''],
  ['newUsers', '오늘 신규 유저', '오늘 가입한 계정'],
  ['mvp',      '오늘 MVP', '가장 많이 플레이'],
];
const OPS_TILES = [
  ['avgDur',     '평균 체류시간', '세션 기준'],
  ['startRate',  '게임 시작률', '방문자 중 플레이 시작'],
  ['bounceRate', '바로 나간 비율', '15초 미만 · 미플레이'],
  ['totalUsers', '전체 유저 수', '점수 등록 계정'],
];
const CLICK_ROWS = [   // 990원 응원 / 상단 응원 버튼 / 간식 / 카톡 공유 / 서포터팩 클릭 로그
  ['donate',  '990원'],
  ['support', '응원하기'],
  ['snack',   '간식'],
  ['share',   '카톡 공유'],
  ['pack',    '서포터팩'],
];
const WEEKLY_ROWS = [
  ['wau',        'WAU (7일 방문자)'],
  ['returnRate', '오늘 재방문율'],
];

function renderTileGrid() {
  const tile = ([id, label, sub], big) => `
    <div class="stat-tile loading ${big ? 'big' : 'compact'}" id="tile-${id}">
      <div class="stat-label">${label}</div>
      <div class="stat-value">불러오는 중...</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;
  document.getElementById('homeCoreGrid').innerHTML = CORE_TILES.map(t => tile(t, true)).join('');
  document.getElementById('homeOpsGrid').innerHTML = OPS_TILES.map(t => tile(t, false)).join('');
  const miniRow = ([id, label]) => `
    <div class="mini-row"><span class="mini-label">${label}</span>
      <span class="mini-val loading" id="mini-${id}">…</span></div>`;
  document.getElementById('homeClicksList').innerHTML = CLICK_ROWS.map(miniRow).join('');
  document.getElementById('homeWeeklyList').innerHTML = WEEKLY_ROWS.map(miniRow).join('');
  document.getElementById('homeWeeklyNote').textContent = '';
}
function setTile(id, valueHtml, ok = true) {
  const el = document.getElementById('tile-' + id);
  if (!el) return;
  el.classList.remove('loading');
  el.classList.toggle('error', !ok);
  el.querySelector('.stat-value').innerHTML = valueHtml;
}
function tileErr(id, e) { setTile(id, humanError(e), false); }
function setMini(id, valueHtml, ok = true) {
  const el = document.getElementById('mini-' + id);
  if (!el) return;
  el.classList.remove('loading');
  el.classList.toggle('error', !ok);
  el.innerHTML = valueHtml;
}
function miniErr(id, e) { setMini(id, '⚠️ ' + humanError(e), false); }

export async function loadDashboard({ force = false } = {}) {
  renderTileGrid();
  const recentEl = document.getElementById('homeRecentList');
  recentEl.innerHTML = '<div class="list-loading">불러오는 중...</div>';

  const today = getTodayDateStr();

  // ── ① 오늘 세션 1쿼리 → 타일 7개 + 최근 접속 리스트 ──
  const sessionsPromise = getTodaySessions({ force }).then(sessions => {
    const agg = aggregateSessions(today, sessions);
    setTile('visitors', `${fmtNum(agg.uniqueVisitors)}<span class="unit">명</span>`);
    setTile('plays', `${fmtNum(agg.gamePlays)}<span class="unit">판</span>`);
    setTile('avgDur', fmtDuration(agg.avgDurationSec));
    setTile('startRate', `${agg.startRate}<span class="unit">%</span>`);
    setTile('bounceRate', `${agg.bounceRate}<span class="unit">%</span>`);

    // 오늘 MVP — 이미 받아온 세션에서 계산 (추가 조회 0)
    let mvp = null;
    for (const [key, v] of agg._byVisitor) {
      if (!mvp || v.plays > mvp.plays) mvp = { key, ...v };
    }
    if (mvp && mvp.plays > 0) {
      const name = mvp.nickname || mvp.key.replace(/^nick:/, '');
      setTile('mvp', `${escapeHtml(name)} <span class="unit">${mvp.plays}판</span>`);
    } else {
      setTile('mvp', '-');
    }

    // 최근 접속 — 오늘 세션을 lastSeenTs 순으로 (실시간 리스너 대신 새로고침 갱신)
    const rows = [...agg._byVisitor.entries()]
      .sort((a, b) => b[1].lastSeenTs - a[1].lastSeenTs)
      .slice(0, 10);
    if (!rows.length) { setEmpty(recentEl, '오늘 방문 기록이 아직 없어요'); return agg; }
    // 조회 상한 도달 = 오늘 지표가 "최근 세션 기준 근사치"임을 명시 (조용한 잘림 방지)
    const capNote = agg.truncated
      ? `<div class="list-error">⚠️ 오늘 세션이 ${SESSION_FETCH_CAP}건을 넘어 최근 ${SESSION_FETCH_CAP}건 기준 근사치입니다</div>` : '';
    recentEl.innerHTML = capNote + rows.map(([key, v]) => `
      <div class="list-row">
        <span class="main"><span class="nick">${escapeHtml(v.nickname || key.replace(/^nick:/, ''))}</span>
          ${v.started ? '<span class="badge green">플레이</span>' : '<span class="badge">방문만</span>'}</span>
        <span class="sub">${v.plays}판 · ${fmtDuration(v.dur)} · ${fmtAgo(v.lastSeenTs)}</span>
      </div>`).join('');
    return agg;
  }).catch(e => {
    ['visitors', 'plays', 'avgDur', 'startRate', 'bounceRate', 'mvp'].forEach(id => tileErr(id, e));
    setError(recentEl, humanError(e));
    return null;
  });

  // ── ② count 집계 — 병렬 실행, 항목별 독립 처리 (조회 로직은 기존과 동일) ──
  const todayCount = (col) => countQuery(collection(db, col), where('date', '==', today));
  const clickJobs = [
    ['donate',  () => todayCount('donate_clicks')],
    ['support', () => todayCount('support_topbtn_clicks')],
    ['snack',   () => todayCount('snack_clicks')],
    ['share',   () => todayCount('share_clicks')],
    ['pack',    () => todayCount('supporterpack_clicks')],
  ];
  const userJobs = [
    ['totalUsers', () => cache.get('home:totalUsers', () => countQuery(collection(db, 'users')))],
    ['newUsers',   () => countQuery(collection(db, 'users'), where('createdAt', '>=', todayStartTs()))],
  ];
  const countsPromise = Promise.all([
    ...clickJobs.map(([id, job]) =>
      job().then(n => setMini(id, `${fmtNum(n)}<span class="unit">회</span>`)).catch(e => miniErr(id, e))),
    ...userJobs.map(([id, job]) =>
      job().then(n => setTile(id, `${fmtNum(n)}<span class="unit">명</span>`)).catch(e => tileErr(id, e))),
  ]);

  // ── ③ WAU/재방문율 — dailyStats "읽기 전용" (날짜당 문서 1개, 최대 6읽기) ──
  // 홈에서는 절대 원본(visit_sessions 과거분)을 백필하지 않는다.
  // 미집계 안내는 카드 하단에 1회만 표시.
  const weeklyPromise = (async () => {
    try {
      setMini('wau', '집계 중...');
      setMini('returnRate', '집계 중...');
      const daily = await getDailyStatsRange(7, { force, allowBackfill: false });
      const wk = computeWeeklyMetrics(daily);
      setMini('wau', `${fmtNum(wk.wau)}<span class="unit">명</span>`);
      setMini('returnRate', `${wk.returnRate}<span class="unit">% (${wk.returning}명)</span>`);
      document.getElementById('homeWeeklyNote').textContent =
        wk.missingDays ? `${wk.missingDays}일 미집계 · 분석 탭을 열면 집계됩니다` : '';
    } catch (e) {
      miniErr('wau', e);
      miniErr('returnRate', e);
    }
  })();

  await Promise.allSettled([sessionsPromise, countsPromise, weeklyPromise]);
}

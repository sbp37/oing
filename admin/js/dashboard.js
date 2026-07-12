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
import { getTodaySessions, aggregateSessions, getDailyStatsRange, computeWeeklyMetrics } from './stats.js';
import { setError, setEmpty } from './admin.js';

// 홈에 표시할 타일 정의 (id, 라벨, 부가설명)
const TILES = [
  ['visitors',   '오늘 방문자', '고유 방문자 기준'],
  ['newUsers',   '오늘 신규 유저', 'users.createdAt 기준'],
  ['plays',      '오늘 총 플레이 판수', ''],
  ['avgDur',     '평균 체류시간', '세션 기준'],
  ['startRate',  '게임 시작률', '방문자 중 플레이 시작'],
  ['bounceRate', '바로 나간 비율', '15초 미만 · 미플레이'],
  ['mvp',        '오늘 MVP', '오늘 가장 많이 플레이'],
  ['totalUsers', '전체 유저 수', '점수 등록 계정'],
  ['donate',     '오늘 990원 클릭', 'donate_clicks'],
  ['support',    '오늘 응원하기 클릭', 'support_topbtn_clicks'],
  ['snack',      '오늘 간식사주기 클릭', 'snack_clicks'],
  ['share',      '오늘 카톡 공유 클릭', 'share_clicks'],
  ['pack',       '오늘 서포터팩 클릭', 'supporterpack_clicks'],
  ['wau',        'WAU (7일 방문자)', 'dailyStats 집계'],
  ['returnRate', '오늘 재방문율', '지난 6일 내 방문 이력'],
];

function renderTileGrid() {
  const grid = document.getElementById('homeStatGrid');
  grid.innerHTML = TILES.map(([id, label, sub]) => `
    <div class="stat-tile loading" id="tile-${id}">
      <div class="stat-label">${label}</div>
      <div class="stat-value">불러오는 중...</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`).join('');
}
function setTile(id, valueHtml, ok = true) {
  const el = document.getElementById('tile-' + id);
  if (!el) return;
  el.classList.remove('loading');
  el.classList.toggle('error', !ok);
  el.querySelector('.stat-value').innerHTML = valueHtml;
}
function tileErr(id, e) { setTile(id, humanError(e), false); }

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
    recentEl.innerHTML = rows.map(([key, v]) => `
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

  // ── ② count 집계 타일 — 병렬 실행, 각 타일 독립 처리 ──
  const todayCount = (col) => countQuery(collection(db, col), where('date', '==', today));
  const countJobs = [
    ['donate',  () => todayCount('donate_clicks')],
    ['support', () => todayCount('support_topbtn_clicks')],
    ['snack',   () => todayCount('snack_clicks')],
    ['share',   () => todayCount('share_clicks')],
    ['pack',    () => todayCount('supporterpack_clicks')],
    ['totalUsers', () => cache.get('home:totalUsers', () => countQuery(collection(db, 'users')))],
    ['newUsers',   () => countQuery(collection(db, 'users'), where('createdAt', '>=', todayStartTs()))],
  ];
  const countsPromise = Promise.all(countJobs.map(([id, job]) =>
    job()
      .then(n => setTile(id, `${fmtNum(n)}<span class="unit">${id === 'totalUsers' || id === 'newUsers' ? '명' : '회'}</span>`))
      .catch(e => tileErr(id, e))
  ));

  // ── ③ WAU/재방문율 — dailyStats 기반 (첫 1회만 백필, 이후 날짜당 1읽기) ──
  const weeklyPromise = (async () => {
    try {
      setTile('wau', '집계 중...');
      setTile('returnRate', '집계 중...');
      const daily = await getDailyStatsRange(7, { force });
      const wk = computeWeeklyMetrics(daily);
      setTile('wau', `${fmtNum(wk.wau)}<span class="unit">명</span>`);
      setTile('returnRate', `${wk.returnRate}<span class="unit">% (${wk.returning}명)</span>`);
    } catch (e) {
      tileErr('wau', e);
      tileErr('returnRate', e);
    }
  })();

  await Promise.allSettled([sessionsPromise, countsPromise, weeklyPromise]);
}

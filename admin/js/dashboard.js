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
  db, collection, doc, countQuery, fetchDoc, getUserDocByNick,
  getTodayDateStr,
  fmtAgo, fmtDuration, fmtNum, escapeHtml, cache, humanError,
} from './firebase.js';
import {
  getTodaySessions, aggregateSessions, getDailyStatsRange, computeWeeklyMetrics,
  countTodayCached, todayNewUsersCount, SESSION_FETCH_CAP, ONLINE_WINDOW_MS,
} from './stats.js';
import { setError, setEmpty } from './admin.js';

// ── 홈 화면 구성 (정보 위계) ──
// A. 핵심 4개 — 크게 / B. 운영 4개 — 컴팩트 타일 /
// C. 클릭 5종 — 카드 1개 안의 행 / D. 주간 2종 — 카드 1개 안의 행
// 화면에는 내부 컬렉션·필드명을 쓰지 않는다 (사람이 읽는 설명만).
const CORE_TILES = [
  ['visitors', '오늘 방문자', '고유 방문자 기준'],
  ['plays',    '오늘 플레이', ''],
  ['newUsers', '오늘 신규 유저', '오늘 첫 플레이 기준'],
  ['mvp',      '오늘 MVP', '가장 많이 플레이'],
];
const OPS_TILES = [
  ['avgDur',     '평균 체류시간', '세션 기준'],
  ['startRate',  '게임 시작률', '방문자 중 플레이 시작'],
  ['bounceRate', '바로 나간 비율', '15초 미만 · 미플레이'],
  ['totalUsers', '전체 유저 수', '점수 등록 닉네임 기준'],
];
// [id, 라벨, 실제 컬렉션명] — 행을 누르면 후원·리워드 탭의 "누가 눌렀는지" 과거 목록으로 이동
const CLICK_ROWS = [
  ['donate',  '990원',    'donate_clicks'],
  ['support', '응원하기',  'support_topbtn_clicks'],
  ['snack',   '간식',      'snack_clicks'],
  ['share',   '카톡 공유', 'share_clicks'],
  ['pack',    '서포터팩',  'supporterpack_clicks'],
];
const WEEKLY_ROWS = [
  ['wau',        'WAU (7일 방문자)'],
  ['returnRate', '오늘 재방문율'],
];
// 서버 공식 점수 상한 (백엔드 OFFICIAL_SCORE_MAX와 동일) — 이걸 넘는 기록은 거부가 정상
const OFFICIAL_SCORE_MAX = 50000;

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
  // 클릭 현황 행은 클릭 가능 — 누가 눌렀는지 과거 목록으로 이동
  const clickRow = ([id, label, col]) => `
    <div class="mini-row clickable" data-clicklog="${col}"><span class="mini-label">${label}<span class="mini-go">기록 보기 ›</span></span>
      <span class="mini-val loading" id="mini-${id}">…</span></div>`;
  document.getElementById('homeClicksList').innerHTML = CLICK_ROWS.map(clickRow).join('');
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

// 🟢 현재 접속 중 — 이미 받아온 오늘 세션에서 계산 (추가 Firestore 조회 0, 리스너 없음).
// 판정 기준: lastSeenTs가 5분 이내 (게임 하트비트가 활동 중 2~3분 간격으로 갱신되므로)
function renderOnlineCard(agg) {
  const el = document.getElementById('homeOnlineCard');
  if (!el) return;
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  const online = [...agg._byVisitor.entries()]
    .filter(([, v]) => (v.lastSeenTs || 0) >= cutoff)
    .sort((a, b) => b[1].lastSeenTs - a[1].lastSeenTs)
    .map(([key, v]) => v.nickname || key.replace(/^nick:/, ''));
  if (!online.length) {
    el.innerHTML = '<div class="online-head off">⚪ 현재 접속 중인 유저 없음</div>';
    return;
  }
  const MAX_SHOW = 12;
  const shown = online.slice(0, MAX_SHOW);
  const rest = online.length - shown.length;
  el.innerHTML = `
    <div class="online-head">🟢 현재 접속 중 <b>${online.length}명</b> <span class="card-note">최근 5분 활동 기준 · 새로고침으로 갱신</span></div>
    <div class="online-names">${shown.map(n => `<span class="online-chip">${escapeHtml(n)}</span>`).join('')}
      ${rest > 0 ? `<span class="online-chip more">외 ${rest}명</span>` : ''}</div>`;
}

export async function loadDashboard({ force = false } = {}) {
  renderTileGrid();
  const recentEl = document.getElementById('homeRecentList');
  recentEl.innerHTML = '<div class="list-loading">불러오는 중...</div>';
  const onlineEl = document.getElementById('homeOnlineCard');
  if (onlineEl) onlineEl.innerHTML = '<div class="online-head off">접속 확인 중...</div>';

  const today = getTodayDateStr();

  // ── ① 오늘 세션 1쿼리 → 현재 접속 중 + 타일 + 최근 접속 리스트 ──
  const sessionsPromise = getTodaySessions({ force }).then(sessions => {
    const agg = aggregateSessions(today, sessions);
    renderOnlineCard(agg);
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
    recentEl.innerHTML = capNote + rows.map(([key, v]) => {
      const nick = v.nickname || key.replace(/^nick:/, '');
      return `
      <div class="list-row" data-recent-nick="${escapeHtml(nick)}">
        <span class="main"><span class="nick">${escapeHtml(nick)}</span>
          ${v.started ? '<span class="badge green">플레이</span>' : '<span class="badge">방문만</span>'}
          <span class="recent-score" data-nick="${escapeHtml(nick)}"></span></span>
        <span class="sub">${v.plays}판 · ${fmtDuration(v.dur)} · ${fmtAgo(v.lastSeenTs)}</span>
      </div>`;
    }).join('');
    // 최근 점수 — 오늘 플레이한 행만 user_stats.lastScore(매판 갱신되는 마지막 판 점수)를 표시.
    // rankings.score는 역대 최고점이라 "최근 점수"가 아님 — 0판 유저에게 옛 최고점이 떠서
    // 혼란을 주던 원인. 오늘 0판(방문만)은 빈칸으로 둔다. (최대 10건, 실패해도 무해)
    for (const [key, v] of rows) {
      const nick = v.nickname || key.replace(/^nick:/, '');
      if (!v.nickname || !(v.plays > 0)) continue; // 익명 방문자·오늘 0판은 점수 표시 안 함
      const statsPromise = cache.get('home:recentStats:' + nick, () => getUserDocByNick('user_stats', nick));
      statsPromise.then(({ data }) => {
        const cell = recentEl.querySelector(`.recent-score[data-nick="${CSS.escape(nick)}"]`);
        if (cell && data && typeof data.lastScore === 'number') {
          cell.innerHTML = `${fmtNum(data.lastScore)}점<span class="unit">마지막판</span>`;
        }
      }).catch(() => {});

      // ⚠️ 랭킹 미반영 의심 — user_stats는 매판 클라이언트가 갱신하지만 rankings는 서버 판정을
      // 통과해야 반영되므로, bestScore > rankings.score면 점수 등록이 누락된 신호
      // (NO_SESSION 장애·신규 유저 미반영이 이 패턴). 상한 초과(5만+)는 거부가 정상이라 제외.
      Promise.all([
        statsPromise,
        cache.get('home:recentRank:' + nick, () => fetchDoc(doc(db, 'rankings', nick))),
      ]).then(([{ data: st }, rk]) => {
        if (!st || typeof st.bestScore !== 'number' || st.bestScore <= 0) return;
        if (st.bestScore > OFFICIAL_SCORE_MAX) return;
        const rankScore = (rk && typeof rk.score === 'number') ? rk.score : 0;
        if (st.bestScore <= rankScore) return;
        const main = recentEl.querySelector(`.list-row[data-recent-nick="${CSS.escape(nick)}"] .main`);
        if (main && !main.querySelector('.badge.warn')) {
          main.insertAdjacentHTML('beforeend',
            `<span class="badge warn" title="이 유저의 최고점(${fmtNum(st.bestScore)}점)이 랭킹(${fmtNum(rankScore)}점)보다 높아요 — 점수 등록 누락 의심 (NO_SESSION 장애·신규 유저 미반영 등). 보안 탭 판정 목록을 확인해보세요.">⚠️ 랭킹 미반영</span>`);
        }
      }).catch(() => {});
    }
    return agg;
  }).catch(e => {
    ['visitors', 'plays', 'avgDur', 'startRate', 'bounceRate', 'mvp'].forEach(id => tileErr(id, e));
    setError(recentEl, humanError(e));
    if (onlineEl) onlineEl.innerHTML = `<div class="online-head off">⚠️ ${humanError(e)}</div>`;
    return null;
  });

  // ── ② count 집계 — 병렬 실행, 항목별 독립 처리 (공용 캐시 — 분석 탭과 같은 값 공유) ──
  const clickJobs = [
    ['donate',  () => countTodayCached('donate_clicks')],
    ['support', () => countTodayCached('support_topbtn_clicks')],
    ['snack',   () => countTodayCached('snack_clicks')],
    ['share',   () => countTodayCached('share_clicks')],
    ['pack',    () => countTodayCached('supporterpack_clicks')],
  ];
  const userJobs = [
    // 전체 유저 수 = rankings(점수 등록 닉네임) count — users 컬렉션은 "계정 연동 유저만" 있어서
    // 전체 수가 아님(레거시 유저 다수 누락). rankings는 닉네임당 문서 1개라 중복도 없음.
    ['totalUsers', () => cache.get('home:totalUsers', () => countQuery(collection(db, 'rankings')))],
    // 오늘 신규 = 오늘 첫 플레이 (분석 그래프·주간 합계와 동일한 기준·동일한 캐시)
    ['newUsers',   () => todayNewUsersCount()],
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

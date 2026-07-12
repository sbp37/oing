// ══════════════════════════════════════════════════════════════
//  stats.js — 날짜별 집계(dailyStats) 공용 모듈
//
//  문제: 14일 그래프를 그릴 때마다 visit_sessions 원본 수천 건을
//        다시 읽으면 읽기 비용이 데이터 증가에 비례해 커진다.
//  해결: 지난 날짜(변하지 않는 데이터)는 한 번만 집계해서
//        dailyStats/{YYYY-MM-DD} 문서 1개로 저장해두고,
//        이후에는 날짜당 문서 1개(읽기 1회)만 읽는다.
//
//   dailyStats/2026-07-12 = {
//     date, sessions, uniqueVisitors, visitorKeys[], newUsers,
//     gamePlays, gameStarts, bounces, avgDurationSec,
//     sessionsByHour[24], donateClicks, supportClicks,
//     snackClicks, shareClicks, computedAt, final
//   }
//
//  · 지난 날짜: dailyStats 문서 읽기 → 없으면 원본에서 1회 집계 후 저장(백필)
//  · 오늘: 항상 원본(visit_sessions where date==오늘)에서 실시간 계산
//  · dailyStats 쓰기가 보안 규칙에 막히면 localStorage에 캐시해서
//    같은 기기에서라도 재집계가 반복되지 않게 한다 (기능은 동일하게 동작)
//  · 기존 컬렉션/데이터는 일절 건드리지 않는 "추가 전용" 구조
// ══════════════════════════════════════════════════════════════
import {
  db, collection, doc, query, where, orderBy, limit,
  fetchDocs, fetchDoc, setDoc, countQuery,
  getTodayDateStr, daysAgoDateStr, cache,
} from './firebase.js';

export const SESSION_FETCH_CAP = 1000; // 하루 세션 원본 조회 상한 (폭주 방지)
const LS_PREFIX = 'oeing_admin_dailystats_';

// 집계 로직 버전 — 기준이 바뀌면 올린다. 저장된 dailyStats의 v가 다르면 그 날짜만 1회 재집계.
// v2: 신규 유저 기준을 users.createdAt(=계정 연결 시각, 가입일 아님!)에서
//     user_stats.firstPlayed(=첫 플레이 시각, 실제 가입 개념)로 교정.
export const STATS_V = 2;

// 게임의 방문 세션 하트비트: 진입 시 + 60초 + 이후 120초 간격(최대 3회) + 게임 시작/종료/숨김 이벤트.
// → 활동 중인 유저의 lastSeenTs는 늦어도 2~3분 안에 갱신되므로 5분 이내면 "현재 접속 중"으로 판정.
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// dailyStats 저장이 보안 규칙에 막혔는지 여부 — 분석 탭에서 안내 표시용
export const dailyStatsWriteState = { blocked: false };

// ── 오늘 세션 원본 (홈/분석 탭이 공유 — 같은 데이터 중복 조회 방지) ──
// lastSeenTs 범위 + 같은 필드 정렬(복합 인덱스 불필요)이라,
// 세션이 상한을 넘어도 "가장 최근" 세션부터 확보된다 (임의 잘림 방지).
export async function getTodaySessions({ force = false } = {}) {
  if (force) {
    cache.bust('shared:todaySessions');
    cache.bust('shared:todayCount'); // 오늘 클릭/신규 카운트도 함께 갱신 (홈/분석이 공유)
  }
  return cache.get('shared:todaySessions', async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return fetchDocs(query(
      collection(db, 'visit_sessions'),
      where('lastSeenTs', '>=', start.getTime()),
      orderBy('lastSeenTs', 'desc'),
      limit(SESSION_FETCH_CAP),
    ));
  });
}

// 세션 문서 배열 → 하루 통계로 집계 (순수 계산, 조회 없음)
export function aggregateSessions(date, sessions) {
  const byVisitor = new Map();
  const sessionsByHour = new Array(24).fill(0);
  let gamePlays = 0, totalDur = 0, bounces = 0, startedSessions = 0;
  for (const s of sessions) {
    const key = s.visitorKey || s.sessionId || s.id;
    const prev = byVisitor.get(key) || { plays: 0, dur: 0, started: false, nickname: '', lastSeenTs: 0 };
    prev.plays += (s.playCount || 0);
    prev.dur += (s.durationSec || 0);
    prev.started = prev.started || !!s.playStarted;
    if ((s.lastSeenTs || 0) > prev.lastSeenTs) prev.lastSeenTs = s.lastSeenTs || 0;
    if (s.nickname) prev.nickname = s.nickname;
    byVisitor.set(key, prev);

    gamePlays += (s.playCount || 0);
    totalDur += (s.durationSec || 0);
    if (s.playStarted) startedSessions++;
    if (!s.playStarted && (s.durationSec || 0) < 15) bounces++;
    if (s.enterTs) sessionsByHour[new Date(s.enterTs).getHours()]++;
  }
  const uniqueVisitors = byVisitor.size;
  const startedVisitors = [...byVisitor.values()].filter(v => v.started).length;
  return {
    date,
    truncated: sessions.length >= SESSION_FETCH_CAP, // 상한 도달 = 일부만 집계된 근사치

    sessions: sessions.length,
    uniqueVisitors,
    visitorKeys: [...byVisitor.keys()].slice(0, 3000), // WAU/재방문율 계산용 (상한)
    gamePlays,
    gameStarts: startedSessions,
    startRate: uniqueVisitors ? Math.round(startedVisitors / uniqueVisitors * 100) : 0,
    bounces,
    bounceRate: sessions.length ? Math.round(bounces / sessions.length * 100) : 0,
    avgDurationSec: sessions.length ? Math.round(totalDur / sessions.length) : 0,
    sessionsByHour,
    _byVisitor: byVisitor, // 오늘 MVP/최근접속 계산용 (Firestore에는 저장하지 않음)
  };
}

function dayStartTs(dateStr) { return new Date(dateStr + 'T00:00:00').getTime(); }
function nextDayStartTs(dateStr) { return dayStartTs(dateStr) + 86400000; }

// 지난 하루치를 원본에서 집계 (visit_sessions 1쿼리 + count 5회)
async function computeDayFromRaw(dateStr) {
  const sessions = await fetchDocs(query(
    collection(db, 'visit_sessions'),
    where('date', '==', dateStr),
    limit(SESSION_FETCH_CAP),
  ));
  const agg = aggregateSessions(dateStr, sessions);
  delete agg._byVisitor;
  // 신규 유저 수 = 그날 처음 플레이한 유저 (user_stats.firstPlayed 기준).
  // ⚠️ users.createdAt은 "계정 연결 시각"이라 가입일이 아님 — 절대 신규 기준으로 쓰지 않는다.
  try {
    agg.newUsers = await countQuery(
      collection(db, 'user_stats'),
      where('firstPlayed', '>=', dayStartTs(dateStr)),
      where('firstPlayed', '<', nextDayStartTs(dateStr)),
    );
  } catch { agg.newUsers = null; }
  // 후원/공유 클릭 수 — count 집계 (문서당 읽기 아님)
  const clickCols = [
    ['donateClicks', 'donate_clicks'],
    ['supportClicks', 'support_topbtn_clicks'],
    ['snackClicks', 'snack_clicks'],
    ['shareClicks', 'share_clicks'],
  ];
  for (const [field, col] of clickCols) {
    try { agg[field] = await countQuery(collection(db, col), where('date', '==', dateStr)); }
    catch { agg[field] = null; }
  }
  return agg;
}

function lsGet(dateStr) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + dateStr);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function lsSet(dateStr, stats) {
  try { localStorage.setItem(LS_PREFIX + dateStr, JSON.stringify(stats)); } catch {}
}

// 지난 하루치 통계 — ① 메모리 → ② localStorage → ③ dailyStats 문서 → ④ 원본 집계(+저장)
// allowBackfill:false 면 ④(원본 집계)를 하지 않고 null 반환 — 홈 탭용.
// 원본 백필은 분석 탭에서만 실행돼서 홈 최초 진입이 가볍게 유지된다.
export async function getPastDayStats(dateStr, { allowBackfill = true } = {}) {
  const key = 'shared:dailyStats:' + dateStr;
  const hit = cache.peek(key);
  if (hit !== undefined) return hit;

  // v가 다른(구버전 기준으로 집계된) 캐시는 무시하고 1회 재집계한다
  const isValid = (d) => d && d.final && d.v === STATS_V;
  const local = lsGet(dateStr);
  if (isValid(local)) { cache.set(key, local); return local; }

  const ref = doc(db, 'dailyStats', dateStr);
  try {
    const existing = await fetchDoc(ref);
    if (isValid(existing)) { lsSet(dateStr, existing); cache.set(key, existing); return existing; }
  } catch { /* 읽기 권한 없으면 아래로 진행 */ }

  if (!allowBackfill) return null; // 미집계 — 캐시하지 않음 (분석 탭이 나중에 백필)

  const computed = await computeDayFromRaw(dateStr);
  computed.final = true;               // 지난 날짜 = 확정 데이터
  computed.v = STATS_V;
  computed.computedAt = Date.now();
  lsSet(dateStr, computed);
  cache.set(key, computed);
  // 다음부터는 문서 1개만 읽으면 되도록 저장 — 실패해도(규칙 차단 등) 기능엔 지장 없음
  try { await setDoc(ref, computed); }
  catch (e) {
    dailyStatsWriteState.blocked = true;
    console.warn('dailyStats 저장 불가(이 기기 localStorage 캐시로 대체):', e && e.code);
  }
  return computed;
}

// 최근 N일 통계 (오늘 포함) — 오늘은 항상 라이브 계산.
// allowBackfill:false 면 미집계 날짜는 null로 채워짐.
export async function getDailyStatsRange(days, { force = false, allowBackfill = true } = {}) {
  const today = getTodayDateStr();
  const out = [];
  for (let i = days - 1; i >= 1; i--) {
    out.push(await getPastDayStats(daysAgoDateStr(i), { allowBackfill }));
  }
  const todaySessions = await getTodaySessions({ force });
  const todayAgg = aggregateSessions(today, todaySessions);
  out.push(todayAgg);
  return out;
}

// ── 오늘 카운트 공용 캐시 — 홈/분석이 같은 값을 두 번 세지 않게 ──
export function countTodayCached(colName) {
  return cache.get('shared:todayCount:' + colName, () =>
    countQuery(collection(db, colName), where('date', '==', getTodayDateStr())));
}
// 오늘 신규 유저 = 오늘 처음 플레이한 유저 (홈 타일·분석 그래프·주간 합계가 전부 이 값 하나를 공유)
export function todayNewUsersCount() {
  return cache.get('shared:todayCount:newUsers', () =>
    countQuery(collection(db, 'user_stats'), where('firstPlayed', '>=', dayStartTs(getTodayDateStr()))));
}

// WAU: 최근 7일 고유 방문자 합집합 / 재방문율: 오늘 방문자 중 지난 6일에도 온 비율
// 미집계 날짜(null)는 건너뛰고 missingDays 로 개수를 알려준다.
export function computeWeeklyMetrics(dailyList) {
  const last7 = dailyList.slice(-7);
  const missingDays = last7.filter(d => !d).length;
  const present = last7.filter(Boolean);
  const union = new Set();
  for (const d of present) for (const k of (d.visitorKeys || [])) union.add(k);
  const today = dailyList[dailyList.length - 1];
  const prevKeys = new Set();
  for (const d of present) {
    if (today && d.date === today.date) continue;
    for (const k of (d.visitorKeys || [])) prevKeys.add(k);
  }
  const todayKeys = today ? (today.visitorKeys || []) : [];
  const returning = todayKeys.filter(k => prevKeys.has(k)).length;
  return {
    wau: union.size,
    returnRate: todayKeys.length ? Math.round(returning / todayKeys.length * 100) : 0,
    returning,
    missingDays,
  };
}

#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// session-outage-tool.mjs — 2026-08 랭킹 누락 장애 진단 + 복구
//
// 배경: startSession 이 실패하면 클라가 sessionId 없이 점수를 올리고, 서버는
//       NO_SESSION 판정 → 판정 v4부터 보류(pending_review) → 랭킹·주간랭킹 미반영.
//       2026-08-10 주 주간랭킹이 전원 0이 된 장애.
//
// 모드
//   inspect (기본, 읽기 전용)
//     · startSession / submitScore 콜러블이 실제로 도달 가능한지 (403이면 과거
//       Incident D = Cloud Run roles/run.invoker 바인딩 누락과 동일 증상)
//     · weekly_rankings 에 어떤 주차 문서가 몇 건씩 있는지 (서버·클라 주차 불일치 확인)
//     · 보류(pending_review) 중 "NO_SESSION 만 걸린" 건이 몇 건인지 + 문서 구조 샘플
//   apply (실제 반영)
//     · 위에서 고른 건들을 rankings / weekly_rankings 에 max 로 올리고
//       세션을 accepted 로 표시 + score_recoveries 감사 로그
//
// ⚠️ 이 저장소는 공개라 실행 로그도 공개된다. 닉네임·UID는 전부 마스킹해서 찍는다.
// ─────────────────────────────────────────────────────────────────────────────

const {
  PROJECT_ID = 'oing-game',
  REGION = 'asia-northeast3',
  WEB_API_KEY = 'AIzaSyBzDEJyVEUtrbIeAqwTwbF9FszEmtAw0jg', // 공개 웹 키(클라에 이미 노출된 값)
  MODE = 'inspect',
  LIMIT = '300',
} = process.env;

const CF_BASE = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;
const APPROVE_SCORE_MAX = 150000; // 서버 adminApprove 와 동일
const STRONG = ['SCORE_OVER_OFFICIAL_CAP', 'IMPOSSIBLE_BURST', 'COMPOSITE_ANOMALY',
  'LEDGER_SCORE_MISMATCH', 'COMBO_GT_CLEARS', 'BURST_GT_CLEARS'];

// 닉네임/UID 마스킹 — 공개 로그에 원문을 남기지 않는다
const mask = (s) => {
  const t = String(s || '');
  if (!t) return '(빈값)';
  if (t.length <= 2) return t[0] + '*';
  return t[0] + '*'.repeat(Math.min(t.length - 2, 6)) + t[t.length - 1];
};

// KST 기준 이번 주 월요일 (클라 getWeekId 와 같은 규칙)
function kstWeekId(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const day = kst.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  kst.setUTCDate(kst.getUTCDate() - diffToMonday);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}-${String(kst.getUTCDate()).padStart(2, '0')}`;
}

// ── 1) 콜러블 도달성 ──────────────────────────────────────────────────────────
async function probeCallables() {
  console.log('\n══ 1. Cloud Functions 도달성 ══');
  let idToken;
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
    const body = await res.json().catch(() => ({}));
    if (!body.idToken) { console.log(`  ❌ 익명 로그인 실패 (${res.status}) — 이것부터 문제`); return; }
    idToken = body.idToken;
    console.log('  익명 로그인: OK');
  } catch (e) { console.log(`  ❌ 익명 로그인 네트워크 오류: ${e.message}`); return; }

  for (const fn of ['startSession', 'submitScore']) {
    try {
      const t0 = Date.now();
      const res = await fetch(`${CF_BASE}/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        // submitScore 는 빈 payload → 서버가 invalid-argument 로 거절(랭킹 오염 없음)
        body: JSON.stringify({ data: fn === 'startSession' ? {} : {} }),
      });
      const text = (await res.text()).slice(0, 300);
      const ms = Date.now() - t0;
      console.log(`  ${fn}: HTTP ${res.status} (${ms}ms)`);
      console.log(`    ${text}`);
      if (res.status === 403 && !text.includes('permission-denied')) {
        console.log(`    🔴 403(앱 레벨 아님) — Cloud Run roles/run.invoker 바인딩 누락 의심 (과거 Incident D 와 동일)`);
      } else if (res.status === 404) {
        console.log(`    🔴 404 — 함수가 배포돼 있지 않음`);
      } else if (res.ok) {
        console.log(`    ✅ 정상 도달`);
      }
    } catch (e) {
      console.log(`  ${fn}: 네트워크 오류 — ${e.message}`);
    }
  }
}

// ── 2) 주간랭킹 주차 분포 ─────────────────────────────────────────────────────
async function inspectWeeks(db) {
  console.log('\n══ 2. weekly_rankings 주차 분포 ══');
  console.log(`  이 스크립트가 계산한 이번 주(KST): ${kstWeekId()}`);
  const cols = await db.collection('weekly_rankings').listDocuments();
  if (!cols.length) { console.log('  (weekly_rankings 하위 문서 없음)'); return; }
  const rows = [];
  for (const ref of cols) {
    const n = (await ref.collection('scores').count().get()).data().count;
    rows.push([ref.id, n]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  for (const [id, n] of rows.slice(0, 8)) {
    console.log(`  ${id} : ${n}건${id === kstWeekId() ? '  ← 이번 주' : ''}`);
  }
}

// ── 3) 보류 세션 ─────────────────────────────────────────────────────────────
function classify(d) {
  const reasons = Array.isArray(d?.official?.reasons) ? d.official.reasons : [];
  const strong = reasons.filter((r) => STRONG.includes(r));
  return { reasons, strong, noSession: reasons.includes('NO_SESSION') };
}

async function findPending(db, limit) {
  const snap = await db.collection('game_sessions')
    .where('official.decision', '==', 'pending_review')
    .orderBy('official.decidedAt', 'desc')
    .limit(limit).get();
  return snap.docs;
}

async function inspectPending(db, limit) {
  console.log('\n══ 3. 보류(pending_review) 세션 ══');
  const docs = await findPending(db, limit);
  console.log(`  최근 ${docs.length}건 조회 (limit ${limit})`);
  const reasonCount = new Map();
  let eligible = 0;
  for (const doc of docs) {
    const { reasons, strong, noSession } = classify(doc.data());
    for (const r of reasons) reasonCount.set(r, (reasonCount.get(r) || 0) + 1);
    if (noSession && !strong.length) eligible++;
  }
  console.log('  사유별 건수:');
  for (const [r, n] of [...reasonCount].sort((a, b) => b[1] - a[1])) console.log(`    ${r}: ${n}`);
  console.log(`  ▶ 복구 대상(NO_SESSION 만, 강한 의심 없음): ${eligible}건`);

  // 대상이 어느 주차 것인지 — 옛날 기록을 이번 주에 몰아넣지 않도록 미리 확인
  const byWeek = new Map();
  for (const doc of docs) {
    const s = doc.data();
    const { strong, noSession } = classify(s);
    if (!noSession || strong.length) continue;
    const t = Number(s.submittedAt) || Number(s?.official?.decidedAt) || 0;
    const w = t ? kstWeekId(new Date(t)) : '(시각없음)';
    byWeek.set(w, (byWeek.get(w) || 0) + 1);
  }
  console.log('  대상의 플레이 주차 분포:');
  for (const [w, n] of [...byWeek].sort((a, b) => (a[0] < b[0] ? 1 : -1))) console.log(`    ${w}: ${n}건`);

  const sample = docs.find((d) => { const c = classify(d.data()); return c.noSession && !c.strong.length; });
  if (sample) {
    const s = sample.data();
    console.log('  샘플 문서 구조(마스킹):');
    console.log(`    nickname=${mask(s.nickname)} uid=${mask(s.uid)} finalScore=${s?.client?.finalScore}`);
    console.log(`    official=${JSON.stringify(s.official)}`);
    console.log(`    최상위 키: ${Object.keys(s).join(', ')}`);
    const rk = await db.collection('rankings').doc(String(s.nickname || '')).get();
    console.log(`    rankings 문서 존재=${rk.exists} 키=${rk.exists ? Object.keys(rk.data()).join(', ') : '-'}`);
    const wk = await db.collection('weekly_rankings').doc(kstWeekId()).collection('scores').doc(String(s.nickname || '')).get();
    console.log(`    이번주 weekly 문서 존재=${wk.exists}${wk.exists ? ` score=${wk.data().score}` : ''}`);
  }
  return docs;
}

// ── 4) 복구 반영 ─────────────────────────────────────────────────────────────
async function applyRecovery(db, admin, limit) {
  console.log('\n══ 4. 복구 반영(apply) ══');
  const docs = await findPending(db, limit);
  const perWeek = new Map();
  let done = 0, skipped = 0, failed = 0;
  for (const doc of docs) {
    const s = doc.data();
    const { strong, noSession } = classify(s);
    const nick = String(s.nickname || '').trim();
    const score = Number(s?.client?.finalScore);
    if (!noSession || strong.length) { skipped++; continue; }
    if (!nick || !Number.isFinite(score) || score <= 0) { skipped++; continue; }
    if (score > APPROVE_SCORE_MAX) { console.log(`  건너뜀(상한초과) ${mask(nick)} ${score}`); skipped++; continue; }
    // ⚠️ 보류 건은 여러 주에 걸쳐 쌓여 있다. "지금 주차"에 몰아넣으면 이번 주 랭킹이
    //    옛날 점수로 오염되므로, 그 판을 실제로 친 주차에 넣는다.
    const playedAt = Number(s.submittedAt) || Number(s?.official?.decidedAt) || 0;
    if (!playedAt) { console.log(`  건너뜀(시각없음) ${mask(nick)}`); skipped++; continue; }
    const weekId = kstWeekId(new Date(playedAt));
    perWeek.set(weekId, (perWeek.get(weekId) || 0) + 1);
    try {
      await db.runTransaction(async (tx) => {
        const rRef = db.collection('rankings').doc(nick);
        const wRef = db.collection('weekly_rankings').doc(weekId).collection('scores').doc(nick);
        const [rSnap, wSnap] = await Promise.all([tx.get(rRef), tx.get(wRef)]);
        const now = Date.now();
        // 되돌릴 수 있도록 직전 값을 먼저 붙잡아 둔다(일괄 쓰기라 원복 근거가 반드시 필요).
        const prevRank = rSnap.exists ? (Number(rSnap.data().score) || 0) : null;
        const prevWeek = wSnap.exists ? (Number(wSnap.data().score) || 0) : null;
        const rankingUpdated = prevRank === null || prevRank < score;
        const weeklyUpdated = prevWeek === null || prevWeek < score;
        if (rankingUpdated) {
          tx.set(rRef, { nickname: nick, score, ts: now, ...(s.uid ? { uid: s.uid } : {}) }, { merge: true });
        }
        if (weeklyUpdated) {
          tx.set(wRef, { nickname: nick, score, ts: now, ...(s.uid ? { uid: s.uid } : {}) }, { merge: true });
        }
        tx.set(doc.ref, {
          official: { ...(s.official || {}), decision: 'accepted', approvedBy: 'outage-recovery-2026-08', approvedAt: now },
        }, { merge: true });
        tx.set(db.collection('score_recoveries').doc(), {
          source: 'outage-recovery-2026-08', sessionId: doc.id, nickname: nick,
          uid: s.uid || '', score, weekId, at: now,
          prevRank, prevWeek, rankingUpdated, weeklyUpdated, // ← 원복용 스냅샷
        });
      });
      done++;
    } catch (e) {
      failed++;
      console.log(`  실패 ${mask(nick)}: ${e.message}`);
    }
  }
  console.log(`  ▶ 반영 ${done}건 · 건너뜀 ${skipped}건 · 실패 ${failed}건`);
  console.log('  주차별 반영 시도:');
  for (const [w, n] of [...perWeek].sort((a, b) => (a[0] < b[0] ? 1 : -1))) console.log(`    ${w}: ${n}건`);
}

// ── 5) 이번 주 복구 (user_stats 기반) ────────────────────────────────────────
// 서버(Cloud Functions)가 결제 정지로 죽어 있던 동안의 기록은 game_sessions 에 아예
// 남지 않았다. 유일하게 살아남은 기록이 user_stats — 클라이언트가 직접 쓰는 문서라
// 서버 장애의 영향을 받지 않았다.
//
// ⚠️ 클라 기록이라 서버 검증을 거치지 않았다. 그래서 공식 상한(50,000) 이상은 반영하지
//    않고 목록만 남긴다. 그 이상은 사람이 직접 판단해야 한다.
const CLIENT_RECOVER_MAX = 50000;

// 어드민의 todaysBestScoreClient 와 동일한 계산 (그 날 실제로 친 판들 중 최고점)
function bestScoreOfDay(s, day) {
  if (!s) return 0;
  if (s.lastPlayDate !== day && s.dailyDate !== day) return 0;
  const recent = Array.isArray(s.recentScores) ? s.recentScores.filter((x) => Number.isInteger(x) && x >= 0) : [];
  if (!recent.length) return (Number.isInteger(s.lastScore) && s.lastScore > 0) ? s.lastScore : 0;
  const dpc = (Number.isInteger(s.dailyPlayCount) && s.dailyPlayCount > 0) ? s.dailyPlayCount : recent.length;
  const n = Math.max(1, Math.min(dpc, recent.length));
  return Math.max(...recent.slice(-n));
}

async function recoverThisWeek(db, write) {
  const weekId = kstWeekId();
  console.log(`\n══ 5. 이번 주(${weekId}) 복구 — user_stats 기반 ${write ? '[반영]' : '[미리보기]'} ══`);
  // 이번 주 월요일 이후에 마지막으로 플레이한 유저만 (문자열 날짜라 범위 비교 가능)
  const snap = await db.collection('user_stats').where('lastPlayDate', '>=', weekId).get();
  console.log(`  이번 주 플레이 기록이 있는 user_stats: ${snap.size}명`);

  const cands = [];
  for (const d of snap.docs) {
    const s = d.data();
    const nick = String(s.nickname || d.id || '').trim();
    if (!nick) continue;
    const day = String(s.lastPlayDate || '');
    const best = bestScoreOfDay(s, day);
    if (!Number.isInteger(best) || best <= 0) continue;
    cands.push({ nick, best, day, uid: s.uid || '' });
  }
  cands.sort((a, b) => b.best - a.best);
  console.log(`  점수가 있는 대상: ${cands.length}명`);

  const over = cands.filter((c) => c.best > CLIENT_RECOVER_MAX);
  if (over.length) {
    console.log(`  ⚠️ 상한(${CLIENT_RECOVER_MAX}) 초과라 자동 반영 제외 — 사람이 판단 필요:`);
    for (const c of over) console.log(`     ${mask(c.nick)} ${c.best}pt (${c.day})`);
  }
  const targets = cands.filter((c) => c.best <= CLIENT_RECOVER_MAX);
  console.log(`  자동 반영 대상: ${targets.length}명 (상위 10명만 표시)`);
  for (const c of targets.slice(0, 10)) console.log(`     ${mask(c.nick)} ${c.best}pt (${c.day})`);

  if (!write) { console.log('  (미리보기 — 아무것도 쓰지 않았습니다)'); return; }

  let done = 0, nochange = 0, failed = 0;
  for (const c of targets) {
    try {
      await db.runTransaction(async (tx) => {
        const rRef = db.collection('rankings').doc(c.nick);
        const wRef = db.collection('weekly_rankings').doc(weekId).collection('scores').doc(c.nick);
        const [rSnap, wSnap] = await Promise.all([tx.get(rRef), tx.get(wRef)]);
        const now = Date.now();
        const prevRank = rSnap.exists ? (Number(rSnap.data().score) || 0) : null;
        const prevWeek = wSnap.exists ? (Number(wSnap.data().score) || 0) : null;
        const rankingUpdated = prevRank === null || prevRank < c.best;
        const weeklyUpdated = prevWeek === null || prevWeek < c.best;
        if (!rankingUpdated && !weeklyUpdated) return;
        if (rankingUpdated) tx.set(rRef, { nickname: c.nick, score: c.best, ts: now, ...(c.uid ? { uid: c.uid } : {}) }, { merge: true });
        if (weeklyUpdated) tx.set(wRef, { nickname: c.nick, score: c.best, ts: now, ...(c.uid ? { uid: c.uid } : {}) }, { merge: true });
        tx.set(db.collection('score_recoveries').doc(), {
          source: 'userstats-week-recovery-2026-08', nickname: c.nick, uid: c.uid,
          score: c.best, weekId, playedDate: c.day, at: now,
          prevRank, prevWeek, rankingUpdated, weeklyUpdated,
          note: '서버 장애(결제정지) 기간 기록 — 출처는 클라이언트 user_stats',
        });
        done++;
      });
    } catch (e) { failed++; console.log(`  실패 ${mask(c.nick)}: ${e.message}`); }
  }
  nochange = targets.length - done - failed;
  console.log(`  ▶ 반영 ${done}명 · 이미 같거나 높음 ${nochange}명 · 실패 ${failed}명`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`모드: ${MODE} · 프로젝트: ${PROJECT_ID}`);
  await probeCallables();

  const admin = (await import('firebase-admin')).default;
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();

  await inspectWeeks(db);
  await inspectPending(db, Number(LIMIT) || 300);

  if (MODE === 'apply') {
    await applyRecovery(db, admin, Number(LIMIT) || 300);
    await inspectWeeks(db); // 반영 후 재확인
  } else if (MODE === 'apply-week') {
    await recoverThisWeek(db, true);
    await inspectWeeks(db); // 반영 후 재확인
  } else {
    await recoverThisWeek(db, false); // 미리보기(쓰기 없음)
    console.log('\n(읽기 전용 모드 — 아무것도 쓰지 않았습니다.');
    console.log(' 보류 세션 복구 = MODE=apply / 이번 주 user_stats 복구 = MODE=apply-week)');
  }
}

main().catch((e) => { console.error('FAIL —', e); process.exit(1); });

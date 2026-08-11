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
        if (!rSnap.exists || (Number(rSnap.data().score) || 0) < score) {
          tx.set(rRef, { nickname: nick, score, ts: now, ...(s.uid ? { uid: s.uid } : {}) }, { merge: true });
        }
        if (!wSnap.exists || (Number(wSnap.data().score) || 0) < score) {
          tx.set(wRef, { nickname: nick, score, ts: now, ...(s.uid ? { uid: s.uid } : {}) }, { merge: true });
        }
        tx.set(doc.ref, {
          official: { ...(s.official || {}), decision: 'accepted', approvedBy: 'outage-recovery-2026-08', approvedAt: now },
        }, { merge: true });
        tx.set(db.collection('score_recoveries').doc(), {
          source: 'outage-recovery-2026-08', sessionId: doc.id, nickname: nick,
          uid: s.uid || '', score, weekId, at: now,
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
  } else {
    console.log('\n(읽기 전용 모드 — 아무것도 쓰지 않았습니다. 실제 반영은 MODE=apply)');
  }
}

main().catch((e) => { console.error('FAIL —', e); process.exit(1); });

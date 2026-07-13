#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verify-session-mismatch-fix.mjs — live production check for the score-
// registration path. Two things:
//  (1) 세션 UID 불일치/유실 인시던트(2026-07-13, 먹보/쑤)가 재발 안 하는지 —
//      submitScore가 이 경우 throw 대신 NO_SESSION처럼 accepted 처리하는지.
//  (2) 정상 유저가 한 판 끝냈을 때 점수가 실제로 rankings에 저장되는지(영속성)를
//      공개 REST로 되읽어 end-to-end 확인. (5만 상한/버스트 방어는 그대로.)
//
// Self-contained: creates two throwaway ANONYMOUS Firebase Auth users on each
// run (no pre-provisioned test account / secrets needed). Uses a clearly
// test-marked nickname + a tiny score (1) so any leftover rankings entry is
// harmless and sinks to the very bottom of the leaderboard.
//
//   PROJECT_ID   e.g. oing-game        (env, has default below)
//   REGION       asia-northeast3       (env, has default below)
//   WEB_API_KEY  Firebase Web API key  (env, has default below — it's the
//                same public key already shipped in index.html)
//
// Run: node test/verify-session-mismatch-fix.mjs
// ─────────────────────────────────────────────────────────────────────────────

const {
  PROJECT_ID = 'oing-game',
  REGION = 'asia-northeast3',
  WEB_API_KEY = 'AIzaSyBzDEJyVEUtrbIeAqwTwbF9FszEmtAw0jg',
} = process.env;

const CF_BASE = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;

function fail(msg) {
  console.error(`verify: FAIL — ${msg}`);
  process.exit(1);
}

async function signUpAnon() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.idToken) fail(`anonymous sign-up failed (${res.status}): ${JSON.stringify(body)}`);
  return { uid: body.localId, idToken: body.idToken };
}

async function callCallable(name, data, idToken) {
  const res = await fetch(`${CF_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

function testPayload(tag) {
  // nickname은 서버에서 40자 상한 — 짧게 유지
  return {
    nickname: `_vsf_${tag}_${Date.now()}`.slice(0, 40),
    finalScore: 1, clearCount: 1, resetCount: 0, maxCombo: 1, maxSuccessesIn3Sec: 1, failCount: 0,
  };
}

async function main() {
  const userA = await signUpAnon();
  const userB = await signUpAnon();
  console.log(`verify: userA=${userA.uid} userB=${userB.uid}`);

  const start = await callCallable('startSession', {}, userA.idToken);
  if (start.status !== 200) fail(`startSession HTTP ${start.status}: ${JSON.stringify(start.json)}`);
  const sessionId = start.json.result && start.json.result.sessionId;
  if (!sessionId) fail(`startSession returned no sessionId: ${JSON.stringify(start.json)}`);
  console.log(`verify: session ${sessionId} owned by userA`);

  // ── Scenario 1: session UID mismatch — userB submits using userA's sessionId ──
  const mismatch = await callCallable('submitScore', { sessionId, ...testPayload('mismatch') }, userB.idToken);
  if (mismatch.status !== 200) {
    fail(`session-mismatch case: got HTTP ${mismatch.status} — old silent-drop bug is BACK: ${JSON.stringify(mismatch.json)}`);
  }
  if (mismatch.json.error) {
    fail(`session-mismatch case: still throws ${mismatch.json.error.status} — old silent-drop bug is BACK: ${JSON.stringify(mismatch.json.error)}`);
  }
  if (!mismatch.json.result || mismatch.json.result.decision !== 'accepted') {
    fail(`session-mismatch case: expected decision=accepted, got: ${JSON.stringify(mismatch.json.result)}`);
  }
  console.log('verify: PASS — session-mismatch submission now accepted (no silent drop)');

  // ── Scenario 2: sessionId that doesn't exist (e.g. TTL-expired) ──
  const missing = await callCallable('submitScore', { sessionId: 'nonexistent_session_verify', ...testPayload('missing') }, userB.idToken);
  if (missing.status !== 200) {
    fail(`missing-session case: got HTTP ${missing.status} — old silent-drop bug is BACK: ${JSON.stringify(missing.json)}`);
  }
  if (missing.json.error) {
    fail(`missing-session case: still throws ${missing.json.error.status} — old silent-drop bug is BACK: ${JSON.stringify(missing.json.error)}`);
  }
  if (!missing.json.result || missing.json.result.decision !== 'accepted') {
    fail(`missing-session case: expected decision=accepted, got: ${JSON.stringify(missing.json.result)}`);
  }
  console.log('verify: PASS — missing-session submission now accepted (no silent drop)');

  // ── Scenario 3: "정상 한 판이 실제로 랭킹에 저장되는가" — end-to-end 영속성 확인 ──
  // 세션 없이(sessionId 생략) 유효 점수를 제출 → accepted → rankings 문서에 진짜 써졌는지
  // 공개 REST로 되읽어 확인. (accepted 응답만 믿지 않고 실제 저장까지 검증)
  const persistPayload = testPayload('persist');
  const persist = await callCallable('submitScore', persistPayload, userA.idToken);
  if (persist.status !== 200 || persist.json.error) {
    fail(`persist case: submit failed — ${JSON.stringify(persist.json)}`);
  }
  const pres = persist.json.result || {};
  if (pres.decision !== 'accepted') fail(`persist case: expected accepted, got ${JSON.stringify(pres)}`);
  // 실제 rankings 문서 되읽기 (공개 read)
  const encNick = encodeURIComponent(persistPayload.nickname);
  const readRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/rankings/${encNick}`,
  );
  const readBody = await readRes.json().catch(() => ({}));
  const savedScore = readBody && readBody.fields && readBody.fields.score
    ? Number(readBody.fields.score.integerValue) : null;
  if (savedScore !== persistPayload.finalScore) {
    fail(`persist case: score NOT persisted to rankings — expected ${persistPayload.finalScore}, got ${savedScore} (${JSON.stringify(readBody).slice(0, 200)})`);
  }
  console.log(`verify: PASS — normal submission actually persisted to rankings (score ${savedScore})`);

  console.log('verify: ALL CHECKS PASSED — 정상 점수 등록 경로 + 세션 완화 라이브 확인 완료.');
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));

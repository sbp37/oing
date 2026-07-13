#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verify-session-mismatch-fix.mjs — live production check for the "session
// UID mismatch / missing session silently drops the score" incident
// (2026-07-13, 먹보/쑤 report). Confirms the deployed submitScore no longer
// throws (not-found / permission-denied) in these cases, but treats them like
// NO_SESSION and still returns decision:'accepted' (5만 상한/버스트는 그대로).
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

  console.log('verify: ALL CHECKS PASSED — 2026-07-13 session-mismatch incident fix confirmed live.');
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));

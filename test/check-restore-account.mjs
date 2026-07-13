#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-restore-account.mjs — one-off diagnostic (NOT a regression test kept
// long-term). Checks whether the `restoreAccount` callable (used for
// "다른 기기 이어하기" / 계정 연결) is actually reachable in production.
// A user reported "서버 확인에 실패했어요" when using 계정 연결 — this pins down
// whether that's a genuine Cloud Functions outage/deploy issue.
//
// Self-contained: creates one throwaway anonymous auth user, calls
// restoreAccount with action:'status' (read-only, no nickname/PIN needed,
// mutates nothing). Just reports whether the call itself succeeds.
// ─────────────────────────────────────────────────────────────────────────────

const {
  PROJECT_ID = 'oing-game',
  REGION = 'asia-northeast3',
  WEB_API_KEY = 'AIzaSyBzDEJyVEUtrbIeAqwTwbF9FszEmtAw0jg',
} = process.env;

const CF_BASE = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;

async function signUpAnon() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.idToken) {
    console.error(`FAIL — anonymous sign-up itself failed (${res.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  return { uid: body.localId, idToken: body.idToken };
}

async function main() {
  console.log(`Target: ${CF_BASE}/restoreAccount`);
  const { uid, idToken } = await signUpAnon();
  console.log(`Signed in as throwaway anon uid: ${uid}`);

  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(`${CF_BASE}/restoreAccount`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ data: { action: 'status' } }),
    });
    text = await res.text();
  } catch (e) {
    console.error(`FAIL — network-level error calling restoreAccount: ${e && e.message}`);
    process.exit(1);
  }
  const elapsed = Date.now() - t0;
  console.log(`HTTP ${res.status} in ${elapsed}ms`);
  console.log(`Body: ${text}`);

  if (!res.ok) {
    console.error(`FAIL — restoreAccount returned non-2xx. This matches a "서버 확인에 실패했어요" client error.`);
    process.exit(1);
  }
  let json;
  try { json = JSON.parse(text); } catch { console.error('FAIL — response not valid JSON'); process.exit(1); }
  if (!json.result || typeof json.result.ready !== 'boolean') {
    console.error(`FAIL — unexpected response shape: ${text}`);
    process.exit(1);
  }
  console.log('OK — restoreAccount(status) reachable and responding correctly.');

  // adminResetPin 배포 여부 확인 — 어드민 UID가 아니므로 permission-denied가 나오면
  // "함수는 배포돼 있고 정상 작동 중"이라는 뜻(권한 검사까지 통과해서 도달했다는 증거).
  // 404/연결 실패면 배포가 안 됐거나 함수명이 다른 것.
  console.log(`\nTarget: ${CF_BASE}/adminResetPin`);
  let res2, text2;
  try {
    res2 = await fetch(`${CF_BASE}/adminResetPin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ data: { nickname: '__diag_probe__', newPin: '1234' } }),
    });
    text2 = await res2.text();
  } catch (e) {
    console.error(`adminResetPin: network-level error: ${e && e.message}`);
    return;
  }
  console.log(`adminResetPin: HTTP ${res2.status}`);
  console.log(`Body: ${text2}`);
  if (res2.status === 403 || (text2 || '').includes('permission-denied')) {
    console.log('OK — adminResetPin is deployed and reachable (rejected non-admin caller as expected).');
  } else if (res2.status === 404) {
    console.log('NOTE — adminResetPin appears NOT deployed (404).');
  } else {
    console.log('NOTE — adminResetPin responded, but not with the expected permission-denied shape.');
  }
}

main().catch((e) => { console.error('FAIL — unexpected error:', e); process.exit(1); });

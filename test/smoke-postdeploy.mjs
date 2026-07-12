#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// smoke-postdeploy.mjs  —  targets Incident C (stale backend deployed) and
//                          Incident D (startSession 403 / IAM invoker missing)
//
// Run this by hand (or in CI) AFTER `firebase deploy`. It calls the two live
// Cloud Functions callables over HTTPS with a throwaway test account and asserts:
//
//   • startSession returns HTTP 200 (NOT 403)          -> catches D (missing
//     Cloud Run "roles/run.invoker" allUsers/authenticated binding => 403
//     "not authenticated"/"forbidden" at the transport layer, before your code runs)
//   • submitScore returns HTTP 200 and a `decision`    -> the pipeline is alive
//   • the returned build/version marker == EXPECTED    -> catches C (old
//     submitScore/startSession got deployed instead of latest)
//
// It does NOT pollute the leaderboard: it submits immediately after starting the
// session, so serverElapsed < MIN_PLAY_MS (30s) => decision `rejected_invalid`
// (ELAPSED_TOO_SHORT) and NOTHING is written to rankings/weekly. Uses a fake
// test nickname regardless.
//
// ── REQUIRES the version marker to exist in the backend (see PROPOSAL below). ──
// Until you add it, run with EXPECTED_VERSION unset to skip only the C check;
// the D check (200 vs 403) works today with zero backend changes.
//
// No npm deps — Node 18+ (global fetch). Node here: v22.
//
// ── WHAT THE OWNER MUST FILL IN (env vars) ───────────────────────────────────
//   PROJECT_ID       e.g. oing-game
//   REGION           asia-northeast3           (Seoul — matches getFunctions region)
//   WEB_API_KEY      Firebase Web API key (Console > Project settings > General)
//   TEST_EMAIL       a throwaway Email/Password auth user you created for smoke
//   TEST_PASSWORD    its password
//   EXPECTED_VERSION the build marker you expect live (e.g. a git short SHA or
//                    the functions package.json version). Omit to skip the C check.
//
// Example:
//   PROJECT_ID=oing-game REGION=asia-northeast3 WEB_API_KEY=AIza... \
//   TEST_EMAIL=smoke@example.com TEST_PASSWORD='...' EXPECTED_VERSION=abc1234 \
//   node test/smoke-postdeploy.mjs
//
// NOTE: If you use Anonymous auth instead of Email/Password, swap signIn() for the
//   Identity Toolkit `accounts:signUp` endpoint (returns an idToken the same way).
// ─────────────────────────────────────────────────────────────────────────────

const {
  PROJECT_ID,
  REGION = 'asia-northeast3',
  WEB_API_KEY,
  TEST_EMAIL,
  TEST_PASSWORD,
  EXPECTED_VERSION, // optional
} = process.env;

function need(name, val) {
  if (!val) {
    console.error(`smoke: missing required env ${name}. See header of this file.`);
    process.exit(2);
  }
}
need('PROJECT_ID', PROJECT_ID);
need('WEB_API_KEY', WEB_API_KEY);
need('TEST_EMAIL', TEST_EMAIL);
need('TEST_PASSWORD', TEST_PASSWORD);

const CF_BASE = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;

function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`);
  process.exit(1);
}

// Sign in the test user -> Firebase ID token (needed; both functions require auth).
async function signIn() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.idToken) fail(`auth sign-in failed (${res.status}): ${JSON.stringify(body)}`);
  return body.idToken;
}

// Call a v2 onCall callable over HTTPS. Contract: POST { "data": {...} },
// Authorization: Bearer <idToken>; success => 200 { "result": {...} }.
async function callCallable(name, data, idToken) {
  const res = await fetch(`${CF_BASE}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

async function main() {
  const idToken = await signIn();

  // ── startSession ──  (Incident D: a missing run.invoker binding => 403 here)
  const start = await callCallable('startSession', {}, idToken);
  if (start.status === 403) {
    fail(
      'startSession returned 403 (Incident D): the Cloud Run invoker IAM binding is ' +
        'missing. Grant it, e.g.:\n' +
        `  gcloud run services add-iam-policy-binding startSession \\\n` +
        `    --region=${REGION} --project=${PROJECT_ID} \\\n` +
        `    --member=allUsers --role=roles/run.invoker\n` +
        '  (or re-run `firebase deploy --only functions:startSession`).',
    );
  }
  if (start.status !== 200) fail(`startSession HTTP ${start.status}: ${JSON.stringify(start.json)}`);
  const startRes = start.json.result || {};
  const sessionId = startRes.sessionId;
  if (!sessionId) fail(`startSession returned no sessionId: ${JSON.stringify(startRes)}`);
  console.log(`smoke: startSession OK (200), sessionId=${sessionId}`);

  // ── submitScore ── immediate submit => elapsed < MIN_PLAY_MS => rejected_invalid,
  //    so NOTHING is written to rankings/weekly. We only assert the pipeline works.
  const payload = {
    sessionId,
    nickname: 'zzz_smoke_test',
    finalScore: 123,
    clearCount: 1,
    resetCount: 0,
    maxCombo: 1,
    maxSuccessesIn3Sec: 1,
    failCount: 0,
  };
  const submit = await callCallable('submitScore', payload, idToken);
  if (submit.status === 403) fail('submitScore returned 403 (Incident D — invoker binding missing).');
  if (submit.status !== 200) fail(`submitScore HTTP ${submit.status}: ${JSON.stringify(submit.json)}`);
  const subRes = submit.json.result || {};
  if (!subRes.decision) fail(`submitScore returned no decision: ${JSON.stringify(subRes)}`);
  console.log(`smoke: submitScore OK (200), decision=${subRes.decision}`);

  // ── version marker ── (Incident C: stale backend deployed)
  // Requires the backend to echo a build marker (see PROPOSAL in this file's PR notes).
  const liveVersion = startRes.version ?? subRes.version;
  if (EXPECTED_VERSION) {
    if (liveVersion == null) {
      fail(
        `EXPECTED_VERSION=${EXPECTED_VERSION} was set but the deployed functions returned no ` +
          `version marker. Add DEPLOY_VERSION to the backend (see proposal) or unset EXPECTED_VERSION.`,
      );
    }
    if (String(liveVersion) !== String(EXPECTED_VERSION)) {
      fail(
        `deployed version "${liveVersion}" != expected "${EXPECTED_VERSION}" (Incident C: ` +
          `stale/old backend is live). Re-deploy the latest, or fix EXPECTED_VERSION.`,
      );
    }
    console.log(`smoke: version OK (${liveVersion})`);
  } else {
    console.log(
      `smoke: version check SKIPPED (EXPECTED_VERSION unset). live marker = ${liveVersion ?? 'none'}.`,
    );
  }

  console.log('smoke: PASS');
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));

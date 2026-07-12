// Firestore 보안 규칙 회귀 테스트 (에뮬레이터 기반, 배포 없음)
//
// 목적: firestore.rules의 "현재 배포 동작"을 고정한다. 새 정책을 만들지 않는다.
// 실행: npm test  (내부적으로 firebase emulators:exec 로 Firestore 에뮬레이터를 띄운 뒤
//                  node --test 로 이 파일을 돌린다 — 실제 운영 Firebase에는 절대 붙지 않는다)
//
// 확인 고정 포인트:
//  - rankings/weekly_rankings score 상한 = 50000, int, 단조
//  - user_stats.bestScore 상한 = 150000  (그래서 102698은 허용, 50001은 rankings에서 거부)
//  - rankings 허용 필드 = score/ts/uid, pin/delpin 재유입 차단, uid 소유권 보호
//  - user_stats jelly 클라이언트 증가 차단
//  - users_private 일반 read 차단

import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';

const PROJECT_ID = 'demo-oing-rules';
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

const unauth = () => testEnv.unauthenticatedContext().firestore();
const asUser = (uid) => testEnv.authenticatedContext(uid).firestore();
const seed = (fn) =>
  testEnv.withSecurityRulesDisabled((ctx) => fn(ctx.firestore()));

// ─────────────── rankings ───────────────
test('rankings: 정상 int score(100) uid-less create 허용', async () => {
  await assertSucceeds(setDoc(doc(unauth(), 'rankings', 'alice'), { score: 100, ts: 1 }));
});
test('rankings: score=0 허용', async () => {
  await assertSucceeds(setDoc(doc(unauth(), 'rankings', 'zero'), { score: 0, ts: 1 }));
});
test('rankings: score=50000(상한) 허용', async () => {
  await assertSucceeds(setDoc(doc(unauth(), 'rankings', 'cap'), { score: 50000, ts: 1 }));
});
test('rankings: score=50001(상한초과) 거부', async () => {
  await assertFails(setDoc(doc(unauth(), 'rankings', 'over'), { score: 50001, ts: 1 }));
});
test('rankings: 음수 score 거부', async () => {
  await assertFails(setDoc(doc(unauth(), 'rankings', 'neg'), { score: -1, ts: 1 }));
});
test('rankings: float score 거부', async () => {
  await assertFails(setDoc(doc(unauth(), 'rankings', 'flt'), { score: 1.5, ts: 1 }));
});
test('rankings: pin 필드 추가 거부', async () => {
  await assertFails(setDoc(doc(unauth(), 'rankings', 'p'), { score: 100, ts: 1, pin: '1234' }));
});
test('rankings: delpin 필드 추가 거부', async () => {
  await assertFails(setDoc(doc(unauth(), 'rankings', 'dp'), { score: 100, ts: 1, delpin: '1234' }));
});
test('rankings: 허용외 필드 추가 거부', async () => {
  await assertFails(setDoc(doc(unauth(), 'rankings', 'ex'), { score: 100, ts: 1, foo: 1 }));
});
test('rankings: 단조증가 update 허용(100→200)', async () => {
  await seed((db) => setDoc(doc(db, 'rankings', 'm1'), { score: 100, ts: 1 }));
  await assertSucceeds(setDoc(doc(unauth(), 'rankings', 'm1'), { score: 200, ts: 2 }));
});
test('rankings: 점수 감소 update 거부(200→100)', async () => {
  await seed((db) => setDoc(doc(db, 'rankings', 'm2'), { score: 200, ts: 1 }));
  await assertFails(setDoc(doc(unauth(), 'rankings', 'm2'), { score: 100, ts: 2 }));
});
test('rankings: 남의 uid 문서 수정 거부', async () => {
  await seed((db) => setDoc(doc(db, 'rankings', 'owned'), { score: 100, ts: 1, uid: 'owner1' }));
  await assertFails(setDoc(doc(asUser('attacker'), 'rankings', 'owned'), { score: 200, ts: 2, uid: 'owner1' }));
});
test('rankings: 본인 uid 문서 수정 허용', async () => {
  await seed((db) => setDoc(doc(db, 'rankings', 'mine'), { score: 100, ts: 1, uid: 'owner1' }));
  await assertSucceeds(setDoc(doc(asUser('owner1'), 'rankings', 'mine'), { score: 200, ts: 2, uid: 'owner1' }));
});
test('rankings: 레거시(uid-less) 문서 update 허용', async () => {
  await seed((db) => setDoc(doc(db, 'rankings', 'legacy'), { score: 100, ts: 1 }));
  await assertSucceeds(setDoc(doc(unauth(), 'rankings', 'legacy'), { score: 300, ts: 2 }));
});

// ─────────────── weekly_rankings ───────────────
const WK = ['weekly_rankings', '2026-06-29', 'scores'];
test('weekly: 정상 create 허용', async () => {
  await assertSucceeds(setDoc(doc(unauth(), ...WK, 'w1'), { score: 100, ts: 1 }));
});
test('weekly: score=50000 허용 / 50001 거부', async () => {
  await assertSucceeds(setDoc(doc(unauth(), ...WK, 'wcap'), { score: 50000, ts: 1 }));
  await assertFails(setDoc(doc(unauth(), ...WK, 'wover'), { score: 50001, ts: 1 }));
});
test('weekly: 엄격 증가 update 허용(100→150)', async () => {
  await seed((db) => setDoc(doc(db, ...WK, 'w3'), { score: 100, ts: 1 }));
  await assertSucceeds(setDoc(doc(unauth(), ...WK, 'w3'), { score: 150, ts: 2 }));
});
test('weekly: 동점 update 거부(엄격 > 조건)', async () => {
  await seed((db) => setDoc(doc(db, ...WK, 'w4'), { score: 100, ts: 1 }));
  await assertFails(setDoc(doc(unauth(), ...WK, 'w4'), { score: 100, ts: 2 }));
});
test('weekly: 허용외 필드(uid) 거부', async () => {
  await assertFails(setDoc(doc(unauth(), ...WK, 'w5'), { score: 100, ts: 1, uid: 'x' }));
});

// ─────────────── user_stats ───────────────
test('user_stats: bestScore=102698 허용(50000 초과, 150000 이하)', async () => {
  await assertSucceeds(setDoc(doc(unauth(), 'user_stats', 'bae'), { jelly: 0, bestScore: 102698 }));
});
test('user_stats: bestScore=150000(상한) 허용', async () => {
  await assertSucceeds(setDoc(doc(unauth(), 'user_stats', 'usmax'), { jelly: 0, bestScore: 150000 }));
});
test('user_stats: bestScore=150001(상한초과) 거부', async () => {
  await assertFails(setDoc(doc(unauth(), 'user_stats', 'usover'), { jelly: 0, bestScore: 150001 }));
});
test('user_stats: jelly 증가 update 거부(5→6)', async () => {
  await seed((db) => setDoc(doc(db, 'user_stats', 'j1'), { jelly: 5 }));
  await assertFails(setDoc(doc(unauth(), 'user_stats', 'j1'), { jelly: 6 }));
});
test('user_stats: jelly 동일 update 허용(5→5)', async () => {
  await seed((db) => setDoc(doc(db, 'user_stats', 'j2'), { jelly: 5 }));
  await assertSucceeds(setDoc(doc(unauth(), 'user_stats', 'j2'), { jelly: 5 }));
});

// ─────────────── champions ───────────────
test('champions: count=1 create 허용', async () => {
  await assertSucceeds(setDoc(doc(unauth(), 'champions', 'chA'), { count: 1, lastCrownedAt: 1 }));
});
test('champions: +1 update 허용 / +2 update 거부', async () => {
  await seed((db) => setDoc(doc(db, 'champions', 'chB'), { count: 1, lastCrownedAt: 1 }));
  await assertSucceeds(setDoc(doc(unauth(), 'champions', 'chB'), { count: 2, lastCrownedAt: 2 }));
  await seed((db) => setDoc(doc(db, 'champions', 'chC'), { count: 1, lastCrownedAt: 1 }));
  await assertFails(setDoc(doc(unauth(), 'champions', 'chC'), { count: 3, lastCrownedAt: 2 }));
});

// ─────────────── users_private (민감정보 잠금) ───────────────
test('users_private: 일반 read 거부', async () => {
  await seed((db) => setDoc(doc(db, 'users_private', 'u1'), { pinHash: 'x', pinSalt: 'y' }));
  await assertFails(getDoc(doc(unauth(), 'users_private', 'u1')));
});

// ─────────────── game_sessions (PR2 shadow — 클라이언트 접근 완전 차단) ───────────────
// CF(Admin SDK)만 write. 클라이언트는 인증 여부와 무관하게 read/create/update/delete 전부 거부.
test('game_sessions: 클라 create 거부 (미인증)', async () => {
  await assertFails(setDoc(doc(unauth(), 'game_sessions', 's1'), { uid: 'x', status: 'active' }));
});
test('game_sessions: 클라 create 거부 (인증)', async () => {
  await assertFails(setDoc(doc(asUser('u1'), 'game_sessions', 's2'), { uid: 'u1', status: 'active' }));
});
test('game_sessions: 클라 read 거부', async () => {
  await seed((db) => setDoc(doc(db, 'game_sessions', 's3'), { uid: 'u1', status: 'active' }));
  await assertFails(getDoc(doc(unauth(), 'game_sessions', 's3')));
  await assertFails(getDoc(doc(asUser('u1'), 'game_sessions', 's3')));
});
test('game_sessions: 클라 update 거부 (본인 uid여도)', async () => {
  await seed((db) => setDoc(doc(db, 'game_sessions', 's4'), { uid: 'u1', status: 'active' }));
  await assertFails(updateDoc(doc(asUser('u1'), 'game_sessions', 's4'), { finalScore: 999 }));
});
test('game_sessions: 클라 delete 거부', async () => {
  await seed((db) => setDoc(doc(db, 'game_sessions', 's5'), { uid: 'u1', status: 'active' }));
  await assertFails(deleteDoc(doc(asUser('u1'), 'game_sessions', 's5')));
});

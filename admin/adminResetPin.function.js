// ══════════════════════════════════════════════════════════════
//  adminResetPin — 어드민 전용 PIN 재설정 Cloud Function
//
//  ⚠️ 이 파일은 "게임의 Cloud Functions 프로젝트"에 붙여넣어 배포하는 코드입니다.
//     (오잉게임 관리자 대시보드 저장소가 아니라, shopAction/restoreAccount/
//      renameNickname/appendFeedbackMessage 가 들어있는 그 Functions 프로젝트)
//
//  하는 일:
//   · 호출자가 어드민(고정 UID)인지 확인 — 그 외에는 전부 거부
//   · 닉네임 → nickname_lookup 으로 대상 UID 확인
//   · 새 4자리 PIN 으로 salt+hash 를 새로 만들어 users_private/{uid} 에 덮어씀
//   · 성공 시 { ok: true } 반환 (새 PIN 은 클라이언트가 이미 알고 있으므로 안 돌려줌)
//
//  기존 PIN 원문은 어디에서도 조회하지 않습니다. 기존 restoreAccount 흐름은
//  users_private 의 pinHash/pinSalt 를 그대로 읽어 검증하므로, 여기서 값만
//  교체하면 유저는 새 PIN 으로 자연스럽게 이어하기가 됩니다.
//
//  PIN 해시 방식은 게임/기존 서버와 반드시 동일해야 합니다:
//     sha256(`${salt}:${pin}:oeing-pin-v1`)
// ══════════════════════════════════════════════════════════════
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

// 이미 admin.initializeApp() 이 index.js 어딘가에 있으면 이 줄은 지우세요.
try { admin.app(); } catch { admin.initializeApp(); }

const ADMIN_UID = 'dofesyOMISTSAKEKBEpqAyV2PTr2'; // 보안 규칙의 isAdmin 과 동일한 UID

function normalizeNickname(nick) {
  try { return String(nick || '').normalize('NFC').trim().toLowerCase(); }
  catch { return String(nick || '').trim().toLowerCase(); }
}
function computePinHash(salt, pin) {
  return crypto.createHash('sha256').update(`${salt}:${pin}:oeing-pin-v1`).digest('hex');
}

exports.adminResetPin = functions.https.onCall(async (data, context) => {
  // ① 어드민만
  if (!context.auth || context.auth.uid !== ADMIN_UID) {
    throw new functions.https.HttpsError('permission-denied', '어드민만 실행할 수 있어요.');
  }
  const newPin = String((data && data.newPin) || '');
  if (!/^\d{4}$/.test(newPin)) {
    throw new functions.https.HttpsError('invalid-argument', '새 PIN은 4자리 숫자여야 해요.');
  }

  const db = admin.firestore();

  // ② 대상 UID 확정 — uid 를 직접 받았으면 그걸 쓰고, 아니면 닉네임으로 lookup
  let uid = (data && data.uid) ? String(data.uid) : '';
  if (!uid) {
    const norm = normalizeNickname(data && data.nickname);
    if (!norm) throw new functions.https.HttpsError('invalid-argument', '닉네임 또는 uid가 필요해요.');
    const lk = await db.collection('nickname_lookup').doc(norm).get();
    if (!lk.exists || !lk.data().uid) {
      throw new functions.https.HttpsError('not-found', '계정(UID)이 연결된 닉네임이 아니에요.');
    }
    uid = lk.data().uid;
  }

  // ③ 새 salt + hash 로 교체 (기존 값 덮어쓰기)
  const salt = crypto.randomBytes(16).toString('hex');
  const pinHash = computePinHash(salt, newPin);
  await db.collection('users_private').doc(uid).set(
    { pinHash, pinSalt: salt, pinSetAt: Date.now(), pinResetByAdminAt: Date.now() },
    { merge: true }
  );

  return { ok: true };
});

// ══════════════════════════════════════════════════════════════
//  firebase.js — Firebase 초기화 + 공통 DB 헬퍼 (관리자 대시보드 전용)
//
//  이 파일만 Firebase SDK를 직접 import 한다.
//  다른 모듈(dashboard/users/analytics/security/rewards/operations)은
//  전부 여기서 export 하는 함수/객체만 사용한다.
//
//  비용 원칙:
//   · "개수"만 필요한 곳은 문서를 내려받지 않는 count 집계(getCountFromServer)를 쓴다
//     → 문서 1000개당 읽기 1회로 계산됨 (문서 전체 fetch 대비 수백 배 저렴)
//   · 목록은 항상 orderBy + limit + startAfter(cursor) 페이지네이션
//   · 실시간 리스너(onSnapshot)는 사용하지 않는다 — 새로고침 버튼으로 대체
//     (탭을 벗어나도 리스너가 계속 읽기를 발생시키는 문제 원천 차단)
// ══════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getFirestore, collection, doc,
  getDoc, getDocs, setDoc, deleteDoc, addDoc,
  query, where, orderBy, limit, startAfter, increment, deleteField,
  getCountFromServer,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-functions.js";

// 게임 본체(index.html)와 동일한 프로젝트 설정 — 절대 변경 금지
const firebaseConfig = {
  apiKey: "AIzaSyBzDEJyVEUtrbIeAqwTwbF9FszEmtAw0jg",
  authDomain: "oing-game.firebaseapp.com",
  projectId: "oing-game",
  storageBucket: "oing-game.firebasestorage.app",
  messagingSenderId: "974542803508",
  appId: "1:974542803508:web:0b01327dd02c9b08b23061"
};

// ── 기능 플래그 ──────────────────────────────────────────────
// 게임에서 꺼져 있는 기능은 관리자에서도 숨긴다 (UI 미렌더링 + Firestore 조회 차단).
// 코드는 삭제하지 않으므로, 게임에서 기능을 다시 켜면 true로만 바꾸면 된다.
// ※ 단순히 "오늘 사용량 0"인 활성 기능은 숨기지 않는다 — 0회로 그대로 표시.
export const FEATURES = {
  skinRequests: false, // 스킨 꾸미기 신청(skin_requests) — 게임에서 현재 OFF
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const fns = getFunctions(app);

// Firestore 프리미티브 재-export (모든 모듈이 이 파일만 import 하도록)
export {
  collection, doc,
  getDoc, getDocs, setDoc, deleteDoc, addDoc,
  query, where, orderBy, limit, startAfter, increment, deleteField,
  httpsCallable,
};

// ── 인증 ──────────────────────────────────────────────────────
// 기본: 익명 로그인(게임과 동일). Firestore 보안 규칙이 "관리자 계정"을
// 요구하는 경우를 위해 이메일/비밀번호 로그인도 지원한다.
export async function signInAnon() {
  if (auth.currentUser) return auth.currentUser.uid;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}
export async function signInEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user.uid;
}
export async function signOutAll() { try { await signOut(auth); } catch {} }
export function waitForAuth() {
  return new Promise(resolve => {
    const off = onAuthStateChanged(auth, u => { off(); resolve(u); });
  });
}

// ── 날짜 헬퍼 (게임 본체와 동일한 로직 — 통계가 어긋나지 않도록 복제) ──
export function getTodayDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function daysAgoDateStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return getTodayDateStr(d);
}
export function todayStartTs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// 게임 본체 getWeekId()와 동일 — 2026-07-13 이전엔 고정 주차 반환 (특별 조기 리셋 과도기)
export function getWeekId() {
  const NEXT_RESET = new Date('2026-07-13T00:00:00+09:00').getTime();
  if (Date.now() < NEXT_RESET) return '2026-06-29';
  const d = new Date();
  const day = d.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diffToMonday);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

// ── 표시 헬퍼 ─────────────────────────────────────────────────
export function fmtDateTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtAgo(ts) {
  if (!ts) return '-';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
export function fmtDuration(sec) {
  if (!sec && sec !== 0) return '-';
  if (sec < 60) return `${Math.round(sec)}초`;
  return `${Math.floor(sec / 60)}분 ${Math.round(sec % 60)}초`;
}
export function fmtNum(n) { return (typeof n === 'number') ? n.toLocaleString('ko-KR') : (n ?? '-'); }
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── DB 조회 카운터 (이번 세션의 Firestore 조회량 "추정치") ──
// 실제 청구 읽기 수와 완전히 같지는 않다:
//  · count 집계는 결과 1000건당 1읽기 과금 — 여기선 항상 1로 계산 (초과분 과소집계)
//  · 빈 결과 쿼리도 최소 1읽기 과금 — 아래에서 min 1로 보정
//  · 캐시 재사용/오프라인 캐시 히트는 반영 못 함
export const readStats = { docs: 0, queries: 0 };
function bump(nDocs) {
  readStats.queries += 1;
  readStats.docs += Math.max(1, nDocs); // 빈 결과도 최소 1읽기로 과금되므로 보정
  const el = document.getElementById('readCounter');
  if (el) el.textContent = `추정 읽기 ${readStats.docs} · 쿼리 ${readStats.queries}`;
}

// ── 공통 조회 래퍼 ────────────────────────────────────────────
// countQuery: 문서를 내려받지 않고 개수만 (aggregation, 초저비용)
export async function countQuery(...pathAndConstraints) {
  const q = query(...pathAndConstraints);
  const snap = await getCountFromServer(q);
  bump(1); // count 집계는 1000개당 1읽기 — 보수적으로 1로 계산
  return snap.data().count;
}
// fetchDocs: getDocs 래퍼 — 읽기 카운터 반영 + {id, ...data} 배열 반환
export async function fetchDocs(q) {
  const snap = await getDocs(q);
  bump(snap.size);
  return snap.docs.map(d => ({ id: d.id, _snap: d, ...d.data() }));
}
export async function fetchDoc(ref) {
  const snap = await getDoc(ref);
  bump(1);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ── 커서 페이지네이션 헬퍼 ────────────────────────────────────
// makePager(() => [collection(db,'x'), orderBy('ts','desc')], 30)
//  → pager.next() 호출 시마다 다음 30건. pager.done 이면 끝.
export function makePager(constraintsFactory, pageSize = 30) {
  let cursor = null;
  const pager = {
    done: false,
    async next() {
      if (pager.done) return [];
      const base = constraintsFactory();
      const parts = cursor ? [...base, startAfter(cursor), limit(pageSize)] : [...base, limit(pageSize)];
      const rows = await fetchDocs(query(...parts));
      if (rows.length < pageSize) pager.done = true;
      if (rows.length) cursor = rows[rows.length - 1]._snap;
      return rows;
    },
    reset() { cursor = null; pager.done = false; },
  };
  return pager;
}

// ── 닉네임 → 문서 참조 해석 (게임의 UID 이관 과도기 로직과 동일한 우선순위) ──
// nickname_lookup/{정규화닉} 에 uid가 있으면 UID 문서 우선, 없으면 레거시 닉네임 문서
// 게임 본체의 normalizeNickname과 완전히 동일해야 lookup이 어긋나지 않는다
export function normalizeNickname(nick) {
  try { return String(nick || '').normalize('NFC').trim().toLowerCase(); }
  catch { return String(nick || '').trim().toLowerCase(); }
}
export async function resolveUserDocId(nick) {
  const norm = normalizeNickname(nick);
  if (!norm) return { uid: null, docId: nick };
  try {
    const lk = await fetchDoc(doc(db, 'nickname_lookup', norm));
    if (lk && lk.uid) return { uid: lk.uid, docId: lk.uid };
  } catch { /* lookup 실패 시 레거시 닉네임 문서로 폴백 */ }
  return { uid: null, docId: nick };
}
// 닉네임 기준으로 user_stats / nickname_skins 문서를 UID 우선 + 닉네임 폴백으로 읽기
export async function getUserDocByNick(colName, nick) {
  const { docId } = await resolveUserDocId(nick);
  let ref = doc(db, colName, docId);
  let data = await fetchDoc(ref);
  if (!data && docId !== nick) { // UID 문서가 아직 없으면 레거시 닉네임 문서 확인
    ref = doc(db, colName, nick);
    data = await fetchDoc(ref);
  }
  return { ref, data };
}

// ── JSON 백업 다운로드 ────────────────────────────────────────
export function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

// ── 세션 캐시 ─────────────────────────────────────────────────
// 한 세션 안에서 같은 데이터를 두 번 조회하지 않기 위한 공용 캐시.
// cache.get(key, loader) — 있으면 재사용, 없으면 loader() 실행 후 저장.
// cache.bust(prefix) — 새로고침 버튼이 해당 영역 캐시만 무효화.
const _cache = new Map();
export const cache = {
  async get(key, loader) {
    if (_cache.has(key)) return _cache.get(key);
    const val = await loader();
    _cache.set(key, val);
    return val;
  },
  peek(key) { return _cache.get(key); },
  set(key, val) { _cache.set(key, val); },
  bust(prefix) {
    for (const k of [..._cache.keys()]) {
      if (k === prefix || k.startsWith(prefix + ':')) _cache.delete(k);
    }
  },
};

// ── 오류 메시지 정리 ──────────────────────────────────────────
export function humanError(e) {
  const msg = String((e && (e.code || e.message)) || e);
  if (msg.includes('permission-denied') || msg.includes('Missing or insufficient permissions')) {
    return '권한 없음 — Firestore 보안 규칙이 이 작업을 막았습니다. (관리자 계정 이메일 로그인이 필요할 수 있어요)';
  }
  if (msg.includes('failed-precondition') && msg.includes('index')) {
    return '인덱스 필요 — Firebase 콘솔에서 복합 인덱스를 생성해야 하는 쿼리입니다.';
  }
  if (msg.includes('unavailable') || msg.includes('network')) return '네트워크 오류 — 잠시 후 다시 시도해주세요.';
  return msg;
}

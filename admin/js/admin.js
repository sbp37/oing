// ══════════════════════════════════════════════════════════════
//  admin.js — 로그인 게이트 + 탭 전환 + 지연 로딩 제어 (관리자 본체)
//
//  2026-07 개편: 🏠오늘 / 📥처리함 / 👥유저 / 📊통계 / 🛠관리 5탭.
//  핵심 동작:
//   · 최초 진입 시 "오늘" 탭 데이터만 로드 (집계 위주 — 문서 다운로드 최소)
//   · 다른 탭은 처음 클릭했을 때 1회만 로드 (loaded 플래그)
//   · 같은 탭 재클릭/재방문 시 Firebase 재조회 없음 — 세션 캐시 재사용
//   · 각 탭의 "↻ 새로고침" 버튼만 해당 탭 데이터를 다시 조회
//   · goto('tab' | 'tab:sub') — 배지/할 일에서 서브탭·아코디언까지 바로 이동
// ══════════════════════════════════════════════════════════════
import { signInAnon, signInEmail, signOutAll, waitForAuth, cache } from './firebase.js';
import { initTodayTab, loadDashboard, renderTasks } from './dashboard.js';
import { initInbox, loadInbox, gotoInboxSub } from './inbox.js';
import { initUsersTab, loadUsers } from './users.js';
import { initStatsTab, loadStats, gotoStatsSub } from './statstab.js';
import { initToolsTab, loadTools, openToolAcc } from './tools.js';
import { loadVerdictBadge, loadReviewPendingBadge } from './security.js';
import { loadFeedbackNewBadge } from './operations.js';

// ── 탭 레지스트리 ─────────────────────────────────────────────
// init: 이벤트 바인딩(1회, 조회 없음) / load: 실제 데이터 조회
const TABS = {
  today: { init: () => initTodayTab({ goto: gotoTarget }), load: loadDashboard },
  inbox: { init: initInbox,    load: loadInbox },
  users: { init: initUsersTab, load: loadUsers },
  stats: { init: initStatsTab, load: loadStats },
  tools: { init: initToolsTab, load: loadTools },
};
const state = {};           // { [tab]: { inited, loaded, loading } }
for (const k of Object.keys(TABS)) state[k] = { inited: false, loaded: false, loading: false };

let currentTab = 'today';

async function openTab(name, { force = false } = {}) {
  if (!TABS[name]) return;
  // 화면 전환은 즉시 (데이터와 무관)
  document.querySelectorAll('.tab-section').forEach(s => { s.style.display = 'none'; });
  document.getElementById('tab-' + name).style.display = 'block';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  currentTab = name;

  const st = state[name];
  if (!st.inited && TABS[name].init) {
    TABS[name].init();          // 버튼 바인딩만 — Firebase 조회 없음
    st.inited = true;
  }
  // 이미 로드됐으면 재조회하지 않음 (세션 내 재사용). force = 새로고침 버튼.
  if ((st.loaded && !force) || st.loading) return;
  st.loading = true;
  try {
    await TABS[name].load({ force });
    st.loaded = true;
  } catch (e) {
    console.warn(`[admin] ${name} 탭 로드 실패:`, e);
  } finally {
    st.loading = false;
  }
}

// ── 화면 간 이동 헬퍼 — 'inbox:verdicts' / 'stats:datause' / 'tools:acc-ops' / 'users' ──
async function gotoTarget(target) {
  const [tab, sub] = String(target || '').split(':');
  await openTab(tab);
  if (!sub) return;
  if (tab === 'inbox') gotoInboxSub(sub);
  else if (tab === 'stats') gotoStatsSub(sub);
  else if (tab === 'tools') openToolAcc(sub);
}

function bindTabs() {
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) openTab(btn.dataset.tab);
  });
  // 각 탭의 새로고침 버튼(탭당 1개) — 해당 탭 캐시만 무효화 후 재조회
  document.querySelectorAll('.refresh-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.refresh;
      if (state[tab].loading) return; // 중복 클릭 방지
      btn.disabled = true;
      cache.bust(tab);               // 이 탭 접두사의 세션 캐시만 삭제
      try { await openTab(tab, { force: true }); }
      finally { btn.disabled = false; }
    });
  });
}

// ── 로그인 게이트 ─────────────────────────────────────────────
// 기존 관리자와 동일한 SHA-256 암호 해시 게이트 유지 + (선택) Firebase 이메일 인증
const ADMIN_PW_HASH = '60e1f6f159263b555cacf78ed279d0ce722cef74901eeaa786a4b04958242ce2';
const UNLOCK_KEY = 'oeing_admin_unlocked_v1';
const EMAIL_KEY = 'oeing_admin_email_v1';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function showApp() {
  document.getElementById('loginGate').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
  // ★ 최초 진입: 오늘 탭 데이터 + 배지 카운트만.
  //   배지는 "치팅·문의를 즉시 알아채는 것"이 목적이라 진입 시 1회 조회를 허용한다
  //   (의심 최대 50건 1쿼리 + count 2쿼리). 결과는 캐시에 담겨 처리함이 그대로 재사용한다.
  openTab('today');
  // 배지 3종이 다 도착한 뒤 "오늘 확인할 일"을 다시 그린다 (배지 DOM 값 재사용 — 추가 조회 0)
  Promise.allSettled([loadVerdictBadge(), loadReviewPendingBadge(), loadFeedbackNewBadge()])
    .then(() => { try { renderTasks(); } catch {} });
  // 배지 클릭 → 해당 처리 화면으로 바로 이동
  const bind = (id, target) => {
    const el = document.getElementById(id);
    if (el && !el._bound) { el._bound = true; el.addEventListener('click', () => gotoTarget(target)); }
  };
  bind('verdictBadge', 'inbox:verdicts');
  bind('reviewPendingBadge', 'tools:acc-ops');
  bind('feedbackNewBadge', 'inbox:feedback');
}

async function enterAdmin() {
  const email = (document.getElementById('loginEmail').value || '').trim();
  const emailPw = document.getElementById('loginEmailPw').value || '';
  const errEl = document.getElementById('loginErr');
  const savedEmail = (() => { try { return localStorage.getItem(EMAIL_KEY); } catch { return null; } })();
  try {
    if (email && emailPw) {
      await signInEmail(email, emailPw);
      try { localStorage.setItem(EMAIL_KEY, email); } catch {}
    } else if (savedEmail) {
      // ★ 이 기기는 관리자 이메일 로그인을 쓰는 기기 — 이메일 칸이 비었다고 조용히
      //   익명으로 입장시키면 익명 세션이 저장돼, 다음 새로고침부터 "권한 없음(규칙 차단)"
      //   상태로 열리는 원인이 됐다(로그인이 자꾸 풀리던 버그). 익명 입장 대신
      //   이메일 비밀번호를 요구한다. 세션이 살아있는 평소에는 여기까지 오지 않는다.
      document.getElementById('loginEmailBox').style.display = 'block';
      document.getElementById('loginEmail').value = savedEmail;
      errEl.textContent = '권한 로그인이 만료됐어요 — 이메일 비밀번호도 입력해주세요.';
      document.getElementById('loginEmailPw').focus();
      return false;
    } else {
      await signInAnon(); // 게임과 동일한 익명 인증 (이메일을 쓴 적 없는 기기만)
    }
  } catch (e) {
    errEl.textContent = 'Firebase 로그인 실패: ' + (e.code || e.message);
    return false;
  }
  showApp();
  return true;
}

function bindLogin() {
  const pwInput = document.getElementById('loginPw');
  const btn = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginErr');

  async function tryLogin() {
    const pw = pwInput.value || '';
    if (!pw) { errEl.textContent = '암호를 입력하세요.'; return; }
    btn.disabled = true;
    try {
      const hash = await sha256Hex(pw);
      if (hash !== ADMIN_PW_HASH) { errEl.textContent = '암호가 틀렸습니다.'; return; }
      try { localStorage.setItem(UNLOCK_KEY, '1'); } catch {}
      await enterAdmin();
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', tryLogin);
  pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  document.getElementById('loginEmailPw').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

  document.getElementById('loginEmailToggle').addEventListener('click', () => {
    const box = document.getElementById('loginEmailBox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  });
  try {
    const savedEmail = localStorage.getItem(EMAIL_KEY);
    if (savedEmail) {
      document.getElementById('loginEmail').value = savedEmail;
      document.getElementById('loginEmailBox').style.display = 'block';
    }
  } catch {}

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { localStorage.removeItem(UNLOCK_KEY); } catch {}
    await signOutAll();
    location.reload();
  });

  // 이 기기에서 이미 암호를 통과한 적이 있으면 암호 재입력 생략.
  // 이메일 인증을 썼던 경우엔 Firebase가 세션을 보존하므로 그 세션이 살아있으면
  // 그대로 입장, 만료됐으면 다시 로그인 화면 유지.
  let unlocked = false;
  try { unlocked = localStorage.getItem(UNLOCK_KEY) === '1'; } catch {}
  if (unlocked) {
    const savedEmail = (() => { try { return localStorage.getItem(EMAIL_KEY); } catch { return null; } })();
    waitForAuth().then(user => {
      if (user && user.isAnonymous && savedEmail) {
        // ★ 이메일 기기인데 익명 세션이 저장돼 있음(과거 버그의 잔재) — 이대로 입장하면
        //   전부 "접근불가"가 되므로, 익명 세션을 지우고 이메일 재로그인을 안내한다.
        signOutAll();
        document.getElementById('loginEmailBox').style.display = 'block';
        document.getElementById('loginEmail').value = savedEmail;
        document.getElementById('loginErr').textContent = '권한 로그인이 풀려 있었어요 — 화면 암호와 이메일 비밀번호로 다시 로그인하면 이후엔 유지돼요.';
        return;
      }
      if (user) showApp();               // 보존된 세션(이메일/순수 익명 기기) 그대로 재입장
      else if (!savedEmail) enterAdmin(); // 익명 전용 기기만 자동 재로그인
      // 이메일 기기인데 세션이 없으면 → 로그인 화면 유지(이메일 칸은 bindLogin에서 미리 열림)
    });
  }
}

// ── 공통 UI 헬퍼 (각 탭 모듈에서 import) ──────────────────────
export function setLoading(el, msg = '불러오는 중...') {
  el.innerHTML = `<div class="list-loading">${msg}</div>`;
}
export function setError(el, msg) {
  el.innerHTML = `<div class="list-error">⚠️ ${msg}</div>`;
}
export function setEmpty(el, msg = '데이터가 없어요') {
  el.innerHTML = `<div class="list-empty">${msg}</div>`;
}
export function resultMsg(elId, msg, ok = true) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = `<div class="result-msg ${ok ? 'ok' : 'err'}">${msg}</div>`;
  if (ok) setTimeout(() => { if (el.firstChild) el.innerHTML = ''; }, 6000);
}
// 중복 클릭 방지 래퍼 — 실행 중이면 무시하고, 버튼을 자동 비활성화
export function guardBtn(btn, fn) {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    btn.disabled = true;
    try { return await fn(...args); }
    finally { running = false; btn.disabled = false; }
  };
}

bindLogin();
bindTabs();

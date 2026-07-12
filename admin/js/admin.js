// ══════════════════════════════════════════════════════════════
//  admin.js — 로그인 게이트 + 탭 전환 + 지연 로딩 제어 (관리자 본체)
//
//  핵심 동작:
//   · 최초 진입 시 "홈" 탭 데이터만 로드
//   · 다른 탭은 처음 클릭했을 때 1회만 로드 (loaded 플래그)
//   · 같은 탭 재클릭/재방문 시 Firebase 재조회 없음 — 세션 캐시 재사용
//   · 각 탭의 "↻ 새로고침" 버튼만 해당 탭 데이터를 다시 조회
// ══════════════════════════════════════════════════════════════
import { signInAnon, signInEmail, signOutAll, waitForAuth, cache } from './firebase.js';
import { loadDashboard } from './dashboard.js';
import { initUsersTab, loadUsers } from './users.js';
import { initAnalyticsTab, loadAnalytics } from './analytics.js';
import { initSecurityTab, loadSecurity } from './security.js';
import { initRewardsTab, loadRewards } from './rewards.js';
import { initOperationsTab, loadOperations } from './operations.js';

// ── 탭 레지스트리 ─────────────────────────────────────────────
// init: 이벤트 바인딩(1회, 조회 없음) / load: 실제 데이터 조회
const TABS = {
  home:       { load: loadDashboard },
  users:      { init: initUsersTab,      load: loadUsers },
  analytics:  { init: initAnalyticsTab,  load: loadAnalytics },
  security:   { init: initSecurityTab,   load: loadSecurity },
  rewards:    { init: initRewardsTab,    load: loadRewards },
  operations: { init: initOperationsTab, load: loadOperations },
};
const state = {};           // { [tab]: { inited, loaded, loading } }
for (const k of Object.keys(TABS)) state[k] = { inited: false, loaded: false, loading: false };

let currentTab = 'home';

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

function bindTabs() {
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) openTab(btn.dataset.tab);
  });
  // 각 탭의 새로고침 버튼 — 해당 탭 캐시만 무효화 후 재조회
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
const ADMIN_PW_HASH = '465a52b9d22e363d84d6e6cf7c7cb87793160b58fe2dffffce74da2130962ea4';
const UNLOCK_KEY = 'oeing_admin_unlocked_v1';
const EMAIL_KEY = 'oeing_admin_email_v1';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function showApp() {
  document.getElementById('loginGate').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
  // ★ 최초 진입: 홈 탭만 로드 — 다른 탭 데이터는 일절 조회하지 않음
  openTab('home');
}

async function enterAdmin() {
  const email = (document.getElementById('loginEmail').value || '').trim();
  const emailPw = document.getElementById('loginEmailPw').value || '';
  const errEl = document.getElementById('loginErr');
  try {
    if (email && emailPw) {
      await signInEmail(email, emailPw);
      try { localStorage.setItem(EMAIL_KEY, email); } catch {}
    } else {
      await signInAnon(); // 게임과 동일한 익명 인증
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
      if (user) showApp();               // 보존된 세션(익명/이메일) 그대로 재입장
      else if (!savedEmail) enterAdmin(); // 익명 인증은 자동 재로그인
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

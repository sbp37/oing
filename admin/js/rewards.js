// ══════════════════════════════════════════════════════════════
//  rewards.js — 후원 / 리워드 탭
//
//  · 스킨 지급/해제/감사쪽지: 기존 관리자와 완전히 동일한 데이터 방식
//    (nickname_skins/{닉네임} 문서에 cat / notifyPending / thanksPending 플래그,
//     merge 저장 — 게임 쪽 checkSkinNotification 이 그대로 알아듣는다)
//  · 클릭 기록/후원 쪽지함: 처음 30건만 + "이전 기록 더 보기" 커서 페이지네이션.
//    실시간 리스너 없음 — 과거 로그는 변하지 않으므로 getDocs면 충분.
// ══════════════════════════════════════════════════════════════
import {
  db, collection, doc, query, orderBy, limit, where,
  fetchDocs, setDoc, increment, makePager, getUserDocByNick, countQuery,
  getTodayDateStr, fmtDateTime, fmtNum, escapeHtml, humanError, FEATURES,
} from './firebase.js';
import { setLoading, setError, setEmpty, guardBtn, resultMsg } from './admin.js';

const PAGE_SIZE = 30;

// ── 유저에게 보내기 (스킨 선물 / 개인 쪽지 / 감사 인사) ──
// 모두 nickname_skins/{닉네임} 문서 플래그로 전달 — 게임 쪽 checkSkinNotification 이 알아듣는다.
// 닉네임만 알면 계정 연결 여부와 무관하게 누구에게나 전달 가능.

// ① 스킨 선물 — cat 스킨 지급 + 함께 보낼 말(선택). skinNote 를 넣으면 도착 팝업에 함께 표시.
async function giftSkin(nick, msg) {
  await setDoc(doc(db, 'nickname_skins', nick), { cat: true, notifyPending: true, skinNote: msg || '' }, { merge: true });
  resultMsg('rwResult', `🎁 '${escapeHtml(nick)}' 님에게 고양이 스킨을 선물했어요${msg ? ` — "${escapeHtml(msg.slice(0, 30))}${msg.length > 30 ? '…' : ''}"` : ''}. 다음 접속 때 팝업으로 떠요.`);
}
async function revokeSkin(nick) {
  await setDoc(doc(db, 'nickname_skins', nick), { cat: false }, { merge: true });
  resultMsg('rwResult', `'${escapeHtml(nick)}' 님의 고양이 스킨을 해제했어요.`);
}
// ② 개인 쪽지 — 스킨 없이 자유 문구만.
async function sendPersonalNote(nick, msg) {
  await setDoc(doc(db, 'nickname_skins', nick), { thanksPending: true, thanksKind: 'note', thanksText: msg }, { merge: true });
  resultMsg('rwResult', `💌 '${escapeHtml(nick)}' 님에게 쪽지를 보냈어요 — "${escapeHtml(msg.slice(0, 30))}${msg.length > 30 ? '…' : ''}". 다음 접속 때 팝업으로 떠요.`);
}
// ③ 감사 인사 — 정해진 문구(닉네임 자동 삽입). 자유 입력 없음.
async function sendGreeting(nick) {
  await setDoc(doc(db, 'nickname_skins', nick), { thanksPending: true, thanksKind: 'greeting', thanksText: '' }, { merge: true });
  resultMsg('rwResult', `💛 '${escapeHtml(nick)}' 님에게 감사 인사를 보냈어요. 다음 접속 때 팝업으로 떠요.`);
}

// ── 젤리 지급 — UID 문서 우선 해석 후 increment (원자적 증가) ──
async function grantJelly(nick, amount) {
  const { ref, data } = await getUserDocByNick('user_stats', nick);
  if (!data) {
    resultMsg('rwResult', `'${escapeHtml(nick)}' 의 user_stats 문서를 찾지 못했어요. (점수를 한 번이라도 등록한 유저만 지급 가능)`, false);
    return;
  }
  await setDoc(ref, { jelly: increment(amount) }, { merge: true });
  resultMsg('rwResult', `🍬 '${escapeHtml(nick)}' 님에게 젤리 ${fmtNum(amount)}개를 지급했어요. (기존 ${fmtNum(data.jelly || 0)}개)`);
}

// ── 클릭 기록 (990원/스킨샵/간식/공유/스킨신청/⭐리뷰버튼) ──
// support_topbtn_clicks: 버튼 라벨이 "응원하기"→"스킨샵"으로 바뀌어 표시 라벨도 맞춤(컬렉션명은 유지).
// supporterpack_clicks/jellyshop_clicks/tutorial_starts는 안 쓰는 추적이라 제거함(firestore.rules도 함께 차단).
const CLICK_LABELS = {
  donate_clicks: '990원 응원',
  support_topbtn_clicks: '스킨샵',
  snack_clicks: '간식',
  share_clicks: '카톡 공유',
  skin_requests: '스킨 신청',
  review_entry_clicks: '⭐ 리뷰 버튼',
  review_prompt_shown: '📣 리뷰요청 노출',
  updatelog_clicks: '업데이트로그',
  thanks_toggle_clicks: '감사메시지 열람',
  myinfo_clicks: '👤 내 정보 열람',
};
const REVIEW_SOURCE_LABEL = { rank: '랭킹탭', main: '메인' };
// 컬렉션별 pager/rows/오늘 카운트를 세션 내 캐시 — 로그 종류를 오가도 재조회 없음
const clickState = {};

function clickRowHtml(colName, r) {
  // 스킨 신청은 기존 스키마의 fulfilled 필드로 대기/처리됨을 표시하고,
  // 대기 건에는 "처리 완료" 버튼을 붙인다 (문서의 다른 필드는 건드리지 않음)
  if (colName === 'skin_requests') {
    const pending = r.fulfilled !== true;
    return `
      <div class="list-row" data-reqid="${escapeHtml(r.id)}">
        <span class="main"><span class="nick">${escapeHtml(r.nickname || '익명')}</span>
          · ${escapeHtml(r.label || '')} ${fmtNum(r.price || 0)}원
          ${pending ? '<span class="badge warn">대기</span>' : '<span class="badge green">처리됨</span>'}
          <span class="skinreq-err list-error" style="display:block;padding:0;text-align:left;"></span></span>
        <span class="sub">${fmtDateTime(r.ts)}</span>
        ${pending ? `<button class="btn btn-primary btn-sm skinreq-fulfill" data-reqid="${escapeHtml(r.id)}">처리 완료</button>` : ''}
      </div>`;
  }
  // ⭐ 리뷰 버튼 / 👤 내 정보 클릭 — 랭킹탭/메인 어디서 눌렀는지 배지로 구분 표시 (같은 필드 구조)
  if (colName === 'review_entry_clicks' || colName === 'myinfo_clicks') {
    const srcLabel = REVIEW_SOURCE_LABEL[r.source] || '알 수 없음';
    return `
      <div class="list-row">
        <span class="main"><span class="nick">${escapeHtml(r.nickname || '익명')}</span>
          <span class="badge">${escapeHtml(srcLabel)}</span></span>
        <span class="sub">${fmtDateTime(r.ts)}</span>
      </div>`;
  }
  // 📣 리뷰요청 팝업 노출 — 어떤 버튼을 눌렀는지(리뷰 남기기 / 그냥 계속할래 / 노출만) 배지로 표시
  if (colName === 'review_prompt_shown') {
    const A = {
      write:   { t: '✍️ 리뷰 남기기', c: 'green' },
      dismiss: { t: '그냥 계속할래',  c: 'warn' },
      shown:   { t: '노출만(무응답)', c: '' },
    };
    const a = A[r.action] || A.shown;
    return `
      <div class="list-row">
        <span class="main"><span class="nick">${escapeHtml(r.nickname || '익명')}</span>
          <span class="badge ${a.c}">${a.t}</span></span>
        <span class="sub">${fmtDateTime(r.ts)}</span>
      </div>`;
  }
  return `
    <div class="list-row">
      <span class="main"><span class="nick">${escapeHtml(r.nickname || '익명')}</span></span>
      <span class="sub">${fmtDateTime(r.ts)}</span>
    </div>`;
}

// "처리 완료" — 확인창 후 fulfilled:true 만 merge 저장, 해당 행만 UI 갱신 (재조회 없음)
async function fulfillSkinRequest(id, btn) {
  const st = clickState['skin_requests'];
  const row = st && st.rows.find(r => r.id === id);
  if (!row) return;
  const ok = confirm(`'${row.nickname || '익명'}' 님의 스킨 신청(${row.label || ''} ${fmtNum(row.price || 0)}원)을\n처리 완료로 표시할까요?`);
  if (!ok) return;
  btn.disabled = true;
  const rowEl = btn.closest('.list-row');
  try {
    await setDoc(doc(db, 'skin_requests', id), { fulfilled: true }, { merge: true });
    row.fulfilled = true; // 세션 캐시도 갱신 — 재렌더/재조회 없이 상태 유지
    if (rowEl) rowEl.outerHTML = clickRowHtml('skin_requests', row);
  } catch (e) {
    btn.disabled = false;
    const errEl = rowEl && rowEl.querySelector('.skinreq-err');
    if (errEl) errEl.textContent = '⚠️ ' + humanError(e);
  }
}
async function loadClickLog(colName, { reset = false } = {}) {
  // 기능 플래그 OFF인 로그는 어떤 Firestore 조회도 실행하지 않음 (안전망 —
  // 셀렉트 옵션 자체도 initRewardsTab에서 제거되므로 평소엔 도달하지 않는 경로)
  if (colName === 'skin_requests' && !FEATURES.skinRequests) return;
  const el = document.getElementById('clickLogList');
  const moreBtn = document.getElementById('clickLogMoreBtn');
  if (reset || !clickState[colName]) {
    clickState[colName] = {
      pager: makePager(() => [collection(db, colName), orderBy('ts', 'desc')], PAGE_SIZE),
      rows: [],
      todayCount: null,
    };
  }
  const st = clickState[colName];
  if (st.rows.length) { // 이미 로드된 종류 — 재조회 없이 그대로 표시
    el.innerHTML = headerHtml(colName, st) + st.rows.map(r => clickRowHtml(colName, r)).join('');
    moreBtn.style.display = st.pager.done ? 'none' : 'flex';
    return;
  }
  setLoading(el);
  moreBtn.disabled = true;
  try {
    // 오늘 개수는 count 집계 (문서 다운로드 없음)
    if (st.todayCount === null) {
      st.todayCount = await countQuery(collection(db, colName), where('date', '==', getTodayDateStr())).catch(() => null);
    }
    const page = await st.pager.next();
    st.rows.push(...page);
    if (!st.rows.length) { setEmpty(el, `${CLICK_LABELS[colName]} 기록이 없어요`); }
    else el.innerHTML = headerHtml(colName, st) + st.rows.map(r => clickRowHtml(colName, r)).join('');
    moreBtn.style.display = st.pager.done ? 'none' : 'flex';
  } catch (e) {
    setError(el, humanError(e));
  } finally {
    moreBtn.disabled = false;
  }
}
function headerHtml(colName, st) {
  return `<div class="card-note" style="margin-bottom:4px;">오늘 ${CLICK_LABELS[colName]} ${st.todayCount != null ? fmtNum(st.todayCount) + '회' : '-'} · 최근 기록부터 ${PAGE_SIZE}건씩</div>`;
}
async function loadMoreClickLog(colName) {
  const st = clickState[colName];
  if (!st || st.pager.done) return;
  const el = document.getElementById('clickLogList');
  const moreBtn = document.getElementById('clickLogMoreBtn');
  moreBtn.disabled = true;
  try {
    const page = await st.pager.next();
    st.rows.push(...page);
    el.innerHTML = headerHtml(colName, st) + st.rows.map(r => clickRowHtml(colName, r)).join('');
    moreBtn.style.display = st.pager.done ? 'none' : 'flex';
  } catch (e) {
    setError(el, humanError(e));
  } finally {
    moreBtn.disabled = false;
  }
}

// ── 바인딩 / 로드 ──
// 스킨 선물 기본 메시지 — 닉네임 자동 삽입. 운영자가 손대지 않은 동안만 닉 변경에 맞춰 갱신.
const SKIN_DEFAULT_MSG = (nick) => `${nick}님 감사합니다! 스킨 예쁘게 써주세요 💛`;

export function initRewardsTab() {
  // ── 유저에게 보내기: 닉네임 + 세그먼트(스킨/쪽지/감사) + 확인창 + 미리보기 ──
  const nickInput = document.getElementById('rwNick');
  const skinMsgEl = document.getElementById('rwSkinMsg');
  const noteMsgEl = document.getElementById('rwNoteMsg');
  const nickOf = () => nickInput.value.trim();
  const skinMsgOf = () => (skinMsgEl.value || '').trim();
  const noteMsgOf = () => (noteMsgEl.value || '').trim();
  let currentKind = 'skin';
  let skinMsgUserEdited = false; // 운영자가 스킨 메시지를 직접 손댔는지 — 손댔으면 닉 변경으로 초기화 안 함

  // 스킨 기본 메시지 채우기(손대지 않은 상태에서만) — 프로그램 .value 설정은 input 이벤트를 안 발생시켜 edited 플래그 유지
  function syncSkinDefault() {
    if (skinMsgUserEdited) return;
    const n = nickOf();
    skinMsgEl.value = n ? SKIN_DEFAULT_MSG(n) : '';
  }

  // 세그먼트 전환 — 선택한 기능 패널 하나만 표시
  const seg = document.getElementById('rwSeg');
  const panels = () => document.querySelectorAll('#tab-rewards .rw-panel');
  function switchKind(kind) {
    currentKind = kind;
    seg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.kind === kind));
    panels().forEach(p => { p.style.display = p.dataset.panel === kind ? '' : 'none'; });
    if (kind === 'skin') syncSkinDefault();
    hidePreview();
  }
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) switchKind(btn.dataset.kind);
  });

  // 감사 인사 문구 미리보기(고정 문구, 닉네임 자동 삽입)
  const greetEl = document.getElementById('rwGreetPreview');
  const updateGreetPreview = () => { const n = nickOf() || '○○'; greetEl.textContent = `${n}님 감사합니다! 함께해줘서 고맙다냥 🐾`; };

  // 전송 버튼 활성/비활성 — 닉네임 없으면 비활성
  const skinBtn = document.getElementById('rwSkinGiftBtn');
  const noteBtn = document.getElementById('rwNoteBtn');
  const greetBtn = document.getElementById('rwGreetBtn');
  const revokeBtn = document.getElementById('rwSkinRevokeBtn');
  function updateButtons() {
    const has = !!nickOf();
    [skinBtn, noteBtn, greetBtn].forEach(b => { if (b) b.disabled = !has; });
    if (revokeBtn) revokeBtn.disabled = !has;
  }

  // 닉네임 입력 → 감사문구·스킨기본메시지 갱신 + 버튼 상태 + (열려 있으면)미리보기 즉시 반영
  nickInput.addEventListener('input', () => { updateGreetPreview(); syncSkinDefault(); updateButtons(); refreshPreviewIfOpen(); });
  // 스킨 메시지를 직접 입력하면(수정/삭제 포함) 이후 닉 변경으로 초기화하지 않음
  skinMsgEl.addEventListener('input', () => { skinMsgUserEdited = true; refreshPreviewIfOpen(); });
  noteMsgEl.addEventListener('input', () => { refreshPreviewIfOpen(); });
  updateGreetPreview(); syncSkinDefault(); updateButtons();

  // 받는 화면 팝업 미리보기 (기본 접힘) — 선택한 탭 하나만, 실제 닉네임/메시지 즉시 반영
  const previewBox = document.getElementById('rwPreview');
  function hidePreview() { previewBox.style.display = 'none'; previewBox.innerHTML = ''; }
  function previewHtml() {
    const nick = nickOf() || '○○';
    if (currentKind === 'skin') {
      const msg = skinMsgOf();
      return `<div class="rw-preview-pop"><div class="pe">🎁</div>
        <div class="pt">${escapeHtml(nick)}님, 고양이 스킨이 도착했어요!</div>
        <div class="pb">새로운 친구가 찾아왔다냥 🐾</div>
        ${msg ? `<div class="pn">${escapeHtml(msg)}</div>` : ''}
        <div class="pbtn">새 스킨 확인하기</div></div>`;
    } else if (currentKind === 'note') {
      const msg = noteMsgOf() || '(내용을 입력하세요)';
      return `<div class="rw-preview-pop"><div class="pe">💌</div>
        <div class="pt">${escapeHtml(nick)}님, 쪽지가 도착했어요!</div>
        <div class="pn">${escapeHtml(msg)}</div>
        <div class="pbtn">확인했어요</div></div>`;
    }
    return `<div class="rw-preview-pop"><div class="pe">💛</div>
      <div class="pt">${escapeHtml(nick)}님 감사합니다!</div>
      <div class="pb">함께해줘서 고맙다냥 🐾</div>
      <div class="pbtn">알았다냥</div></div>`;
  }
  function renderPreview() { previewBox.innerHTML = previewHtml(); previewBox.style.display = 'block'; }
  function refreshPreviewIfOpen() { if (previewBox.style.display === 'block') previewBox.innerHTML = previewHtml(); }
  document.getElementById('rwPreviewBtn').addEventListener('click', () => {
    if (previewBox.style.display === 'block') hidePreview(); else renderPreview();
  });

  // 전송 성공 후 입력 초기화
  function resetInputs() {
    nickInput.value = ''; skinMsgEl.value = ''; noteMsgEl.value = '';
    skinMsgUserEdited = false;
    updateGreetPreview(); updateButtons(); hidePreview();
  }
  const skinSend = async () => {
    const nick = nickOf();
    if (!nick) { resultMsg('rwResult', '받는 사람 닉네임을 입력하세요.', false); return; }
    if (!confirm(`${nick}님에게 고양이 스킨을 선물할까요?`)) return;
    try { await giftSkin(nick, skinMsgOf()); resetInputs(); } catch (e) { resultMsg('rwResult', humanError(e), false); }
  };
  const noteSend = async () => {
    const nick = nickOf();
    if (!nick) { resultMsg('rwResult', '받는 사람 닉네임을 입력하세요.', false); return; }
    const msg = noteMsgOf();
    if (!msg) { resultMsg('rwResult', '보낼 쪽지 내용을 입력하세요.', false); return; }
    if (!confirm(`${nick}님에게 개인 쪽지를 보낼까요?`)) return;
    try { await sendPersonalNote(nick, msg); resetInputs(); } catch (e) { resultMsg('rwResult', humanError(e), false); }
  };
  const greetSend = async () => {
    const nick = nickOf();
    if (!nick) { resultMsg('rwResult', '받는 사람 닉네임을 입력하세요.', false); return; }
    if (!confirm(`${nick}님에게 감사 인사를 보낼까요?`)) return;
    try { await sendGreeting(nick); resetInputs(); } catch (e) { resultMsg('rwResult', humanError(e), false); }
  };
  const revokeDo = async () => {
    const nick = nickOf();
    if (!nick) { resultMsg('rwResult', '받는 사람 닉네임을 입력하세요.', false); return; }
    if (!confirm(`${nick}님의 고양이 스킨을 해제할까요?`)) return;
    try { await revokeSkin(nick); resetInputs(); } catch (e) { resultMsg('rwResult', humanError(e), false); }
  };
  skinBtn.addEventListener('click', guardBtn(skinBtn, skinSend));
  noteBtn.addEventListener('click', guardBtn(noteBtn, noteSend));
  greetBtn.addEventListener('click', guardBtn(greetBtn, greetSend));
  revokeBtn.addEventListener('click', guardBtn(revokeBtn, revokeDo));
}

export async function loadRewards() {
  // 클릭 기록은 이 화면에서 제거됨(향후 '통계 > 사용자 행동'으로 이동 예정) — 이 탭은 로드할 원격 데이터 없음.
}

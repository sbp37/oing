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
export function initRewardsTab() {
  // 게임에서 꺼진 기능은 관리자 UI에서도 숨김 — 옵션 제거로 선택/조회 자체가 불가능
  if (!FEATURES.skinRequests) {
    const opt = document.querySelector('#clickLogSel option[value="skin_requests"]');
    if (opt) opt.remove();
  }
  // ── 유저에게 보내기: 닉네임 + 세그먼트(스킨/쪽지/감사) + 확인창 + 미리보기 ──
  const nickOf = () => document.getElementById('rwNick').value.trim();
  const skinMsgOf = () => (document.getElementById('rwSkinMsg').value || '').trim();
  const noteMsgOf = () => (document.getElementById('rwNoteMsg').value || '').trim();
  let currentKind = 'skin';

  // 세그먼트 전환 — 선택한 기능 패널 하나만 표시
  const seg = document.getElementById('rwSeg');
  const panels = () => document.querySelectorAll('#tab-rewards .rw-panel');
  function switchKind(kind) {
    currentKind = kind;
    seg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.kind === kind));
    panels().forEach(p => { p.style.display = p.dataset.panel === kind ? '' : 'none'; });
    hidePreview();
  }
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (btn) switchKind(btn.dataset.kind);
  });

  // 감사 인사 문구 미리보기 — 닉네임 자동 삽입
  const greetEl = document.getElementById('rwGreetPreview');
  const updateGreetPreview = () => { const n = nickOf(); greetEl.textContent = `${n || '○○'}님 감사합니다!`; };
  document.getElementById('rwNick').addEventListener('input', () => { updateGreetPreview(); hidePreview(); });
  updateGreetPreview();

  // 받는 화면 팝업 미리보기 (게임 팝업 축소 재현) — 실제 닉네임/메시지 즉시 반영
  const previewBox = document.getElementById('rwPreview');
  function hidePreview() { previewBox.style.display = 'none'; previewBox.innerHTML = ''; }
  function renderPreview() {
    const nick = nickOf() || '○○';
    let html = '';
    if (currentKind === 'skin') {
      const msg = skinMsgOf();
      html = `<div class="rw-preview-pop"><div class="pe">🎁</div>
        <div class="pt">${escapeHtml(nick)}님, 고양이 스킨이 도착했어요!</div>
        <div class="pb">새로운 친구가 찾아왔어요 🐾</div>
        ${msg ? `<div class="pn">${escapeHtml(msg)}</div>` : ''}
        <div class="pbtn">스킨 확인하기</div></div>`;
    } else if (currentKind === 'note') {
      const msg = noteMsgOf() || '(내용을 입력하세요)';
      html = `<div class="rw-preview-pop"><div class="pe">💌</div>
        <div class="pt">${escapeHtml(nick)}님, 쪽지가 도착했어요!</div>
        <div class="pn">${escapeHtml(msg)}</div>
        <div class="pbtn">확인했어요</div></div>`;
    } else {
      html = `<div class="rw-preview-pop"><div class="pe">💛</div>
        <div class="pt">${escapeHtml(nick)}님 감사합니다!</div>
        <div class="pb">오잉게임과 함께해주셔서 고마워요 🐾</div>
        <div class="pbtn">확인했어요</div></div>`;
    }
    previewBox.innerHTML = html;
    previewBox.style.display = 'block';
  }
  document.getElementById('rwPreviewBtn').addEventListener('click', () => {
    if (previewBox.style.display === 'block') hidePreview(); else renderPreview();
  });

  // 전송 — 닉네임 확인 + confirm 확인창 후 전송, 성공 시 입력 비움
  const send = (label, fn) => async () => {
    const nick = nickOf();
    if (!nick) { resultMsg('rwResult', '받는 사람 닉네임을 입력하세요.', false); return; }
    if (!confirm(`${nick}님에게 ${label}할까요?`)) return;
    try {
      await fn(nick);
      document.getElementById('rwNick').value = '';
      document.getElementById('rwSkinMsg').value = '';
      document.getElementById('rwNoteMsg').value = '';
      updateGreetPreview(); hidePreview();
    } catch (e) { resultMsg('rwResult', humanError(e), false); }
  };
  const skinBtn = document.getElementById('rwSkinGiftBtn');
  skinBtn.addEventListener('click', guardBtn(skinBtn, send('고양이 스킨을 선물', (nick) => giftSkin(nick, skinMsgOf()))));
  const revokeBtn = document.getElementById('rwSkinRevokeBtn');
  revokeBtn.addEventListener('click', guardBtn(revokeBtn, send('고양이 스킨을 해제', revokeSkin)));
  const noteBtn = document.getElementById('rwNoteBtn');
  noteBtn.addEventListener('click', guardBtn(noteBtn, async () => {
    const nick = nickOf();
    if (!nick) { resultMsg('rwResult', '받는 사람 닉네임을 입력하세요.', false); return; }
    const msg = noteMsgOf();
    if (!msg) { resultMsg('rwResult', '보낼 쪽지 내용을 입력하세요.', false); return; }
    if (!confirm(`${nick}님에게 개인 쪽지를 보낼까요?`)) return;
    try { await sendPersonalNote(nick, msg); document.getElementById('rwNick').value = ''; document.getElementById('rwNoteMsg').value = ''; updateGreetPreview(); hidePreview(); }
    catch (e) { resultMsg('rwResult', humanError(e), false); }
  }));
  const greetBtn = document.getElementById('rwGreetBtn');
  greetBtn.addEventListener('click', guardBtn(greetBtn, send('감사 인사를 보내', sendGreeting)));

  document.getElementById('clickLogSel').addEventListener('change', (e) => loadClickLog(e.target.value));
  // 스킨 신청 "처리 완료" — 목록이 다시 그려져도 동작하도록 위임 바인딩 (1회)
  document.getElementById('clickLogList').addEventListener('click', (e) => {
    const btn = e.target.closest('.skinreq-fulfill');
    if (btn && !btn.disabled) fulfillSkinRequest(btn.dataset.reqid, btn);
  });
  const moreBtn = document.getElementById('clickLogMoreBtn');
  moreBtn.addEventListener('click', () => loadMoreClickLog(document.getElementById('clickLogSel').value));
}

export async function loadRewards({ force = false } = {}) {
  if (force) { for (const k of Object.keys(clickState)) delete clickState[k]; }
  const colName = document.getElementById('clickLogSel').value;
  await loadClickLog(colName, { reset: force });
}

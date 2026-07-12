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

// ── 스킨 / 감사 쪽지 (기존 로직 그대로) ──
async function grantSkin(nick) {
  await setDoc(doc(db, 'nickname_skins', nick), { cat: true, notifyPending: true }, { merge: true });
  resultMsg('rwResult', `😻 '${escapeHtml(nick)}' 님에게 고양이 스킨을 적용했어요. 다음 접속 때 알림 팝업이 떠요.`);
}
async function revokeSkin(nick) {
  await setDoc(doc(db, 'nickname_skins', nick), { cat: false }, { merge: true });
  resultMsg('rwResult', `'${escapeHtml(nick)}' 님의 고양이 스킨을 해제했어요.`);
}
async function sendThanksNote(nick) {
  await setDoc(doc(db, 'nickname_skins', nick), { thanksPending: true }, { merge: true });
  resultMsg('rwResult', `💌 '${escapeHtml(nick)}' 님에게 감사 쪽지를 보냈어요. 다음 접속 때 팝업으로 한 번 떠요.`);
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

// ── 후원 확인 쪽지함 (feedback_donate) ──
// 답장은 일반 피드백과 완전히 동일한 구조 재사용: messages 배열에 {from:'admin'} 추가 +
// userUnread:true (유저 접속 시 "새 답변" 배너·지난 글 보기 NEW 표시) + adminUnread:false.
// 원문(입금자명 등)은 그대로 유지 — merge 저장이라 다른 필드는 건드리지 않음.
let donatePager = null;
const donateRows = [];
function donateItemHtml(d) {
  const msgs = Array.isArray(d.messages) ? d.messages : [];
  const hasUid = !!d.uid;
  return `
    <div class="fb-item ${d.adminUnread ? 'unread' : ''}" data-id="${escapeHtml(d.id)}">
      <div class="fb-head">
        <span><span class="nick">${escapeHtml(d.nickname || '?')}</span>${d.adminUnread ? ' 🔔' : ''}
          ${d.type === 'donate_confirm' ? '<span class="badge gold">입금 확인</span>' : ''}</span>
        <span class="sub">${fmtDateTime(d.lastTs || d.ts)}</span>
      </div>
      ${msgs.map(m => `
        <div class="fb-msg ${m.from === 'admin' ? 'from-admin' : ''}">
          <span class="bubble">${escapeHtml(m.text)}</span>
        </div>`).join('')}
      ${hasUid ? '' : `<div class="card-note">⚠️ 이 글에는 작성 당시 계정(UID) 정보가 저장되지 않았어요 — 유저가 지금은 계정을 연결한 상태일 수도 있지만,
        "이 글"의 답장은 게임의 '지난 글 보기'에 연결되지 않아요 (전달이 필요하면 스킨 알림·감사 쪽지 권장)</div>`}
      <div class="fb-reply-row">
        <textarea class="fb-reply-input" placeholder="답장 작성... (작성자만 게임의 '지난 글 보기'에서 확인)" rows="2"></textarea>
        <button class="btn btn-primary btn-sm donate-reply-btn">답장 보내기</button>
      </div>
    </div>`;
}

function renderDonateFeedback() {
  const el = document.getElementById('donateFeedbackList');
  if (!donateRows.length) { setEmpty(el, '후원 확인 쪽지가 없어요'); return; }
  el.innerHTML = donateRows.map(donateItemHtml).join('');
  el.querySelectorAll('.donate-reply-btn').forEach(btn => {
    btn.addEventListener('click', guardBtn(btn, async () => {
      const item = btn.closest('.fb-item');
      const id = item.dataset.id;
      const textarea = item.querySelector('.fb-reply-input');
      const replyText = (textarea.value || '').trim();
      if (!replyText) return;
      try {
        const row = donateRows.find(r => r.id === id);
        const messages = Array.isArray(row.messages) ? [...row.messages] : [];
        const ts = Date.now();
        messages.push({ from: 'admin', text: replyText, ts });
        await setDoc(doc(db, 'feedback_donate', id), { messages, lastTs: ts, userUnread: true, adminUnread: false }, { merge: true });
        Object.assign(row, { messages, lastTs: ts, userUnread: true, adminUnread: false });
        renderDonateFeedback();
      } catch (e) {
        alert('답장 전송 실패: ' + humanError(e));
      }
    }));
  });
}
async function loadDonateFeedback({ reset = false } = {}) {
  const el = document.getElementById('donateFeedbackList');
  const moreBtn = document.getElementById('donateFeedbackMoreBtn');
  if (reset || !donatePager) {
    donatePager = makePager(() => [collection(db, 'feedback_donate'), orderBy('lastTs', 'desc')], PAGE_SIZE);
    donateRows.length = 0;
  }
  if (!donateRows.length) setLoading(el);
  moreBtn.disabled = true;
  try {
    const page = await donatePager.next();
    donateRows.push(...page);
    renderDonateFeedback();
    moreBtn.style.display = donatePager.done ? 'none' : 'flex';
  } catch (e) {
    setError(el, humanError(e));
  } finally {
    moreBtn.disabled = false;
  }
}

// ── 클릭 기록 (990원/응원/간식/서포터팩/공유/스킨신청/젤리상점) ──
const CLICK_LABELS = {
  donate_clicks: '990원 응원',
  support_topbtn_clicks: '응원하기',
  snack_clicks: '간식',
  supporterpack_clicks: '서포터팩',
  share_clicks: '카톡 공유',
  skin_requests: '스킨 신청',
  jellyshop_clicks: '젤리상점',
  tutorial_starts: '튜토리얼 시작',
  updatelog_clicks: '업데이트로그',
  thanks_toggle_clicks: '감사메시지 열람',
};
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
  const nickOf = () => document.getElementById('rwNick').value.trim();
  const needNick = (fn) => async () => {
    const nick = nickOf();
    if (!nick) { resultMsg('rwResult', '닉네임을 입력하세요.', false); return; }
    try { await fn(nick); document.getElementById('rwNick').value = ''; }
    catch (e) { resultMsg('rwResult', humanError(e), false); }
  };
  const g = document.getElementById('rwSkinGrantBtn');
  g.addEventListener('click', guardBtn(g, needNick(grantSkin)));
  const r = document.getElementById('rwSkinRevokeBtn');
  r.addEventListener('click', guardBtn(r, needNick(revokeSkin)));
  const t = document.getElementById('rwThanksNoteBtn');
  t.addEventListener('click', guardBtn(t, needNick(sendThanksNote)));
  const j = document.getElementById('rwJellyBtn');
  j.addEventListener('click', guardBtn(j, needNick(async (nick) => {
    const amount = Math.floor(Number(document.getElementById('rwJellyAmount').value));
    if (!amount || amount < 1) { resultMsg('rwResult', '지급할 젤리 개수를 입력하세요.', false); return; }
    await grantJelly(nick, amount);
  })));

  document.getElementById('clickLogSel').addEventListener('change', (e) => loadClickLog(e.target.value));
  // 스킨 신청 "처리 완료" — 목록이 다시 그려져도 동작하도록 위임 바인딩 (1회)
  document.getElementById('clickLogList').addEventListener('click', (e) => {
    const btn = e.target.closest('.skinreq-fulfill');
    if (btn && !btn.disabled) fulfillSkinRequest(btn.dataset.reqid, btn);
  });
  const moreBtn = document.getElementById('clickLogMoreBtn');
  moreBtn.addEventListener('click', () => loadMoreClickLog(document.getElementById('clickLogSel').value));
  const dMoreBtn = document.getElementById('donateFeedbackMoreBtn');
  dMoreBtn.addEventListener('click', () => loadDonateFeedback());
}

export async function loadRewards({ force = false } = {}) {
  if (force) { donatePager = null; for (const k of Object.keys(clickState)) delete clickState[k]; }
  const colName = document.getElementById('clickLogSel').value;
  await Promise.allSettled([
    loadDonateFeedback({ reset: force }),
    loadClickLog(colName, { reset: force }),
  ]);
}

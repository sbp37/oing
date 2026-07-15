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
  fetchDocs, fetchDoc, setDoc, increment, deleteField, makePager, getUserDocByNick, countQuery,
  getTodayDateStr, fmtDateTime, fmtAgo, fmtNum, escapeHtml, humanError, normalizeNickname, FEATURES,
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
// 감사 쪽지 — 내용을 쓰면 그 문구가, 비우면 기본 감사 문구가 유저 팝업에 표시됨.
// 닉네임 기반(nickname_skins/{닉})이라 계정 연결 여부와 무관하게 누구에게나 전달 가능.
async function sendThanksNote(nick) {
  const text = (document.getElementById('rwThanksText').value || '').trim();
  await setDoc(doc(db, 'nickname_skins', nick), { thanksPending: true, thanksText: text }, { merge: true });
  document.getElementById('rwThanksText').value = '';
  resultMsg('rwResult', `💌 '${escapeHtml(nick)}' 님에게 쪽지를 보냈어요${text ? ` — "${escapeHtml(text.slice(0, 30))}${text.length > 30 ? '…' : ''}"` : ' (기본 감사 문구)'}. 다음 접속 때 팝업으로 떠요.`);
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
  // uid가 없는 글: 경고 + "🔗 계정 연결" 버튼 (검색 패널은 버튼을 눌렀을 때만 열림 — 그전 조회 0)
  // 관리자가 수동 연결한 글(uidLinkedByAdminAt 존재): 연결됨 표시 + 연결 해제 버튼
  let uidSection = '';
  if (!hasUid) {
    uidSection = `
      <div class="card-note">⚠️ 이 글에는 작성 당시 계정(UID) 정보가 저장되지 않았어요 — 유저가 지금은 계정을 연결한 상태일 수도 있지만,
        "이 글"의 답장은 게임의 '지난 글 보기'에 연결되지 않아요.</div>
      <button class="btn btn-primary btn-sm donate-link-btn" style="margin-top:6px;">🔗 계정 연결</button>
      <div class="donate-link-panel" style="display:none; margin-top:8px; padding:8px; border:1px solid var(--border); border-radius:8px; background:var(--surface);">
        <div class="row">
          <input class="dl-input" type="text" placeholder="현재 닉네임으로 검색" value="${escapeHtml(d.nickname || '')}">
          <button class="btn btn-primary btn-sm dl-search">검색</button>
        </div>
        <div class="card-note" style="margin-top:4px;">닉네임은 계정을 찾기 위한 힌트일 뿐, 확인 후 직접 연결해야 해요. 자동 연결되지 않습니다.</div>
        <div class="dl-result" style="margin-top:6px;"></div>
      </div>`;
  } else if (d.uidLinkedByAdminAt) {
    uidSection = `
      <div class="card-note" style="color:var(--accent-green-light);">✅ 계정 연결됨 (관리자 수동${d._linkedNick ? ` · 현재 닉네임 ${escapeHtml(d._linkedNick)}` : ''}) —
        이제 답장이 작성자의 '지난 글 보기'에 표시돼요.
        <button class="btn btn-ghost btn-sm donate-unlink-btn" style="margin-left:6px;">연결 해제</button></div>`;
  }
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
      ${uidSection}
      <div class="fb-reply-row">
        <textarea class="fb-reply-input" placeholder="답장 작성... (작성자만 게임의 '지난 글 보기'에서 확인)" rows="2"></textarea>
        <button class="btn btn-primary btn-sm donate-reply-btn">답장 보내기</button>
      </div>
    </div>`;
}

// ── UID 없는 과거 글 → 실제 계정 수동 연결 ──
// 검색은 게임과 동일한 매핑 구조 재사용: nickname_lookup/{정규화닉} 문서 1개 조회,
// 닉변 유저는 tombstone(renamedTo) 체인을 최대 6홉 따라감 (게임 resolveCurrentNickname과 동일 원리).
// 자동 연결 절대 없음 — 후보 표시 → 관리자 확인창 → 명시적 클릭 시에만 uid merge 저장.
async function searchAccountCandidate(rawNick) {
  const startNorm = normalizeNickname(rawNick);
  if (!startNorm) return { status: 'empty' };
  let curNorm = startNorm, curRaw = rawNick, renamed = false, lk = null;
  const seen = new Set();
  for (let hop = 0; hop < 6; hop++) {
    if (seen.has(curNorm)) break; // alias loop 차단
    seen.add(curNorm);
    lk = await fetchDoc(doc(db, 'nickname_lookup', curNorm));
    if (!lk) return { status: 'notfound' };
    if (lk.nickname) curRaw = lk.nickname;
    if (!lk.renamedTo) break;      // 활성 닉 도달
    renamed = true;
    curNorm = normalizeNickname(lk.renamedTo);
  }
  if (!lk || !lk.uid) return { status: 'no-uid', nickname: curRaw };
  // 후보 식별 정보 (문서 2개만 직접 조회 — 풀스캔 없음)
  const [stats, userDoc] = await Promise.all([
    fetchDoc(doc(db, 'user_stats', lk.uid)).catch(() => null),
    fetchDoc(doc(db, 'users', lk.uid)).catch(() => null),
  ]);
  return {
    status: 'found',
    uid: lk.uid,
    nickname: (userDoc && userDoc.nickname) || curRaw,
    renamed, searchedNick: rawNick,
    lastSeenAt: (userDoc && userDoc.lastSeenAt) || (stats && stats.lastPlayed) || null,
    bestScore: stats ? (stats.bestScore ?? null) : null,
  };
}

function renderCandidate(resultEl, cand, post) {
  if (cand.status === 'empty') { resultEl.innerHTML = ''; return; }
  if (cand.status === 'notfound') {
    resultEl.innerHTML = '<div class="list-empty">연결 가능한 계정을 찾지 못했습니다.<br>닉네임을 다시 확인해주세요.</div>';
    return;
  }
  if (cand.status === 'no-uid') {
    resultEl.innerHTML = `<div class="list-empty">'${escapeHtml(cand.nickname)}' — 현재 연결 가능한 UID 계정이 없습니다.<br>해당 유저가 먼저 게임에서 계정 연결을 완료해야 합니다.</div>`;
    return;
  }
  const renameNote = cand.renamed
    ? `<div class="card-note" style="color:#fde68a;">↪ 검색한 '${escapeHtml(cand.searchedNick)}'은(는) 현재 '${escapeHtml(cand.nickname)}'(으)로 닉네임이 변경된 계정입니다.</div>` : '';
  resultEl.innerHTML = `
    ${renameNote}
    <div class="list-row">
      <span class="main"><span class="nick">${escapeHtml(cand.nickname)}</span> <span class="badge green">계정 연동</span><br>
        <span class="sub">UID ${escapeHtml(cand.uid.slice(0, 10))}… · 최근 접속 ${cand.lastSeenAt ? fmtAgo(cand.lastSeenAt) : '-'} · 최고 ${cand.bestScore != null ? fmtNum(cand.bestScore) + 'pt' : '-'}</span></span>
      <button class="btn btn-warm btn-sm dl-confirm" data-uid="${escapeHtml(cand.uid)}" data-nick="${escapeHtml(cand.nickname)}">이 계정에 연결</button>
    </div>`;
}

// 최종 연결 — 확인창 통과 시에만 uid + 수동연결 표시 필드만 merge (기존 필드 무손실)
async function linkDonateToUid(id, uid, candNick, btn) {
  const row = donateRows.find(r => r.id === id);
  if (!row) return;
  const ok = confirm(
    `이 후원 확인 글을 아래 계정에 연결할까요?\n\n`
    + `글 작성자 표시: ${row.nickname || '?'}\n`
    + `연결할 현재 계정: ${candNick}\n`
    + `UID: ${uid.slice(0, 14)}…\n\n`
    + `연결 후:\n`
    + `- 해당 유저의 '지난 글 보기'에 이 글이 표시됩니다.\n`
    + `- 관리자 답변도 해당 유저가 확인할 수 있습니다.`);
  if (!ok) return;
  btn.disabled = true;
  try {
    const linkedAt = Date.now();
    await setDoc(doc(db, 'feedback_donate', id), { uid, uidLinkedByAdminAt: linkedAt }, { merge: true });
    Object.assign(row, { uid, uidLinkedByAdminAt: linkedAt, _linkedNick: candNick });
    renderDonateFeedback(); // 세션 캐시 기반 재렌더 — Firestore 재조회 0
  } catch (e) {
    btn.disabled = false;
    alert('계정 연결 실패: ' + humanError(e));
  }
}

// 연결 해제 — 관리자가 수동 연결한 글만 대상. uid 관련 필드만 제거, 원문·답변은 그대로.
async function unlinkDonate(id, btn) {
  const row = donateRows.find(r => r.id === id);
  if (!row) return;
  const ok = confirm(
    `이 글의 계정 연결을 해제할까요?\n\n`
    + `연결 해제 후 해당 유저의 '지난 글 보기'에서는 이 글이 보이지 않게 됩니다.\n`
    + `글과 관리자 답변 데이터는 삭제되지 않습니다.`);
  if (!ok) return;
  btn.disabled = true;
  try {
    await setDoc(doc(db, 'feedback_donate', id), { uid: deleteField(), uidLinkedByAdminAt: deleteField() }, { merge: true });
    delete row.uid;
    delete row.uidLinkedByAdminAt;
    delete row._linkedNick;
    renderDonateFeedback();
  } catch (e) {
    btn.disabled = false;
    alert('연결 해제 실패: ' + humanError(e));
  }
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
  // ⭐ 리뷰 버튼 클릭 — 랭킹탭/메인 어디서 눌렀는지 배지로 구분 표시
  if (colName === 'review_entry_clicks') {
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

  // 계정 연결/해제 — 목록이 다시 그려져도 동작하도록 위임 바인딩 (1회)
  const donateList = document.getElementById('donateFeedbackList');
  donateList.addEventListener('click', async (e) => {
    const item = e.target.closest('.fb-item');
    if (!item) return;
    const id = item.dataset.id;

    const linkBtn = e.target.closest('.donate-link-btn');
    if (linkBtn) { // 패널 토글만 — 이 시점까지 Firestore 조회 0
      const panel = item.querySelector('.donate-link-panel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      return;
    }
    const searchBtn = e.target.closest('.dl-search');
    if (searchBtn && !searchBtn.disabled) {
      const input = item.querySelector('.dl-input');
      const resultEl = item.querySelector('.dl-result');
      const nick = (input.value || '').trim();
      if (!nick) { resultEl.innerHTML = '<div class="list-empty">닉네임을 입력하세요.</div>'; return; }
      searchBtn.disabled = true;
      resultEl.innerHTML = '<div class="list-loading">계정 확인 중...</div>';
      try {
        const cand = await searchAccountCandidate(nick);
        renderCandidate(resultEl, cand, donateRows.find(r => r.id === id));
      } catch (err) {
        resultEl.innerHTML = `<div class="list-error">⚠️ ${humanError(err)}</div>`;
      } finally {
        searchBtn.disabled = false;
      }
      return;
    }
    const confirmBtn = e.target.closest('.dl-confirm');
    if (confirmBtn && !confirmBtn.disabled) {
      await linkDonateToUid(id, confirmBtn.dataset.uid, confirmBtn.dataset.nick, confirmBtn);
      return;
    }
    const unlinkBtn = e.target.closest('.donate-unlink-btn');
    if (unlinkBtn && !unlinkBtn.disabled) {
      await unlinkDonate(id, unlinkBtn);
    }
  });
  donateList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('dl-input')) {
      e.preventDefault();
      const btn = e.target.closest('.donate-link-panel').querySelector('.dl-search');
      if (btn) btn.click();
    }
  });
}

export async function loadRewards({ force = false } = {}) {
  if (force) { donatePager = null; for (const k of Object.keys(clickState)) delete clickState[k]; }
  const colName = document.getElementById('clickLogSel').value;
  await Promise.allSettled([
    loadDonateFeedback({ reset: force }),
    loadClickLog(colName, { reset: force }),
  ]);
}

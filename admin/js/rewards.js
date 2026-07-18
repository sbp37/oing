// ══════════════════════════════════════════════════════════════
//  rewards.js — 후원 / 리워드 탭
//
//  · 스킨 지급/해제/감사쪽지: 기존 관리자와 완전히 동일한 데이터 방식
//    (nickname_skins/{닉네임} 문서에 cat / notifyPending / thanksPending 플래그,
//     merge 저장 — 게임 쪽 checkSkinNotification 이 그대로 알아듣는다)
//  · 클릭 기록 열람은 '📊 통계 > 사용자 행동'(statstab.js)으로 이동됨.
// ══════════════════════════════════════════════════════════════
import { db, doc, setDoc, escapeHtml, humanError } from './firebase.js';
import { guardBtn, resultMsg } from './admin.js';

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
  const panels = () => document.querySelectorAll('#acc-send .rw-panel');
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

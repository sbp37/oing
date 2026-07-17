// ══════════════════════════════════════════════════════════════
//  operations.js — 운영 탭 (피드백 / 감사메시지 / 명예의전당 / 챔피언 동기화)
//
//  · 피드백: 처음 30건 + "이전 문의 더 보기" 페이지네이션.
//    답글은 기존 관리자와 동일하게 messages 배열에 추가하고
//    userUnread:true / adminUnread:false 로 저장 (게임 쪽 알림 로직 그대로 동작)
//  · 감사메시지: meta/weeklyThanks — 기존과 동일한 문서/필드
//  · 명예의전당: champions 컬렉션 상위 50 + meta/currentChampion
// ══════════════════════════════════════════════════════════════
import {
  db, collection, doc, query, orderBy, limit, where,
  fetchDocs, fetchDoc, setDoc, makePager, countQuery,
  fmtDateTime, fmtNum, escapeHtml, cache, humanError,
} from './firebase.js';

// 💬 새(안 읽은) 피드백 배지 — adminUnread=true 문서 개수만 count 집계(문서 다운로드 0).
// 글을 펼쳐 읽으면 adminUnread=false로 바뀌므로 배지가 자연히 줄어든다.
export async function loadFeedbackNewBadge() {
  const badge = document.getElementById('feedbackNewBadge');
  const countEl = document.getElementById('feedbackNewCount');
  if (!badge || !countEl) return;
  try {
    const n = await countQuery(query(collection(db, 'feedback'), where('adminUnread', '==', true)));
    if (n > 0) { countEl.textContent = n >= 50 ? '50+' : String(n); badge.style.display = ''; }
    else badge.style.display = 'none';
  } catch (e) {
    console.warn('새 피드백 배지 로드 실패(무해):', e && (e.code || e.message));
    badge.style.display = 'none';
  }
}
import { setLoading, setError, setEmpty, guardBtn, resultMsg } from './admin.js';

const PAGE_SIZE = 30;

// ── 피드백 관리 ──
// · 최신 작성글이 맨 위 (ts = createdAt 기준 desc, 커서 페이지네이션 유지)
// · 기본은 접힌 컴팩트 카드(NEW 배지 + 본문 미리보기 1줄) — 클릭한 카드만 펼쳐짐
// · NEW 판별: 기존 adminUnread 필드 재사용 (새 글/유저 추가 메시지 때 게임이 true로 설정,
//   답변 여부와 무관). 관리자가 카드를 실제로 "펼쳤을 때"만 adminUnread:false 로 읽음 처리 —
//   목록에 렌더링된 것만으로는 절대 읽음 처리하지 않는다.
let fbPager = null;
const fbRows = [];
const fbExpanded = new Set(); // 펼쳐진 문서 id — 카드별 독립

function getMsgs(d) { // 옛 단일 필드(content/reply) 구조 호환
  if (Array.isArray(d.messages)) return d.messages;
  const msgs = [{ from: 'user', text: d.content || '', ts: d.ts || 0 }];
  if (d.reply) msgs.push({ from: 'admin', text: d.reply, ts: d.ts || 0 });
  return msgs;
}
function previewText(d) {
  const msgs = getMsgs(d);
  const lastUser = [...msgs].reverse().find(m => m.from !== 'admin');
  return ((lastUser ? lastUser.text : msgs[0]?.text) || '').replace(/\s+/g, ' ');
}

function feedbackItemHtml(d) {
  const expanded = fbExpanded.has(d.id);
  const newBadge = d.adminUnread ? '<span class="badge warn">NEW</span> ' : '';
  if (!expanded) {
    return `
      <div class="fb-item collapsed ${d.adminUnread ? 'unread' : ''}" data-id="${d.id}">
        <div class="fb-head">
          <span>${newBadge}<span class="nick">${escapeHtml(d.nickname || '?')}</span></span>
          <span class="sub">${fmtDateTime(d.lastTs || d.ts)}</span>
        </div>
        <div class="fb-preview">${escapeHtml(previewText(d))}</div>
      </div>`;
  }
  return `
    <div class="fb-item ${d.adminUnread ? 'unread' : ''}" data-id="${d.id}">
      <div class="fb-head fb-toggle" style="cursor:pointer;">
        <span>${newBadge}<span class="nick">${escapeHtml(d.nickname || '?')}</span></span>
        <span class="sub">${fmtDateTime(d.lastTs || d.ts)} ▲</span>
      </div>
      ${getMsgs(d).map(m => `
        <div class="fb-msg ${m.from === 'admin' ? 'from-admin' : ''}">
          <span class="bubble">${escapeHtml(m.text)}</span>
        </div>`).join('')}
      <div class="fb-reply-row">
        <textarea class="fb-reply-input" placeholder="답글 작성..." rows="2"></textarea>
        <button class="btn btn-primary btn-sm fb-reply-btn">답글 보내기</button>
      </div>
    </div>`;
}

function renderFeedback() {
  const el = document.getElementById('feedbackList');
  if (!fbRows.length) { setEmpty(el, '문의가 없어요'); return; }
  el.innerHTML = fbRows.map(feedbackItemHtml).join('');
  el.querySelectorAll('.fb-reply-btn').forEach(btn => {
    btn.addEventListener('click', guardBtn(btn, async () => {
      const item = btn.closest('.fb-item');
      const id = item.dataset.id;
      const textarea = item.querySelector('.fb-reply-input');
      const replyText = (textarea.value || '').trim();
      if (!replyText) return;
      try {
        const row = fbRows.find(r => r.id === id);
        const messages = [...getMsgs(row)];
        const ts = Date.now();
        messages.push({ from: 'admin', text: replyText, ts });
        await setDoc(doc(db, 'feedback', id), { messages, lastTs: ts, userUnread: true, adminUnread: false }, { merge: true });
        Object.assign(row, { messages, lastTs: ts, userUnread: true, adminUnread: false });
        renderFeedback();
      } catch (e) {
        alert('답글 전송 실패: ' + humanError(e));
      }
    }));
  });
}

// 카드 펼치기/접기 — 펼치는 순간에만 읽음 처리 (쓰기 1회, 이미 읽은 글은 쓰기 없음)
function toggleFeedback(id) {
  const row = fbRows.find(r => r.id === id);
  if (!row) return;
  if (fbExpanded.has(id)) {
    fbExpanded.delete(id);
  } else {
    fbExpanded.add(id);
    if (row.adminUnread) {
      row.adminUnread = false; // NEW 즉시 제거
      setDoc(doc(db, 'feedback', id), { adminUnread: false }, { merge: true })
        .then(() => loadFeedbackNewBadge()) // 상단 배지 개수도 같이 갱신
        .catch(e => console.warn('읽음 처리 실패:', humanError(e)));
    }
  }
  renderFeedback();
}

async function loadFeedback({ reset = false } = {}) {
  const el = document.getElementById('feedbackList');
  const moreBtn = document.getElementById('feedbackMoreBtn');
  if (reset || !fbPager) {
    // ts = 작성 시각(createdAt) — 최신 작성글이 항상 맨 위
    fbPager = makePager(() => [collection(db, 'feedback'), orderBy('ts', 'desc')], PAGE_SIZE);
    fbRows.length = 0;
    fbExpanded.clear();
  }
  if (!fbRows.length) setLoading(el);
  moreBtn.disabled = true;
  try {
    const page = await fbPager.next();
    fbRows.push(...page);
    renderFeedback();
    moreBtn.style.display = fbPager.done ? 'none' : 'flex';
  } catch (e) {
    setError(el, humanError(e));
  } finally {
    moreBtn.disabled = false;
  }
}

// ── 이번 달 함께해주신 분 (meta/weeklyThanks — 기존과 동일) ──
async function loadThanks({ force = false } = {}) {
  try {
    if (force) cache.bust('operations:thanks');
    const data = await cache.get('operations:thanks', () => fetchDoc(doc(db, 'meta', 'weeklyThanks')));
    document.getElementById('opThanksText').value = (data && data.text) || '';
  } catch (e) {
    resultMsg('opThanksResult', humanError(e), false);
  }
}
async function saveThanks(text) {
  await setDoc(doc(db, 'meta', 'weeklyThanks'), { text, updatedAt: Date.now() });
  cache.set('operations:thanks', { text, updatedAt: Date.now() });
  resultMsg('opThanksResult', text ? '저장됐어요. 랭킹 화면 하단에 표시됩니다.' : '비웠어요. 표시가 숨겨집니다.');
}

// ── 명예의전당 ──
async function loadHall({ force = false } = {}) {
  const el = document.getElementById('hallList');
  setLoading(el);
  try {
    if (force) cache.bust('operations:hall');
    const { champs, current } = await cache.get('operations:hall', async () => ({
      champs: await fetchDocs(query(collection(db, 'champions'), orderBy('count', 'desc'), limit(50))),
      current: await fetchDoc(doc(db, 'meta', 'currentChampion')).catch(() => null),
    }));
    const currentLine = current
      ? `<div class="card-note" style="margin-bottom:6px;">현재 챔피언: <span class="nick">${escapeHtml(current.nickname || '-')}</span> (${fmtDateTime(current.ts)})</div>` : '';
    if (!champs.length) { el.innerHTML = currentLine + '<div class="list-empty">왕관 기록이 없어요</div>'; return; }
    el.innerHTML = currentLine + champs.map((c, i) => `
      <div class="list-row">
        <span class="main">${i < 3 ? ['🥇', '🥈', '🥉'][i] : (i + 1) + '.'} <span class="nick">${escapeHtml(c.id)}</span></span>
        <span class="sub">👑 ${fmtNum(c.count || 0)}회 · ${c.lastCrownedAt ? fmtDateTime(c.lastCrownedAt) : '-'}</span>
      </div>`).join('');
  } catch (e) {
    setError(el, humanError(e));
  }
}
// 명전 횟수 수동 설정 (기존과 동일한 필드)
async function setHallCount(nick, count) {
  await setDoc(doc(db, 'champions', nick), { count, lastCrownedAt: Date.now() }, { merge: true });
  cache.bust('operations:hall');
  resultMsg('hallResult', `'${escapeHtml(nick)}' 명전 횟수를 ${count}회로 설정했습니다.`);
  await loadHall({ force: true });
}
// 현재 1등을 챔피언 메타정보로 동기화 (카운트는 건드리지 않음 — 기존과 동일)
async function syncChampion() {
  const tops = await fetchDocs(query(collection(db, 'rankings'), orderBy('score', 'desc'), limit(1)));
  if (!tops.length) { resultMsg('hallResult', '현재 랭킹에 등록된 사람이 없습니다.', false); return; }
  const topNick = tops[0].id;
  await setDoc(doc(db, 'meta', 'currentChampion'), { nickname: topNick, ts: Date.now() });
  cache.bust('operations:hall');
  resultMsg('hallResult', `현재 챔피언을 '${escapeHtml(topNick)}'(으)로 동기화했습니다. (명전 횟수는 변경되지 않았습니다)`);
  await loadHall({ force: true });
}

// ── 앱 버전 ──
async function loadVersion({ force = false } = {}) {
  const el = document.getElementById('opVersionInfo');
  try {
    if (force) cache.bust('operations:version');
    const v = await cache.get('operations:version', () => fetchDoc(doc(db, 'meta', 'appVersion')));
    el.textContent = v ? `현재 서버 기준 빌드: ${v.build}` : '버전 정보 없음';
  } catch (e) {
    el.textContent = humanError(e);
  }
}

// ── 바인딩 / 로드 ──
export function initOperationsTab() {
  const moreBtn = document.getElementById('feedbackMoreBtn');
  moreBtn.addEventListener('click', () => loadFeedback());

  // 카드 펼치기/접기 위임 — 답글 입력란/버튼 클릭은 토글로 취급하지 않음
  document.getElementById('feedbackList').addEventListener('click', (e) => {
    if (e.target.closest('.fb-reply-row')) return;
    const collapsed = e.target.closest('.fb-item.collapsed');
    if (collapsed) { toggleFeedback(collapsed.dataset.id); return; }
    const head = e.target.closest('.fb-toggle');
    if (head) toggleFeedback(head.closest('.fb-item').dataset.id);
  });

  const saveBtn = document.getElementById('opThanksSaveBtn');
  saveBtn.addEventListener('click', guardBtn(saveBtn, async () => {
    const text = (document.getElementById('opThanksText').value || '').trim();
    if (!text) { resultMsg('opThanksResult', '내용을 입력하거나 "비우기"를 사용하세요.', false); return; }
    try { await saveThanks(text); } catch (e) { resultMsg('opThanksResult', humanError(e), false); }
  }));
  const clearBtn = document.getElementById('opThanksClearBtn');
  clearBtn.addEventListener('click', guardBtn(clearBtn, async () => {
    document.getElementById('opThanksText').value = '';
    try { await saveThanks(''); } catch (e) { resultMsg('opThanksResult', humanError(e), false); }
  }));

  const setBtn = document.getElementById('hallSetBtn');
  setBtn.addEventListener('click', guardBtn(setBtn, async () => {
    const nick = document.getElementById('hallNick').value.trim();
    const countVal = document.getElementById('hallCount').value.trim();
    if (!nick) { resultMsg('hallResult', '닉네임을 입력하세요.', false); return; }
    if (countVal === '' || isNaN(Number(countVal)) || Number(countVal) < 0) { resultMsg('hallResult', '올바른 횟수를 입력하세요.', false); return; }
    try {
      await setHallCount(nick, Math.floor(Number(countVal)));
      document.getElementById('hallNick').value = '';
      document.getElementById('hallCount').value = '';
    } catch (e) { resultMsg('hallResult', humanError(e), false); }
  }));
  const syncBtn = document.getElementById('hallSyncBtn');
  syncBtn.addEventListener('click', guardBtn(syncBtn, async () => {
    try { await syncChampion(); } catch (e) { resultMsg('hallResult', humanError(e), false); }
  }));
}

export async function loadOperations({ force = false } = {}) {
  if (force) fbPager = null;
  await Promise.allSettled([
    loadFeedback({ reset: force }),
    loadThanks({ force }),
    loadHall({ force }),
    loadVersion({ force }),
  ]);
}

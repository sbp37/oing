// ══════════════════════════════════════════════════════════════
//  users.js — 유저 탭
//
//  · 전체 유저를 한 번에 불러오지 않는다.
//    user_stats 를 orderBy + limit(30) + startAfter(커서)로 30명씩,
//    "더 보기" 버튼을 눌렀을 때만 다음 페이지 조회.
//  · 정렬(최근/점수/플레이/시간)별로 페이지를 세션 캐시에 보관 —
//    정렬을 오갔다 와도 재조회하지 않음.
//  · 닉네임 검색은 nickname_lookup 문서 1개 → 관련 문서 직접 조회 (풀스캔 없음)
// ══════════════════════════════════════════════════════════════
import {
  db, collection, doc, orderBy,
  fetchDoc, deleteDoc, makePager, getUserDocByNick, resolveUserDocId,
  getWeekId, getTodayDateStr, fmtAgo, fmtDateTime, fmtDuration, fmtNum, escapeHtml,
  humanError, normalizeNickname,
} from './firebase.js';
import { getTodaySessions } from './stats.js';
import { setLoading, setError, setEmpty, guardBtn, resultMsg } from './admin.js';

const PAGE_SIZE = 30;

// 정렬 모드 → user_stats 필드 (전부 단일 필드 orderBy — 복합 인덱스 불필요)
const SORT_FIELDS = {
  lastPlayed:    { field: 'lastPlayed',    label: v => fmtAgo(v),                 name: '최근 플레이' },
  bestScore:     { field: 'bestScore',     label: v => `${fmtNum(v)}pt`,          name: '최고 점수' },
  playCount:     { field: 'playCount',     label: v => `${fmtNum(v)}판`,          name: '플레이 수' },
  totalPlayTime: { field: 'totalPlayTime', label: v => fmtDuration(v),            name: '누적 시간' },
};

// 정렬별 상태: { pager, rows } — 세션 내 재사용
const listState = {};

function displayName(row) { return row.nickname || row.id; }

function userRowHtml(row, sortKey) {
  const s = SORT_FIELDS[sortKey];
  const val = row[s.field];
  // 계정 미연동(구형 닉네임 문서) 여부는 내부 구분이라 목록에는 표시하지 않는다 — 상세 모달에서만 확인
  return `
    <div class="list-row clickable user-row" data-nick="${escapeHtml(displayName(row))}">
      <span class="main"><span class="nick">${escapeHtml(displayName(row))}</span></span>
      <span class="sub">${s.name} ${val != null ? s.label(val) : '-'} · 최고 ${fmtNum(row.bestScore || 0)}pt · ${fmtNum(row.playCount || 0)}판</span>
    </div>`;
}

function renderList(sortKey) {
  const el = document.getElementById('usersList');
  const st = listState[sortKey];
  if (!st || !st.rows.length) { setEmpty(el, '표시할 유저가 없어요'); return; }
  el.innerHTML = st.rows.map(r => userRowHtml(r, sortKey)).join('');
  const moreBtn = document.getElementById('usersMoreBtn');
  moreBtn.style.display = st.pager.done ? 'none' : 'flex';
}

async function loadPage(sortKey, { reset = false } = {}) {
  const el = document.getElementById('usersList');
  const moreBtn = document.getElementById('usersMoreBtn');
  if (reset || !listState[sortKey]) {
    listState[sortKey] = {
      pager: makePager(() => [collection(db, 'user_stats'), orderBy(SORT_FIELDS[sortKey].field, 'desc')], PAGE_SIZE),
      rows: [],
    };
  }
  const st = listState[sortKey];
  if (!st.rows.length) setLoading(el);
  moreBtn.disabled = true;
  try {
    const page = await st.pager.next();
    st.rows.push(...page);
    renderList(sortKey);
  } catch (e) {
    setError(el, humanError(e));
  } finally {
    moreBtn.disabled = false;
  }
}

// ── 오늘 들어온 유저 = "오늘 접속한 유저" (신규 가입과 별개 개념) ──
// 홈이 이미 받아온 오늘 visit_sessions 캐시를 그대로 재사용 — 추가 Firestore 조회 0.
// ⚠️ 이전 구현은 users.createdAt(=계정 연결 시각)을 "가입"으로 표시해서 기존 유저에게
//    오늘 날짜가 가입일처럼 보였음 — 접속 기록엔 "접속 시각"만 표시한다.
async function loadTodayUsers({ force = false } = {}) {
  const el = document.getElementById('usersTodayList');
  setLoading(el);
  try {
    const sessions = await getTodaySessions({ force });
    // 방문자 단위로 합산 (같은 유저의 여러 세션 → 1행)
    const byVisitor = new Map();
    for (const s of sessions) {
      const key = s.visitorKey || s.sessionId || s.id;
      const prev = byVisitor.get(key) || { nickname: '', lastSeenTs: 0, plays: 0 };
      if (s.nickname) prev.nickname = s.nickname;
      prev.plays += (s.playCount || 0);
      if ((s.lastSeenTs || 0) > prev.lastSeenTs) prev.lastSeenTs = s.lastSeenTs || 0;
      byVisitor.set(key, prev);
    }
    const rows = [...byVisitor.entries()]
      .sort((a, b) => b[1].lastSeenTs - a[1].lastSeenTs)
      .slice(0, 50);
    if (!rows.length) { setEmpty(el, '오늘 접속한 유저가 없어요'); return; }
    el.innerHTML = rows.map(([key, v]) => {
      const isAnon = !v.nickname;
      const name = v.nickname || key; // 익명 방문자는 기기 키로 표시
      return `
      <div class="list-row ${isAnon ? '' : 'clickable user-row'}" ${isAnon ? '' : `data-nick="${escapeHtml(name)}"`}>
        <span class="main"><span class="nick">${escapeHtml(name)}</span>${isAnon ? ' <span class="badge">익명 방문</span>' : ''}</span>
        <span class="sub">접속 ${fmtDateTime(v.lastSeenTs)} · ${v.plays}판</span>
      </div>`;
    }).join('') + (byVisitor.size > 50 ? `<div class="card-note">외 ${byVisitor.size - 50}명 (최근 접속순 50명까지 표시)</div>` : '');
  } catch (e) {
    setError(el, humanError(e));
  }
}

// ── 닉네임 검색 — 풀스캔 없이 문서 직접 조회 ──
async function searchUser(nick) {
  const el = document.getElementById('userSearchResult');
  const norm = normalizeNickname(nick);
  if (!norm) { el.innerHTML = ''; return; }
  setLoading(el, '검색 중...');
  try {
    const { uid, docId } = await resolveUserDocId(nick);
    const [stats, rank] = await Promise.all([
      getUserDocByNick('user_stats', nick).then(r => r.data),
      fetchDoc(doc(db, 'rankings', nick)),
    ]);
    if (!stats && !rank && !uid) { setEmpty(el, `'${escapeHtml(nick)}' 기록을 찾지 못했어요 (정확한 닉네임인지 확인)`); return; }
    el.innerHTML = `
      <div class="list-row clickable user-row" data-nick="${escapeHtml(nick)}">
        <span class="main"><span class="nick">${escapeHtml(nick)}</span>
          ${uid ? '<span class="badge green">계정 연동</span>' : '<span class="badge">계정 미연동</span>'}</span>
        <span class="sub">전체 ${fmtNum(rank?.score ?? '-')}pt · ${fmtNum(stats?.playCount || 0)}판 · 상세 보기 →</span>
      </div>`;
  } catch (e) {
    setError(el, humanError(e));
  }
}

// ── 유저 상세 모달 ──
async function openUserDetail(nick) {
  const modal = document.getElementById('userModal');
  const body = document.getElementById('userModalBody');
  document.getElementById('userModalTitle').textContent = `👤 ${nick}`;
  modal.style.display = 'flex';
  setLoading(body, '상세 정보 불러오는 중...');
  try {
    const weekId = getWeekId();
    const { uid } = await resolveUserDocId(nick);
    const [stats, rank, weekScore, skins, userDoc, renameHist] = await Promise.all([
      getUserDocByNick('user_stats', nick).then(r => r.data),
      fetchDoc(doc(db, 'rankings', nick)),
      fetchDoc(doc(db, 'weekly_rankings', weekId, 'scores', nick)),
      getUserDocByNick('nickname_skins', nick).then(r => r.data),
      uid ? fetchDoc(doc(db, 'users', uid)) : Promise.resolve(null),
      // 닉네임 변경 이력 — rename_history/{uid} (서버 함수 기록, 어드민만 read)
      uid ? fetchDoc(doc(db, 'rename_history', uid)).catch(() => null) : Promise.resolve(null),
    ]);
    // 이전 닉네임 목록: "구닉 (2026.07.10까지)" 형태, 최근 변경이 앞에 오게
    const prevNicks = (renameHist && Array.isArray(renameHist.previousNicknames))
      ? renameHist.previousNicknames.slice().reverse()
        .map(p => `${escapeHtml(p.nickname || '?')}${p.renamedAt ? ` (${fmtDateTime(p.renamedAt.toMillis ? p.renamedAt.toMillis() : p.renamedAt).split(' ')[0]}까지)` : ''}`)
        .join(' ← ')
      : null;
    const kv = (k, v) => `<div class="kv"><span class="k">${k}</span><span class="v">${v ?? '-'}</span></div>`;
    body.innerHTML = `
      ${kv('계정 연동', uid ? `연동됨 (${uid.slice(0, 8)}…)` : '미연동 (이전 방식 데이터)')}
      ${prevNicks ? kv('🏷️ 이전 닉네임', prevNicks) : ''}
      ${kv('첫 플레이 (가입)', stats?.firstPlayed ? fmtDateTime(stats.firstPlayed) : '가입일 미상')}
      ${kv('계정 연결일', userDoc?.createdAt ? fmtDateTime(userDoc.createdAt) : '-')}
      ${kv('마지막 접속', userDoc?.lastSeenAt ? fmtAgo(userDoc.lastSeenAt) : (stats?.lastPlayed ? fmtAgo(stats.lastPlayed) : '-'))}
      ${kv('전체 랭킹 점수', rank ? fmtNum(rank.score) + 'pt' : '없음')}
      ${kv(`이번주(${weekId}) 점수`, weekScore ? fmtNum(weekScore.score) + 'pt' : '없음')}
      ${kv('최고 점수', fmtNum(stats?.bestScore ?? '-'))}
      ${kv('총 플레이', `${fmtNum(stats?.playCount || 0)}판 · ${fmtDuration(stats?.totalPlayTime || 0)}`)}
      ${kv('오늘 플레이', stats?.dailyDate === getTodayDateStr() ? `${stats.dailyPlayCount || 0}판` : '0판')}
      ${kv('연속 출석', `${stats?.streak || 0}일`)}
      ${kv('최고 콤보', fmtNum(stats?.bestCombo ?? '-'))}
      ${kv('젤리', `${fmtNum(stats?.jelly || 0)}개`)}
      ${kv('유입 경로', escapeHtml(stats?.referrerSrc || '-'))}
      ${kv('추천인', escapeHtml(stats?.refBy || '-'))}
      ${kv('고양이 스킨', skins?.cat ? '보유 😻' : '없음')}
      ${kv('최근 점수', (stats?.recentScores || []).slice(-5).join(', ') || '-')}
      <button id="userModalDeleteRank" class="btn btn-danger btn-block">🗑️ 이 유저 랭킹 기록 삭제</button>
      <div id="userModalResult"></div>`;
    const delBtn = document.getElementById('userModalDeleteRank');
    delBtn.addEventListener('click', guardBtn(delBtn, () => deleteRankingRecord(nick, 'userModalResult')));
  } catch (e) {
    setError(body, humanError(e));
  }
}

// 랭킹 기록 삭제 (보안 탭과 공용) — 전체 + 이번주 점수 삭제, 계정/스킨은 유지
export async function deleteRankingRecord(nick, resultElId) {
  const ok = confirm(`'${nick}' 의 랭킹 기록(전체 + 이번주)을 삭제할까요?\n계정/스킨/젤리는 유지됩니다.\n이 작업은 되돌릴 수 없습니다.`);
  if (!ok) return false;
  try {
    await deleteDoc(doc(db, 'rankings', nick));
    await deleteDoc(doc(db, 'weekly_rankings', getWeekId(), 'scores', nick)).catch(() => {});
    resultMsg(resultElId, `'${escapeHtml(nick)}' 랭킹 기록을 삭제했어요.`);
    return true;
  } catch (e) {
    resultMsg(resultElId, humanError(e), false);
    return false;
  }
}

// ── 탭 바인딩 (조회 없음) / 로드 ──
export function initUsersTab() {
  document.getElementById('userSortSel').addEventListener('change', (e) => {
    const sortKey = e.target.value;
    if (listState[sortKey]) renderList(sortKey);   // 이미 받아온 정렬은 재조회 없이 표시
    else loadPage(sortKey);
  });
  const moreBtn = document.getElementById('usersMoreBtn');
  moreBtn.addEventListener('click', guardBtn(moreBtn, () => loadPage(document.getElementById('userSortSel').value)));

  const searchBtn = document.getElementById('userSearchBtn');
  const searchInput = document.getElementById('userSearchInput');
  searchBtn.addEventListener('click', guardBtn(searchBtn, () => searchUser(searchInput.value.trim())));
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });

  // 유저 행 클릭 → 상세 모달 (이벤트 위임)
  document.getElementById('tab-users').addEventListener('click', (e) => {
    const row = e.target.closest('.user-row');
    if (row && row.dataset.nick) openUserDetail(row.dataset.nick);
  });
  document.getElementById('userModalClose').addEventListener('click', () => {
    document.getElementById('userModal').style.display = 'none';
  });
  document.getElementById('userModal').addEventListener('click', (e) => {
    if (e.target.id === 'userModal') e.target.style.display = 'none';
  });
}

export async function loadUsers({ force = false } = {}) {
  if (force) {
    for (const k of Object.keys(listState)) delete listState[k];
  }
  const sortKey = document.getElementById('userSortSel').value;
  await Promise.allSettled([
    loadTodayUsers({ force }),
    listState[sortKey] ? Promise.resolve(renderList(sortKey)) : loadPage(sortKey, { reset: force }),
  ]);
}

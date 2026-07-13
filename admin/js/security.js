// ══════════════════════════════════════════════════════════════
//  security.js — 보안 / 기록 관리 탭
//
//  · 이 탭은 열어도 자동 조회가 없다 (버튼을 눌러야만 조회).
//  · 초기화 로직/다단계 확인창은 기존 관리자(setupAdminReset)와 동일하게 이식.
//    추가 안전장치: 삭제 전에 JSON 백업이 자동으로 다운로드된다.
// ══════════════════════════════════════════════════════════════
import {
  db, collection, doc, query, where, orderBy, limit,
  fetchDocs, fetchDoc, deleteDoc, getUserDocByNick,
  getWeekId, fmtNum, fmtDateTime, escapeHtml, downloadJSON, humanError,
  getTodayDateStr, cache, fns, httpsCallable,
} from './firebase.js';
import { setLoading, setError, setEmpty, guardBtn, resultMsg } from './admin.js';
import { deleteRankingRecord } from './users.js';

// ── 🛟 점수 누락 복구 ──
// 오늘 실제 플레이했지만 랭킹에 반영 안 된 후보를 찾아, 관리자 버튼으로 서버 복구 함수를 호출.
// 실제 복구 판정(관리자 확인·5만 미만·현재보다 높을 때만·감사 로그)은 전부 서버(adminRecoverScore).
// 여기서는 후보 표시와 서버 호출만 한다. user_stats.bestScore(전체 최고점)가 아니라
// "오늘 실제 점수"만 대상 — recentScores 뒤 dailyPlayCount개의 최댓값(서버 로직과 동일).
const RECOVER_SCORE_MAX = 50000;
function todaysBestScoreClient(s, today) {
  if (!s) return 0;
  if (s.lastPlayDate !== today && s.dailyDate !== today) return 0;
  const recent = Array.isArray(s.recentScores) ? s.recentScores.filter(x => Number.isInteger(x) && x >= 0) : [];
  if (!recent.length) return (Number.isInteger(s.lastScore) && s.lastScore > 0) ? s.lastScore : 0;
  const dpc = (Number.isInteger(s.dailyPlayCount) && s.dailyPlayCount > 0) ? s.dailyPlayCount : recent.length;
  const n = Math.max(1, Math.min(dpc, recent.length));
  return Math.max(...recent.slice(-n));
}

async function scanRecoverCandidates() {
  const el = document.getElementById('recoverResult');
  setLoading(el, '오늘 플레이한 유저를 확인하는 중...');
  try {
    const today = getTodayDateStr();
    const weekId = getWeekId();
    // 오늘 플레이한 user_stats만 (단일 필드 equality — 자동 인덱스)
    const players = await fetchDocs(query(collection(db, 'user_stats'), where('lastPlayDate', '==', today)));
    if (!players.length) { setEmpty(el, '오늘 플레이한 유저가 없어요'); return; }

    // 이번주 주간 랭킹 점수 맵 (한 번에)
    const weekRows = await fetchDocs(query(collection(db, 'weekly_rankings', weekId, 'scores')));
    const weekMap = new Map(weekRows.map(r => [r.id, r.score || 0]));

    // 후보: 오늘 실제 점수가 있고(0<score<5만), 현재 주간 점수보다 높은 유저
    const cands = [];
    for (const p of players) {
      const nick = p.nickname || p.id;
      if (!nick) continue;
      const todaysBest = todaysBestScoreClient(p, today);
      if (!Number.isInteger(todaysBest) || todaysBest <= 0) continue;
      if (todaysBest >= RECOVER_SCORE_MAX) continue; // 5만 이상은 복구 대상 아님
      const curWeek = weekMap.get(nick) || 0;
      if (todaysBest <= curWeek) continue;           // 이미 주간에 반영됨
      cands.push({ nick, todaysBest, curWeek });
    }
    if (!cands.length) {
      el.innerHTML = `<div class="list-empty">✅ 오늘 플레이한 ${players.length}명 확인 — 누락 후보가 없어요</div>`;
      return;
    }

    // 각 후보의 현재 전체 랭킹 점수 (표시용)
    await Promise.all(cands.map(async c => {
      const rk = await fetchDoc(doc(db, 'rankings', c.nick)).catch(() => null);
      c.curRank = (rk && typeof rk.score === 'number') ? rk.score : 0;
    }));
    cands.sort((a, b) => b.todaysBest - a.todaysBest);

    el.innerHTML = `
      <div class="card-note" style="margin-bottom:8px;">${cands.length}명 발견 — 자동 복구는 없어요. 확인 후 "복구하기"를 눌러주세요. (복구 점수 = 오늘 실제 최고점)</div>
      <div class="list">${cands.map(c => `
        <div class="list-row" data-nick="${escapeHtml(c.nick)}">
          <span class="main">
            <span class="nick">${escapeHtml(c.nick)}</span> <span class="badge warn">복구 ${fmtNum(c.todaysBest)}pt</span><br>
            <span class="sub">현재 전체 ${fmtNum(c.curRank)} · 현재 주간 ${fmtNum(c.curWeek)}</span>
          </span>
          <button class="btn btn-primary btn-sm recover-btn" data-nick="${escapeHtml(c.nick)}">복구하기</button>
        </div>`).join('')}
      </div>`;
    el.querySelectorAll('.recover-btn').forEach(btn => {
      btn.addEventListener('click', guardBtn(btn, () => recoverOne(btn.dataset.nick, btn)));
    });
  } catch (e) {
    setError(el, humanError(e));
  }
}

async function recoverOne(nick, btn) {
  const row = btn.closest('.list-row');
  const sub = row ? row.querySelector('.sub') : null;
  try {
    const res = await httpsCallable(fns, 'adminRecoverScore')({ nickname: nick });
    const d = (res && res.data) || {};
    const parts = [];
    if (d.rankingUpdated) parts.push(`전체 ${fmtNum(d.prevRank)}→${fmtNum(d.recoverScore)}`);
    if (d.weeklyUpdated) parts.push(`주간 ${fmtNum(d.prevWeek)}→${fmtNum(d.recoverScore)}`);
    const summary = parts.length ? parts.join(' · ') : '이미 현재 점수가 더 높아 변경 없음';
    if (sub) sub.innerHTML = `✅ 복구됨 — ${escapeHtml(summary)}`;
    btn.textContent = '완료';
    btn.disabled = true;
    btn.classList.remove('btn-primary'); btn.classList.add('btn-ghost');
  } catch (e) {
    const msg = humanError(e);
    if (sub) sub.innerHTML = `<span style="color:var(--danger,#e33);">복구 실패 — ${escapeHtml(msg)}</span>`;
    // 버튼은 다시 누를 수 있게 유지
  }
}

// ── 🔑 핀번호 재설정 (분실/기기 이어하기 실패 지원) ──
// 실제 재설정(어드민 확인·해시 교체·감사 기록)은 전부 서버(adminResetPin). 여기서는
// 새 PIN을 클라이언트에서 무작위로 뽑아 넘기고 결과만 표시한다 — 서버는 원문을 저장/반환하지 않음.
async function resetPin() {
  const nickEl = document.getElementById('pinResetNickInput');
  const nick = (nickEl.value || '').trim();
  const el = document.getElementById('pinResetResult');
  if (!nick) { resultMsg('pinResetResult', '닉네임을 입력하세요.', false); return; }
  const customEl = document.getElementById('pinResetCustomInput');
  const custom = (customEl && customEl.value || '').trim();
  if (custom && !/^\d{4}$/.test(custom)) { resultMsg('pinResetResult', '직접입력 PIN은 숫자 4자리여야 해요.', false); return; }
  const newPin = custom || String(Math.floor(1000 + Math.random() * 9000));
  setLoading(el, `${nick}의 새 PIN 발급 중...`);
  try {
    const res = await httpsCallable(fns, 'adminResetPin')({ nickname: nick, newPin });
    const d = (res && res.data) || {};
    el.innerHTML = `<div class="list-empty">✅ 새 PIN 발급 완료 (${d.mode === 'legacy' ? '레거시 닉네임' : 'UID 계정'}) — <b style="font-size:1.3em; letter-spacing:2px;">${escapeHtml(newPin)}</b><br><span class="sub">이 PIN을 "${escapeHtml(nick)}" 본인에게 직접 전달해주세요. 랭킹탭 "계정 연결"에서 바로 쓸 수 있어요.</span></div>`;
  } catch (e) {
    setError(el, humanError(e));
  }
}

// ── 🚨 서버 자동 판정 알림 (game_sessions, 읽기 전용) ──
// 대시보드는 이 컬렉션을 절대 수정/삭제하지 않는다 (규칙상 write도 Cloud Function만 가능).
// 문서는 30일 TTL(expireAt)로 서버가 알아서 지우므로 별도 보관 로직 없음.
const VERDICT_DECISIONS = ['pending_review', 'rejected_invalid'];
const REASON_LABELS = {
  ELAPSED_TOO_SHORT: '30초 미만 즉시클리어',
  SCORE_OVER_OFFICIAL_CAP: '점수 상한 초과(5만+)',
  IMPOSSIBLE_BURST: '비정상 폭발 성공(버스트)',
  COMPOSITE_ANOMALY: '복합 이상패턴',
  NO_SESSION: '서버세션 없음',
  OWNERSHIP: '남의 닉네임 문서 시도',
};
function reasonLabel(code) { return REASON_LABELS[code] || code; }

// NO_SESSION(서버세션 없음)은 치팅 의심 신호가 아니라 "검증 불가" 상태다.
// (예: startSession 호출이 인프라 문제로 실패한 정상 유저도 이 사유로 찍힘 — 2026-07-12
//  Cloud Run IAM 권한 누락 사고로 다수 정상 유저가 이 사유로 몰린 바 있음.)
// 의심 판정 집계·배지에서는 제외하고, 목록에서는 별도 섹션(회색 "검증 불가")으로 분리 표시한다.
const isUnverifiable = (d) => Array.isArray(d.official?.reasons) && d.official.reasons.includes('NO_SESSION');

// "확인함" 상태는 어드민 브라우저(localStorage)에만 저장한다 — 백엔드/규칙 무변경.
// 목록이 길어 정신없다는 피드백 → 아직 안 본 의심만 기본 표시하고, 이미 본 것/검증불가는
// 토글로 접어둔다. game_sessions 문서 id 기준(30일 TTL로 문서가 사라지므로 무한증가 없음).
const SEEN_KEY = 'oeing_admin_seen_verdicts';
function loadSeenIds() {
  try { const a = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); return new Set(Array.isArray(a) ? a : []); }
  catch { return new Set(); }
}
function markSeen(ids) {
  const cur = loadSeenIds();
  ids.forEach(id => cur.add(id));
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...cur].slice(-500))); } catch {}
}
function syncBadge(unseenCount) {
  const badge = document.getElementById('verdictBadge');
  const countEl = document.getElementById('verdictBadgeCount');
  if (!badge || !countEl) return;
  if (unseenCount > 0) { countEl.textContent = unseenCount >= 50 ? '50+' : String(unseenCount); badge.style.display = ''; }
  else badge.style.display = 'none';
}

// game_sessions에서 보류/거부 세션 최근 50건 (복합 인덱스 필요 — 첫 실행 시 콘솔 링크로 생성)
function verdictQuery() {
  return query(
    collection(db, 'game_sessions'),
    where('official.decision', 'in', VERDICT_DECISIONS),
    orderBy('official.decidedAt', 'desc'),
    limit(50),
  );
}

// 상단 배지 — 관리자 진입 시 1회만 이 count를 위해 조회 (의심 세션 즉시 인지가 목적).
// 결과는 세션 캐시에 담아 보안 탭이 그대로 재사용 → 탭 진입 시 추가 조회 0.
export async function loadVerdictBadge() {
  const badge = document.getElementById('verdictBadge');
  const countEl = document.getElementById('verdictBadgeCount');
  try {
    const rows = await cache.get('security:verdicts', () => fetchDocs(verdictQuery()));
    const seen = loadSeenIds();
    const n = rows.filter(d => !isUnverifiable(d) && !seen.has(d.id)).length; // 안 본 의심만
    if (n > 0 && badge && countEl) {
      countEl.textContent = n >= 50 ? '50+' : String(n);
      badge.style.display = '';
    } else if (badge) {
      badge.style.display = 'none';
    }
    return rows;
  } catch (e) {
    // 인덱스 미생성/권한 문제여도 관리자 진입 자체는 막지 않는다 (조용히 숨김)
    console.warn('의심 판정 배지 로드 실패(무해):', e && (e.code || e.message));
    if (badge) badge.style.display = 'none';
    return null;
  }
}

function verdictRowHtml(d) {
  const dec = d.official?.decision;
  const unverifiable = isUnverifiable(d);
  const rejected = dec === 'rejected_invalid';
  const cls = unverifiable ? 'unverifiable' : (rejected ? 'rejected' : 'pending');
  const verdictText = unverifiable ? '검증 불가' : (rejected ? '거부' : '보류');
  const reasons = Array.isArray(d.official?.reasons) ? d.official.reasons : [];
  const elapsedSec = typeof d.serverElapsed === 'number' ? Math.round(d.serverElapsed / 1000) : null;
  const burst = d.client?.maxSuccessesIn3Sec;
  return `
    <div class="verdict-row ${cls}">
      <span class="vr-main">
        <span class="nick">${escapeHtml(d.nickname || d.uid || '?')}</span>
        · ${fmtNum(d.client?.finalScore ?? '-')}점
        <span class="vr-reasons">${reasons.map(r => `<span class="verdict-tag ${cls}">${escapeHtml(reasonLabel(r))}</span>`).join('')}</span>
        <span class="vr-sub">플레이 ${elapsedSec != null ? elapsedSec + '초' : '-'}${burst != null ? ` · 3초내 최대 ${fmtNum(burst)}성공` : ''} · ${d.official?.decidedAt ? fmtDateTime(d.official.decidedAt) : '-'}</span>
      </span>
      <span class="vr-verdict ${cls}">${verdictText}</span>
    </div>`;
}

async function loadVerdicts({ force = false } = {}) {
  const el = document.getElementById('verdictList');
  const seenListEl = document.getElementById('verdictSeenList');
  const seenToggle = document.getElementById('verdictSeenToggle');
  const ackBtn = document.getElementById('verdictAckBtn');
  if (force) cache.bust('security:verdicts');
  setLoading(el);
  try {
    const rows = await cache.get('security:verdicts', () => fetchDocs(verdictQuery()));
    const seen = loadSeenIds();
    const suspects = rows.filter(d => !isUnverifiable(d));
    const unverifiable = rows.filter(isUnverifiable);
    const newSuspects = suspects.filter(d => !seen.has(d.id));  // 아직 안 본 의심 → 메인
    const seenSuspects = suspects.filter(d => seen.has(d.id));  // 이미 본 의심 → 토글로
    const folded = [...seenSuspects, ...unverifiable];          // 접어둘 것(본 의심 + 검증불가)

    syncBadge(newSuspects.length);
    if (ackBtn) ackBtn.style.display = newSuspects.length ? '' : 'none';

    // 메인: 새(안 본) 의심만. 없으면 칸을 비운다(정신없지 않게).
    el.innerHTML = newSuspects.length
      ? newSuspects.map(verdictRowHtml).join('')
      : `<div class="list-empty">✅ 새 의심 판정 없음</div>`;

    // 토글: 이미 확인한 의심 + 검증불가 — 기본 접힘
    if (seenToggle && seenListEl) {
      if (folded.length) {
        seenToggle.style.display = '';
        seenToggle.dataset.count = String(folded.length);
        seenToggle.dataset.open = '0';
        seenToggle.textContent = `이미 확인한 항목 보기 (${folded.length})`;
        seenListEl.style.display = 'none';
        seenListEl.innerHTML =
          (seenSuspects.length ? seenSuspects.map(verdictRowHtml).join('') : '') +
          (unverifiable.length
            ? `<div class="card-note" style="margin:10px 0 6px;">❔ 검증 불가 (서버세션 없음) — 치팅 의심이 아니라 서버세션이 생성되지 않아 판정을 확정할 수 없는 기록입니다.</div>
               ${unverifiable.map(verdictRowHtml).join('')}`
            : '');
      } else {
        seenToggle.style.display = 'none';
        seenListEl.style.display = 'none';
        seenListEl.innerHTML = '';
      }
    }
  } catch (e) {
    const msg = humanError(e);
    // 인덱스 미생성 시 Firestore가 주는 콘솔 에러 안내
    const extra = /index/i.test(String(e && (e.code || e.message)))
      ? '<br><span style="color:var(--muted);font-size:11.5px;">※ 처음 실행이면 브라우저 콘솔(F12)에 뜬 "인덱스 생성" 링크를 한 번 클릭해 인덱스를 만들어주세요.</span>' : '';
    setError(el, msg + extra);
  }
}

// "모두 확인" — 현재 안 본 의심을 전부 확인 처리 → 배지 사라지고 목록은 접힘으로 이동.
async function ackAllVerdicts() {
  const rows = cache.peek('security:verdicts') || [];
  const seen = loadSeenIds();
  const newIds = rows.filter(d => !isUnverifiable(d) && !seen.has(d.id)).map(d => d.id);
  markSeen(newIds);
  await loadVerdicts();
}

// ── 의심 기록 탐지 — 버튼 클릭 시에만 실행 ──
// 상위 랭킹 100명을 읽고, 상위 20명은 user_stats/주간 점수와 교차 검증
const SUSPECT_SCAN_TOP = 100;
const SUSPECT_DEEP_TOP = 20;

async function scanSuspects() {
  const el = document.getElementById('suspectResult');
  setLoading(el, `상위 ${SUSPECT_SCAN_TOP}명 검사 중...`);
  try {
    const tops = await fetchDocs(query(collection(db, 'rankings'), orderBy('score', 'desc'), limit(SUSPECT_SCAN_TOP)));
    if (!tops.length) { setEmpty(el, '랭킹에 등록된 기록이 없어요'); return; }

    const scores = tops.map(t => t.score || 0);
    const median = scores[Math.floor(scores.length / 2)] || 0;
    const findings = [];

    // ① 통계적 이상치 — 중앙값의 10배 초과 or 1위가 2위의 3배 초과
    tops.forEach((t, i) => {
      const reasons = [];
      if (median > 0 && t.score > median * 10) reasons.push(`중앙값(${fmtNum(median)})의 10배 초과`);
      if (i === 0 && tops[1] && tops[1].score > 0 && t.score > tops[1].score * 3) reasons.push('2위의 3배 초과');
      if (reasons.length) findings.push({ nick: t.id, score: t.score, reasons });
    });

    // ② 상위권 교차 검증 — 플레이 이력 대비 점수 (문서 직접 조회, 풀스캔 없음)
    const weekId = getWeekId();
    for (const t of tops.slice(0, SUSPECT_DEEP_TOP)) {
      const reasons = [];
      const [stats, weekDoc] = await Promise.all([
        getUserDocByNick('user_stats', t.id).then(r => r.data).catch(() => null),
        fetchDoc(doc(db, 'weekly_rankings', weekId, 'scores', t.id)).catch(() => null),
      ]);
      if (!stats) reasons.push('플레이 통계(user_stats) 없음 — 점수만 존재');
      else {
        if ((stats.bestScore || 0) < (t.score || 0)) reasons.push(`통계상 최고점(${fmtNum(stats.bestScore || 0)}) < 랭킹 점수`);
        if ((stats.playCount || 0) <= 2 && (t.score || 0) > median * 3) reasons.push(`플레이 ${stats.playCount || 0}판인데 고득점`);
      }
      if (weekDoc && (weekDoc.score || 0) > (t.score || 0)) reasons.push('주간 점수 > 전체 점수 (불일치)');
      if (reasons.length) {
        const prev = findings.find(f => f.nick === t.id);
        if (prev) prev.reasons.push(...reasons);
        else findings.push({ nick: t.id, score: t.score, reasons });
      }
    }

    if (!findings.length) {
      el.innerHTML = `<div class="list-empty">✅ 상위 ${tops.length}명 검사 완료 — 의심 기록이 없어요 (중앙값 ${fmtNum(median)}pt)</div>`;
      return;
    }
    el.innerHTML = `
      <div class="card-note" style="margin-bottom:8px;">상위 ${tops.length}명 중 ${findings.length}건 의심 — 자동 삭제는 하지 않아요. 확인 후 직접 삭제하세요.</div>
      <div class="list">${findings.map(f => `
        <div class="list-row">
          <span class="main"><span class="nick">${escapeHtml(f.nick)}</span> <span class="badge warn">${fmtNum(f.score)}pt</span><br>
            <span class="sub">${f.reasons.map(escapeHtml).join(' · ')}</span></span>
          <button class="btn btn-danger btn-sm suspect-del" data-nick="${escapeHtml(f.nick)}">삭제</button>
        </div>`).join('')}
      </div>`;
    el.querySelectorAll('.suspect-del').forEach(btn => {
      btn.addEventListener('click', guardBtn(btn, async () => {
        const done = await deleteRankingRecord(btn.dataset.nick, 'secDeleteResult');
        if (done) btn.closest('.list-row').remove();
      }));
    });
  } catch (e) {
    setError(el, humanError(e));
  }
}

// ── 백업 — 컬렉션을 JSON 파일로 다운로드 ──
const BACKUP_SOURCES = {
  rankings:   () => fetchDocs(query(collection(db, 'rankings'))),
  weekly:     () => fetchDocs(query(collection(db, 'weekly_rankings', getWeekId(), 'scores'))),
  champions:  () => fetchDocs(query(collection(db, 'champions'))),
  user_stats: () => fetchDocs(query(collection(db, 'user_stats'))),
};
async function backup(kind) {
  const rows = await BACKUP_SOURCES[kind]();
  const clean = rows.map(({ _snap, ...rest }) => rest);
  downloadJSON(`oing-backup-${kind}-${getTodayDateStr()}.json`, { kind, exportedAt: new Date().toISOString(), count: clean.length, docs: clean });
  return clean.length;
}

// ── 초기화 3종 — 기존 setupAdminReset 로직/문구 그대로 + 사전 자동 백업 ──
async function resetAll() {
  const ok = confirm('정말 점수 랭킹을 전체 초기화할까요?\n이 작업은 되돌릴 수 없습니다.');
  if (!ok) return;
  const wipeCrowns = confirm('👑 왕관(명예의전당) 기록도 같이 초기화할까요?\n"확인" = 왕관까지 완전 초기화\n"취소" = 왕관 기록은 유지');
  const ok2 = confirm('마지막 확인입니다.\n모든 유저의 점수가 0부터 다시 시작됩니다.' + (wipeCrowns ? '\n👑 왕관 기록도 함께 삭제됩니다.' : '') + '\n진행할까요?');
  if (!ok2) return;

  resultMsg('resetResult', '백업 다운로드 중...');
  try {
    // 안전장치: 삭제 전 자동 백업
    await backup('rankings');
    await backup('user_stats');
    if (wipeCrowns) await backup('champions');

    const rankSnap = await fetchDocs(query(collection(db, 'rankings')));
    for (const d of rankSnap) await deleteDoc(doc(db, 'rankings', d.id));

    const statsSnap = await fetchDocs(query(collection(db, 'user_stats')));
    for (const d of statsSnap) await deleteDoc(doc(db, 'user_stats', d.id));

    // 순위변동 비교용 스냅샷도 같이 지움 — 안 지우면 리셋 후 새 순위가
    // 리셋 전 옛날 스냅샷과 비교돼 말도 안 되는 변동폭(▲23 등)이 뜨게 됨
    await deleteDoc(doc(db, 'meta', 'rankSnapshot')).catch(() => {});

    let crownMsg = '(명예의전당/👑 기록은 그대로 유지)';
    if (wipeCrowns) {
      const champSnap = await fetchDocs(query(collection(db, 'champions')));
      for (const d of champSnap) await deleteDoc(doc(db, 'champions', d.id));
      await deleteDoc(doc(db, 'meta', 'currentChampion')).catch(() => {});
      await deleteDoc(doc(db, 'meta', 'weeklyCrownState')).catch(() => {});
      crownMsg = `👑 왕관 기록 ${champSnap.length}개도 함께 삭제됨`;
    }
    resultMsg('resetResult', `완료! rankings ${rankSnap.length}개, user_stats ${statsSnap.length}개 삭제됨. ${crownMsg}`);
  } catch (e) {
    resultMsg('resetResult', '초기화 중 오류: ' + humanError(e), false);
  }
}

async function resetWeek() {
  const weekId = getWeekId();
  const ok = confirm(`이번주(${weekId}) 랭킹만 초기화할까요?\n전체 랭킹은 그대로 유지됩니다.\n이 작업은 되돌릴 수 없습니다.`);
  if (!ok) return;
  const ok2 = confirm('마지막 확인입니다.\n이번주 랭킹이 전부 삭제되고 0부터 다시 시작됩니다.\n진행할까요?');
  if (!ok2) return;
  resultMsg('resetResult', '백업 다운로드 중...');
  try {
    await backup('weekly');
    const weekSnap = await fetchDocs(query(collection(db, 'weekly_rankings', weekId, 'scores')));
    for (const d of weekSnap) await deleteDoc(doc(db, 'weekly_rankings', weekId, 'scores', d.id));
    // 주간 순위변동 비교용 스냅샷도 같이 지움
    await deleteDoc(doc(db, 'meta', 'weeklyRankSnapshot')).catch(() => {});
    resultMsg('resetResult', `완료! 이번주(${weekId}) 랭킹 ${weekSnap.length}개 삭제됨.`);
  } catch (e) {
    resultMsg('resetResult', '초기화 중 오류: ' + humanError(e), false);
  }
}

async function resetCrown() {
  const ok = confirm('👑 왕관(명예의전당) 기록만 초기화할까요?\n점수 랭킹(전체/이번주)은 전혀 안 건드립니다.\n이 작업은 되돌릴 수 없습니다.');
  if (!ok) return;
  const ok2 = confirm('마지막 확인입니다.\n모든 왕관 기록이 삭제됩니다.\n진행할까요?');
  if (!ok2) return;
  resultMsg('resetResult', '백업 다운로드 중...');
  try {
    await backup('champions');
    const champSnap = await fetchDocs(query(collection(db, 'champions')));
    for (const d of champSnap) await deleteDoc(doc(db, 'champions', d.id));
    await deleteDoc(doc(db, 'meta', 'currentChampion')).catch(() => {});
    await deleteDoc(doc(db, 'meta', 'weeklyCrownState')).catch(() => {});
    resultMsg('resetResult', `완료! 왕관 기록 ${champSnap.length}개 삭제됨.`);
  } catch (e) {
    resultMsg('resetResult', '초기화 중 오류: ' + humanError(e), false);
  }
}

// ── 바인딩 / 로드 ──
export function initSecurityTab() {
  const scanBtn = document.getElementById('suspectScanBtn');
  scanBtn.addEventListener('click', guardBtn(scanBtn, scanSuspects));

  const recoverBtn = document.getElementById('recoverScanBtn');
  if (recoverBtn) recoverBtn.addEventListener('click', guardBtn(recoverBtn, scanRecoverCandidates));

  const pinResetBtn = document.getElementById('pinResetBtn');
  if (pinResetBtn) pinResetBtn.addEventListener('click', guardBtn(pinResetBtn, resetPin));

  const delBtn = document.getElementById('secDeleteBtn');
  delBtn.addEventListener('click', guardBtn(delBtn, async () => {
    const nick = document.getElementById('secDeleteNick').value.trim();
    if (!nick) { resultMsg('secDeleteResult', '닉네임을 입력하세요.', false); return; }
    const done = await deleteRankingRecord(nick, 'secDeleteResult');
    if (done) document.getElementById('secDeleteNick').value = '';
  }));

  document.querySelectorAll('.backup-btn').forEach(btn => {
    btn.addEventListener('click', guardBtn(btn, async () => {
      resultMsg('backupResult', '백업 조회 중... (전체 문서를 읽으므로 필요할 때만 사용)');
      try {
        const n = await backup(btn.dataset.backup);
        resultMsg('backupResult', `✅ ${btn.dataset.backup} ${fmtNum(n)}건 다운로드 완료`);
      } catch (e) {
        resultMsg('backupResult', humanError(e), false);
      }
    }));
  });

  const allBtn = document.getElementById('resetAllBtn');
  allBtn.addEventListener('click', guardBtn(allBtn, resetAll));
  const weekBtn = document.getElementById('resetWeekBtn');
  weekBtn.addEventListener('click', guardBtn(weekBtn, resetWeek));
  const crownBtn = document.getElementById('resetCrownBtn');
  crownBtn.addEventListener('click', guardBtn(crownBtn, resetCrown));

  const verdictBtn = document.getElementById('verdictRefreshBtn');
  verdictBtn.addEventListener('click', guardBtn(verdictBtn, () => loadVerdicts({ force: true })));

  const ackBtn = document.getElementById('verdictAckBtn');
  if (ackBtn) ackBtn.addEventListener('click', guardBtn(ackBtn, ackAllVerdicts));

  const seenToggle = document.getElementById('verdictSeenToggle');
  if (seenToggle) seenToggle.addEventListener('click', () => {
    const listEl = document.getElementById('verdictSeenList');
    if (!listEl) return;
    const open = seenToggle.dataset.open === '1';
    seenToggle.dataset.open = open ? '0' : '1';
    listEl.style.display = open ? 'none' : 'block';
    seenToggle.textContent = open
      ? `이미 확인한 항목 보기 (${seenToggle.dataset.count || ''})`
      : '이미 확인한 항목 숨기기';
  });
}

// 보안 탭을 열면 의심 판정 목록만 표시한다 (진입 시 이미 배지용으로 받아둔 캐시 재사용 → 추가 조회 0).
// 나머지 조회(스캔·백업·초기화)는 전부 버튼 클릭으로만.
export async function loadSecurity() {
  await loadVerdicts();
}

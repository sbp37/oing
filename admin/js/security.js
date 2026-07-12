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
  getWeekId, fmtNum, fmtDateTime, fmtAgo, escapeHtml, downloadJSON, humanError,
  getTodayDateStr, cache, fns, httpsCallable, callFn, normalizeNickname,
} from './firebase.js';
import { setLoading, setError, setEmpty, guardBtn, resultMsg } from './admin.js';
import { deleteRankingRecord } from './users.js';

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
    const n = rows.length;
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
  const rejected = dec === 'rejected_invalid';
  const cls = rejected ? 'rejected' : 'pending';
  const verdictText = rejected ? '거부' : '보류';
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
  if (force) cache.bust('security:verdicts');
  setLoading(el);
  try {
    const rows = await cache.get('security:verdicts', () => fetchDocs(verdictQuery()));
    // 배지도 최신 상태로 동기화
    const badge = document.getElementById('verdictBadge');
    const countEl = document.getElementById('verdictBadgeCount');
    if (badge && countEl) {
      if (rows.length) { countEl.textContent = rows.length >= 50 ? '50+' : String(rows.length); badge.style.display = ''; }
      else badge.style.display = 'none';
    }
    if (!rows.length) { setEmpty(el, '✅ 보류/거부된 의심 세션이 없어요'); return; }
    el.innerHTML = rows.map(verdictRowHtml).join('');
  } catch (e) {
    const msg = humanError(e);
    // 인덱스 미생성 시 Firestore가 주는 콘솔 에러 안내
    const extra = /index/i.test(String(e && (e.code || e.message)))
      ? '<br><span style="color:var(--muted);font-size:11.5px;">※ 처음 실행이면 브라우저 콘솔(F12)에 뜬 "인덱스 생성" 링크를 한 번 클릭해 인덱스를 만들어주세요.</span>' : '';
    setError(el, msg + extra);
  }
}

// ── 🔑 PIN 재설정 (분실 유저용) ──
// PIN 해시/솔트는 users_private에 있고 규칙상 클라이언트가 못 건드리므로,
// 실제 교체는 서버 함수 adminResetPin(Admin SDK)만 한다. 여기서는:
//  ① 닉네임 → nickname_lookup으로 UID 후보 확인(계정 연결된 유저만 대상)
//  ② 새 PIN 자동생성/직접입력 → 서버 함수 호출 → 성공 시 새 PIN을 화면에 표시
// 기존 PIN 원문을 조회하는 기능은 만들지 않는다.
function gen4Pin() {
  // 브라우저 crypto로 0000~9999 균등 생성 (Math.random 대신)
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 10000).padStart(4, '0');
}

async function pinResetSearch(rawNick) {
  const el = document.getElementById('pinResetResult');
  const norm = normalizeNickname(rawNick);
  if (!norm) { setEmpty(el, '닉네임을 입력하세요.'); return; }
  setLoading(el, '계정 확인 중...');
  try {
    // 닉변 유저 대응: renamedTo tombstone을 최대 6홉 따라가 현재 계정 uid를 찾는다
    let curNorm = norm, curRaw = rawNick, renamed = false, lk = null;
    const seen = new Set();
    for (let hop = 0; hop < 6; hop++) {
      if (seen.has(curNorm)) break;
      seen.add(curNorm);
      lk = await fetchDoc(doc(db, 'nickname_lookup', curNorm));
      if (!lk) break;
      if (lk.nickname) curRaw = lk.nickname;
      if (!lk.renamedTo) break;
      renamed = true; curNorm = normalizeNickname(lk.renamedTo);
    }
    // UID 계정이면 uid 로, 레거시(UID 미연결)면 닉네임 기록 존재 여부로 대상 판정
    const isUid = !!(lk && lk.uid);
    let stats = null, exists = isUid;
    if (isUid) {
      stats = await fetchDoc(doc(db, 'user_stats', lk.uid)).catch(() => null);
    } else {
      // 레거시: rankings 또는 user_stats(닉네임 키)에 실제 기록이 있어야 대상
      const [rank, legacyStats] = await Promise.all([
        fetchDoc(doc(db, 'rankings', curRaw)).catch(() => null),
        fetchDoc(doc(db, 'user_stats', curRaw)).catch(() => null),
      ]);
      stats = legacyStats;
      exists = !!(rank || legacyStats);
    }
    if (!exists) {
      setEmpty(el, `'${escapeHtml(rawNick)}' — 기록이 있는 닉네임이 아니에요. 정확한 닉네임인지 확인해주세요.`);
      return;
    }
    const renameNote = renamed ? `<div class="card-note" style="color:#fde68a;">↪ '${escapeHtml(rawNick)}'은(는) 현재 '${escapeHtml(curRaw)}'(으)로 닉변된 계정</div>` : '';
    const badge = isUid
      ? '<span class="badge green">계정 연동</span>'
      : '<span class="badge">레거시 (기기 바뀜/PIN 분실 복구용)</span>';
    const idLine = isUid
      ? `UID ${escapeHtml(lk.uid.slice(0, 10))}… · 최근 ${stats && stats.lastPlayed ? fmtAgo(stats.lastPlayed) : '-'}`
      : `최고 ${stats && typeof stats.bestScore === 'number' ? fmtNum(stats.bestScore) + 'pt' : '-'} · 최근 ${stats && stats.lastPlayed ? fmtAgo(stats.lastPlayed) : '-'}`;
    el.innerHTML = `
      ${renameNote}
      <div class="list-row" style="margin-bottom:8px;">
        <span class="main"><span class="nick">${escapeHtml(curRaw)}</span> ${badge}<br>
          <span class="sub">${idLine}</span></span>
      </div>
      <div class="row">
        <input id="pinResetInput" type="text" inputmode="numeric" maxlength="4" placeholder="새 4자리 PIN" style="max-width:120px;">
        <button id="pinResetGenBtn" class="btn btn-ghost">자동생성</button>
        <button id="pinResetApplyBtn" class="btn btn-danger">PIN 재설정</button>
      </div>
      <div id="pinResetApplyResult" class="result-msg"></div>`;
    document.getElementById('pinResetGenBtn').addEventListener('click', () => {
      document.getElementById('pinResetInput').value = gen4Pin();
    });
    const applyBtn = document.getElementById('pinResetApplyBtn');
    // UID 계정이면 uid 전달, 레거시면 uid 없이 닉네임만 전달 → 서버가 legacy_account_secrets로 처리
    applyBtn.addEventListener('click', guardBtn(applyBtn, () => pinResetApply(isUid ? lk.uid : null, curRaw, isUid)));
  } catch (e) {
    setError(el, humanError(e));
  }
}

async function pinResetApply(uid, nick, isUid) {
  const input = document.getElementById('pinResetInput');
  const out = document.getElementById('pinResetApplyResult');
  const pin = (input.value || '').trim();
  if (!/^\d{4}$/.test(pin)) { out.className = 'result-msg err'; out.textContent = '4자리 숫자 PIN을 입력하거나 "자동생성"을 누르세요.'; return; }
  const kindMsg = isUid ? '기존 PIN은 더 이상 작동하지 않게 됩니다.' : '레거시 계정 복구용 새 PIN이 설정됩니다.';
  if (!confirm(`'${nick}' 님의 PIN을 [ ${pin} ] (으)로 재설정할까요?\n${kindMsg}`)) return;
  out.className = 'result-msg'; out.textContent = '서버에 재설정 요청 중...';
  try {
    // 레거시는 uid 없이 nickname만 보냄 (서버가 legacy_account_secrets로 처리)
    const payload = isUid ? { uid, nickname: nick, newPin: pin } : { nickname: nick, newPin: pin };
    // callFn: asia-northeast3 우선 호출 → not-found면 us-central1로 폴백 (리전 어긋남 방지)
    const res = await callFn('adminResetPin', payload);
    const d = (res && res.data) || {};
    if (d.ok) {
      out.className = 'result-msg ok';
      const legacyNote = d.mode === 'legacy'
        ? '<br><span style="color:var(--muted);font-size:12px;">※ 레거시 계정이라, 유저가 새 PIN으로 이어하기하면 그때 계정(UID)이 자동 연결돼요.</span>' : '';
      out.innerHTML = `✅ 재설정 완료! 이 유저에게 알려줄 새 PIN: <b style="font-size:18px;color:var(--accent-green-light);">${pin}</b><br>
        <span style="color:var(--muted);font-size:12px;">유저는 다른 기기에서 "이어하기 → 닉네임 + 이 PIN"으로 계정을 복구할 수 있어요.</span>${legacyNote}`;
    } else {
      out.className = 'result-msg err';
      out.textContent = '재설정 실패: ' + (d.reason || '서버가 ok를 반환하지 않았어요.');
    }
  } catch (e) {
    // 실제 오류 코드를 그대로 노출한다 — "미배포"로 뭉개면 진짜 원인(리전/캐시/권한)을 못 잡는다
    const rawCode = String((e && e.code) || '');
    const rawMsg = String((e && e.message) || e || '');
    out.className = 'result-msg err';
    let hint = '';
    if (/permission-denied/i.test(rawCode + rawMsg)) {
      hint = '<br><b style="color:#fca5a5;">→ 관리자 이메일 계정으로 로그인했는지 확인하세요.</b> 익명으로 들어오면 서버가 거부해요 (잠금 버튼 → 이메일/비번으로 재로그인).';
    } else if (/not-found|CORS|does not exist|failed to fetch|load failed/i.test(rawCode + rawMsg)) {
      hint = '<br><b style="color:#fca5a5;">→ 브라우저가 옛 버전을 캐시했을 가능성이 커요.</b> 강력 새로고침(모바일: 브라우저 캐시 삭제 후 재접속 / PC: Ctrl+Shift+R) 하고 다시 시도하세요.<br>'
        + '<span style="color:var(--muted);font-size:11.5px;">그래도 안 되면 함수 리전(asia-northeast3) 또는 배포 상태를 확인해주세요.</span>';
    } else if (/internal/i.test(rawCode)) {
      hint = '<br><span style="color:var(--muted);font-size:12px;">서버 함수 내부 오류 — Firebase Console → Functions → adminResetPin → 로그를 확인해주세요.</span>';
    }
    out.innerHTML = `재설정 실패: <b>${escapeHtml(rawCode || rawMsg || '알 수 없는 오류')}</b>`
      + (rawCode && rawMsg && rawCode !== rawMsg ? `<br><span style="color:var(--muted);font-size:11.5px;">${escapeHtml(rawMsg)}</span>` : '')
      + hint;
  }
}

// ── 의심 기록 탐지 — 버튼 클릭 시에만 실행 ──
// 상위 랭킹 30명을 읽고, 상위 20명은 user_stats/주간 점수와 교차 검증
const SUSPECT_SCAN_TOP = 30;
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

  const pinSearchBtn = document.getElementById('pinResetSearchBtn');
  pinSearchBtn.addEventListener('click', guardBtn(pinSearchBtn, () => pinResetSearch(document.getElementById('pinResetNick').value.trim())));
  document.getElementById('pinResetNick').addEventListener('keydown', e => { if (e.key === 'Enter') pinSearchBtn.click(); });

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
}

// 보안 탭을 열면 의심 판정 목록만 표시한다 (진입 시 이미 배지용으로 받아둔 캐시 재사용 → 추가 조회 0).
// 나머지 조회(스캔·백업·초기화)는 전부 버튼 클릭으로만.
export async function loadSecurity() {
  await loadVerdicts();
}

// ══════════════════════════════════════════════════════════════
//  security.js — 보안 / 기록 관리 탭
//
//  · 이 탭은 열어도 자동 조회가 없다 (버튼을 눌러야만 조회).
//  · 초기화 로직/다단계 확인창은 기존 관리자(setupAdminReset)와 동일하게 이식.
//    추가 안전장치: 삭제 전에 JSON 백업이 자동으로 다운로드된다.
// ══════════════════════════════════════════════════════════════
import {
  db, collection, doc, query, orderBy, limit,
  fetchDocs, fetchDoc, deleteDoc, getUserDocByNick,
  getWeekId, fmtNum, escapeHtml, downloadJSON, humanError,
  getTodayDateStr,
} from './firebase.js';
import { setLoading, setError, setEmpty, guardBtn, resultMsg } from './admin.js';
import { deleteRankingRecord } from './users.js';

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
}

// 보안 탭은 "여는 것만으로는" 아무 데이터도 조회하지 않는다
export async function loadSecurity() {
  // 의도적으로 비움 — 모든 조회는 버튼 클릭으로만
}

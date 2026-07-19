// ══════════════════════════════════════════════════════════════
//  security.js — 보안 / 기록 관리 탭
//
//  · 이 탭은 열어도 자동 조회가 없다 (버튼을 눌러야만 조회).
//  · 초기화 로직/다단계 확인창은 기존 관리자(setupAdminReset)와 동일하게 이식.
//    추가 안전장치: 삭제 전에 JSON 백업이 자동으로 다운로드된다.
// ══════════════════════════════════════════════════════════════
import {
  db, collection, doc, query, where, orderBy, limit,
  fetchDocs, fetchDoc, setDoc, deleteDoc, getUserDocByNick, resolveUserDocId, countQuery,
  getWeekId, fmtNum, fmtDateTime, fmtDuration, escapeHtml, downloadJSON, humanError,
  getTodayDateStr, cache, fns, httpsCallable, makePager,
} from './firebase.js';
import { setLoading, setError, setEmpty, guardBtn, resultMsg } from './admin.js';
import { deleteRankingRecord } from './users.js';

// ── 🛟 점수 누락 복구 ──
// 오늘 실제 플레이했지만 랭킹에 반영 안 된 후보를 찾아, 관리자 버튼으로 서버 복구 함수를 호출.
// 실제 복구 판정(관리자 확인·상한 미만·현재보다 높을 때만·감사 로그)은 전부 서버(adminRecoverScore).
// 여기서는 후보 표시와 서버 호출만 한다. user_stats.bestScore(전체 최고점)가 아니라
// "오늘 실제 점수"만 대상 — recentScores 뒤 dailyPlayCount개의 최댓값(서버 로직과 동일).
const RECOVER_SCORE_MAX = 58000; // 서버(adminRecover.js) 공식 상한과 동일 — 2026-07-18 운영 결정 58000
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
      if (todaysBest >= RECOVER_SCORE_MAX) continue; // 공식 상한 이상은 복구 대상 아님
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

// ── 🏅 고득점 세션 열람 (game_sessions, 읽기 전용) ──
// 4만+ 세션을 판정과 무관하게 나열하고, 줄을 누르면 이미 저장된 telemetry + 유저 통계
// (user_stats 1건 추가 읽기)로 "플레이 스타일 요약"을 보여준다. 목적은 자동 차단이 아니라
// 운영자가 직접 보고 판단하는 것 — 4만 초과 자체는 어떤 판정에도 쓰지 않는다.
const HIGH_SCORE_MIN = 40000;
const DECISION_KO = { accepted: ['정상 반영', 'ok'], pending_review: ['보류', 'pending'], rejected_invalid: ['거부', 'rejected'] };

// 기기 라벨 — game_sessions.client.device({type,os,pwa}). 2026-07-18부터 수집(이전 판은 없음).
const DEVICE_TYPE_KO = { mobile: '📱 모바일', tablet: '📱 태블릿', pc: '💻 PC', unknown: '❔ 알 수 없음' };
function deviceLabel(dv) {
  if (!dv || typeof dv !== 'object') return '기록 없음 (이전 버전 판)';
  const type = DEVICE_TYPE_KO[dv.type] || DEVICE_TYPE_KO.unknown;
  const os = (dv.os && dv.os !== 'unknown') ? ` · ${escapeHtml(dv.os)}` : '';
  const pwa = dv.pwa === true ? ' · 홈화면 앱' : '';
  return `${type}${os}${pwa}`;
}
// 짧은 기기 배지(목록 줄용) — 모바일/PC만 아이콘으로
function deviceMini(dv) {
  if (!dv || !dv.type) return '';
  const m = { mobile: '📱', tablet: '📱', pc: '💻' };
  return m[dv.type] ? `<span title="${escapeHtml(deviceLabel(dv))}">${m[dv.type]}</span>` : '';
}

// 사람이 빠르게 읽는 한 줄 요약 — 전부 규칙 기반(추측·차단 없음)
function highScoreSummary(d, stats) {
  const parts = [];
  const score = d.client?.finalScore ?? 0;
  const elapsedSec = typeof d.serverElapsed === 'number' ? d.serverElapsed / 1000 : null;
  // ① 플레이 길이 — 본인 평소 평균 대비
  const avgPlay = (stats && stats.playCount > 0 && stats.totalPlayTime > 0) ? stats.totalPlayTime / stats.playCount : null;
  if (elapsedSec != null && avgPlay) {
    const r = elapsedSec / avgPlay;
    parts.push(r >= 1.5 ? `평소보다 ${r.toFixed(1)}배 긴 장기플레이형` : (r <= 0.7 ? `평소보다 짧은 판(${r.toFixed(1)}배)` : '평소 길이와 비슷'));
  } else if (elapsedSec != null) parts.push(`플레이 ${fmtDuration(Math.round(elapsedSec))}`);
  // 기기(있을 때만)
  if (d.client?.device) parts.push(deviceLabel(d.client.device));
  // ② 시계 사용 (신버전 판부터 기록)
  const clock = d.client?.clockUsed;
  parts.push((typeof clock === 'number') ? `시계 ${clock}회 사용` : '시계 기록 없음(이전 버전 판)');
  // ③ 순간 입력
  const burst = d.client?.maxSuccessesIn3Sec;
  if (typeof burst === 'number') {
    parts.push(burst <= 8 ? `순간입력 정상(3초 최대 ${burst})` : (burst < 12 ? `순간입력 빠름(3초 최대 ${burst})` : `순간입력 비정상(3초 ${burst}회)`));
  }
  // ④ 이전 기록 대비 — 이번 점수를 제외한 최근 점수들의 최댓값 기준(근사)
  const recent = (stats && Array.isArray(stats.recentScores)) ? stats.recentScores.filter(x => Number.isInteger(x) && x > 0) : [];
  const others = recent.filter(x => x !== score);
  if (others.length) {
    const prevBest = Math.max(...others);
    parts.push(score > prevBest ? `이전 기록 대비 ${(score / prevBest).toFixed(1)}배 상승` : '이전 기록 범위 내');
  } else parts.push('비교할 이전 기록 없음');
  // ⑤ 기존 자동 판정 신호
  const reasons = Array.isArray(d.official?.reasons) ? d.official.reasons : [];
  parts.push(reasons.length ? ('신호: ' + reasons.map(reasonLabel).join('·')) : '의심신호 없음');
  return parts.join(' · ');
}

// ── 🕵️ 성공 원장(ledger) 분석 — 4만+ 신버전 판에만 존재. 전부 표시 전용(자동 조치 없음) ──
const INTEGRITY_KO = {
  COMBO_GT_CLEARS: '최고 콤보가 성공 수보다 큼 (모순)',
  BURST_GT_CLEARS: '3초 버스트가 성공 수보다 큼 (모순)',
  LEDGER_COUNT_MISMATCH: '기록된 성공 수와 원장 줄 수가 안 맞음',
  LEDGER_SCORE_MISMATCH: '제출 점수와 원장 점수가 다름 (강한 의심)',
  LEDGER_COMBO_MISMATCH: '최고 콤보와 원장 기록이 안 맞음',
};
function hsParseLedger(str) {
  if (typeof str !== 'string' || !str) return null;
  const out = [];
  for (const p of str.split(';')) {
    if (!p) continue;
    const f = p.split(',').map(Number);
    if (f.length !== 3 || f.some(x => !Number.isFinite(x) || x < 0)) return null;
    out.push(f);
  }
  return out.length ? out : null;
}
// 성공 간격 통계 — 첫 줄(시작→첫 성공)은 준비 시간이라 리듬에서 제외
function hsRhythm(entries) {
  const deltas = entries.slice(1).map(e => e[0]);
  if (deltas.length < 5) return null;
  const s = [...deltas].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const std = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length);
  const median = pct(0.5);
  const tol = Math.max(50, median * 0.08); // 균일 판정 허용폭: 중앙값 ±8% (최소 50ms)
  const uniformPct = Math.round(deltas.filter(d => Math.abs(d - median) <= tol).length / deltas.length * 100);
  const third = Math.max(1, Math.floor(deltas.length / 3));
  const rate = (arr) => arr.length ? Math.round(60000 / (arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0;
  return {
    n: deltas.length, median, min: s[0], max: s[s.length - 1], mean: Math.round(mean), std: Math.round(std),
    p10: pct(0.10), p25: pct(0.25), p75: pct(0.75), p90: pct(0.90),
    fast100: deltas.filter(d => d <= 100).length,
    fast300: deltas.filter(d => d <= 300).length,
    uniformPct,
    pauses: deltas.filter(d => d >= 5000).length,
    maxPause: s[s.length - 1],
    rateEarly: rate(deltas.slice(0, third)), rateMid: rate(deltas.slice(third, third * 2)), rateLate: rate(deltas.slice(third * 2)),
  };
}
// 리듬 기반 주의 신호 — 사람 손은 흔들리고, 매크로는 균일하다
function hsRhythmFlags(st) {
  const flags = [];
  if (!st) return flags;
  if (st.n >= 50 && st.uniformPct >= 60) flags.push(`입력 간격이 기계처럼 균일함 (${st.uniformPct}%가 중앙값 ±8% 안)`);
  if (st.fast100 >= 5) flags.push(`0.1초 이하 간격 입력 ${st.fast100}회`);
  if (st.n >= 50 && st.std <= Math.max(30, st.median * 0.05)) flags.push('간격 흔들림(표준편차)이 비정상적으로 작음');
  return flags;
}
// 판 간 리듬 유사도 — 백분위 지문을 중앙값으로 정규화해 비교 (같은 유저의 원장 있는 판들끼리)
function hsFingerprint(st) {
  if (!st || !st.median) return null;
  return [st.p10, st.p25, st.median, st.p75, st.p90].map(v => v / st.median);
}
function hsSimilarityLabel(d, allRows) {
  const mine = hsFingerprint(hsRhythmOf(d));
  if (!mine) return null;
  const others = allRows.filter(r => r !== d && r.nickname === d.nickname && r.client?.ledger);
  const diffs = [];
  for (const o of others) {
    const fp = hsFingerprint(hsRhythmOf(o));
    if (fp) diffs.push(mine.reduce((a, v, i) => a + Math.abs(v - fp[i]), 0) / mine.length);
  }
  if (!diffs.length) return null;
  const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const label = avg < 0.06 ? '매우 비슷함 ⚠️' : (avg < 0.15 ? '비슷한 편' : '자연스럽게 다름');
  return { label, count: diffs.length, verySimilar: avg < 0.06 };
}
const _hsRhythmCache = new Map();
function hsRhythmOf(d) {
  if (!_hsRhythmCache.has(d)) {
    const entries = hsParseLedger(d.client?.ledger);
    _hsRhythmCache.set(d, entries ? hsRhythm(entries) : null);
  }
  return _hsRhythmCache.get(d);
}
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + '초' : ms + 'ms');

function highScoreDetailHtml(d, stats, allRows) {
  const c = d.client || {};
  const elapsedSec = typeof d.serverElapsed === 'number' ? Math.round(d.serverElapsed / 1000) : null;
  const avgPlay = (stats && stats.playCount > 0 && stats.totalPlayTime > 0) ? Math.round(stats.totalPlayTime / stats.playCount) : null;
  const avgGap = (elapsedSec && c.clearCount > 0) ? (elapsedSec / c.clearCount).toFixed(2) : null;
  const recent = (stats && Array.isArray(stats.recentScores)) ? stats.recentScores : [];
  const reasons = Array.isArray(d.official?.reasons) ? d.official.reasons : [];
  const integ = d.official?.integrity || null;
  const rhythm = hsRhythmOf(d);
  const sim = hsSimilarityLabel(d, allRows || []);
  const line = (k, v) => `<div class="mini-row"><span class="mini-label">${k}</span><span class="mini-val">${v}</span></div>`;
  const head = (t) => `<div style="margin:12px 0 2px; font-size:11.5px; font-weight:800; color:var(--muted2); letter-spacing:0.3px;">${t}</div>`;

  // ── 주의 신호 종합(쉬운 말) — 자동 판정 사유 + 무결성 모순 + 리듬 신호 + 유사도 ──
  const warns = [];
  reasons.filter(r => r !== 'NO_SESSION').forEach(r => warns.push(reasonLabel(r)));
  (integ?.flags || []).forEach(f => warns.push(INTEGRITY_KO[f] || f));
  hsRhythmFlags(rhythm).forEach(f => warns.push(f));
  if (sim && sim.verySimilar) warns.push(`최근 고득점 ${sim.count}판과 입력 리듬이 매우 비슷함`);
  const warnBox = warns.length
    ? `<div class="hs-summary" style="margin:8px 0; padding:8px 10px; border-radius:8px; background:rgba(226,90,90,0.10); border:1px solid rgba(226,90,90,0.3); font-size:12.5px; line-height:1.7;">⚠️ <b>주의 신호 ${warns.length}개</b><br>${warns.map(w => '· ' + escapeHtml(w)).join('<br>')}</div>`
    : `<div class="hs-summary" style="margin:8px 0; padding:8px 10px; border-radius:8px; background:rgba(76,175,107,0.10); border:1px solid rgba(76,175,107,0.3); font-size:12.5px;">✅ 주의 신호 없음</div>`;

  // ── 점수 검증(원장 재계산) ──
  const entries = hsParseLedger(c.ledger);
  const ledgerScore = integ?.ledgerScore ?? (entries ? entries[entries.length - 1][1] : null);
  const scoreDiff = integ?.scoreDiff ?? (ledgerScore != null ? (c.finalScore ?? 0) - ledgerScore : null);
  const verifyRows = ledgerScore != null ? `
    ${line('제출 점수', fmtNum(c.finalScore ?? 0) + '점')}
    ${line('원장 재계산', fmtNum(ledgerScore) + '점')}
    ${line('차이', scoreDiff === 0 ? '0 ✅' : `<b style="color:#fca5a5;">${fmtNum(scoreDiff)}점 ⚠️</b>`)}`
    : line('점수 검증', '원장 없음 (v4.6.6 이전 판)');

  // ── 입력 리듬 통계 ──
  const rhythmRows = rhythm ? `
    ${line('성공 간격 중앙값', fmtMs(rhythm.median) + ` (평균 ${fmtMs(rhythm.mean)})`)}
    ${line('최소 / 최대', `${fmtMs(rhythm.min)} / ${fmtMs(rhythm.max)}`)}
    ${line('흔들림(표준편차)', fmtMs(rhythm.std))}
    ${line('p10 / p25 / p75 / p90', [rhythm.p10, rhythm.p25, rhythm.p75, rhythm.p90].map(fmtMs).join(' / '))}
    ${line('빠른 입력', `0.1초 이하 ${rhythm.fast100}회 · 0.3초 이하 ${rhythm.fast300}회`)}
    ${line('균일한 간격 비율', rhythm.uniformPct + '% (중앙값 ±8% 안)')}
    ${line('정지 구간(5초+)', `${rhythm.pauses}회 · 최장 ${fmtMs(rhythm.maxPause)}`)}
    ${line('초반/중반/후반 속도', `${rhythm.rateEarly} → ${rhythm.rateMid} → ${rhythm.rateLate} 성공/분`)}
    ${sim ? line('다른 판과 리듬 비교', `${sim.label} (원장 있는 ${sim.count}판 대비)`) : ''}`
    : line('입력 리듬', '원장 없음 (v4.6.6 이전 판)');

  // ── 시간·창 상태 ──
  const w = c.winStat || null;
  const winRows = w ? `
    ${line('전체 플레이', w.playMs != null ? fmtDuration(Math.round(w.playMs / 1000)) : '-')}
    ${line('화면 이탈(백그라운드)', `${w.hidCount ?? 0}회 · 합 ${w.hidMs != null ? fmtDuration(Math.round(w.hidMs / 1000)) : '-'} · 최장 ${w.hidMax != null ? fmtDuration(Math.round(w.hidMax / 1000)) : '-'}`)}
    ${line('실제 활성 시간', (w.playMs != null && w.hidMs != null) ? fmtDuration(Math.round((w.playMs - w.hidMs) / 1000)) : '-')}`
    : '';

  // 성공률(성공 / (성공+실패)) — 플레이 스타일 참고용
  const total = (c.clearCount || 0) + (c.failCount || 0);
  const successRate = total > 0 ? Math.round((c.clearCount || 0) / total * 100) + '%' : '-';
  return `
    ${warnBox}
    <div class="hs-summary" style="margin:8px 0; padding:8px 10px; border-radius:8px; background:rgba(148,163,184,0.08); font-size:12.5px; line-height:1.6;">📝 ${escapeHtml(highScoreSummary(d, stats))}</div>
    ${head('📊 기본')}
    ${line('기기', deviceLabel(c.device))}
    ${line('점수', fmtNum(c.finalScore ?? 0) + '점')}
    ${line('플레이 시간', (elapsedSec != null ? fmtDuration(elapsedSec) : '-') + (avgPlay ? ` (평소 평균 ${fmtDuration(avgPlay)})` : ''))}
    ${line('최고 콤보', fmtNum(c.maxCombo ?? 0))}
    ${line('성공 / 실패', `${fmtNum(c.clearCount ?? 0)} / ${fmtNum(c.failCount ?? 0)} (성공률 ${successRate})`)}
    ${line('초기화(리셋) 횟수', fmtNum(c.resetCount ?? 0) + '회')}
    ${line('3초 내 최대 성공', fmtNum(c.maxSuccessesIn3Sec ?? 0) + '회')}
    ${line('평균 성공 간격', avgGap ? avgGap + '초' : '-')}
    ${line('시계 아이템', (typeof c.clockUsed === 'number') ? c.clockUsed + '회' : '기록 없음(이전 버전)')}
    ${line('최근 점수 추이', recent.length ? recent.map(fmtNum).join(' → ') : '-')}
    ${line('자동 판정', `${(DECISION_KO[d.official?.decision] || ['-'])[0]}${reasons.length ? ' — ' + reasons.map(reasonLabel).join(', ') : ''}`)}
    ${head('🧮 점수 검증')}
    ${verifyRows}
    ${head('🎹 입력 리듬')}
    ${rhythmRows}
    ${winRows ? head('🪟 시간·창 상태') + winRows : ''}
  `;
}

// 목록: 기본 10건 + "더 보기" 커서 페이지네이션 (점수 높은 순)
let hsRows = [];
function hsRowHtml(d, i) {
  const [decText, decCls] = DECISION_KO[d.official?.decision] || ['?', 'unverifiable'];
  const when = d.submittedAt ? fmtDateTime(d.submittedAt) : '-';
  const nWarn = (d.official?.integrity?.flags || []).length;
  return `
    <div class="verdict-row ${decCls}" data-hs="${i}" style="cursor:pointer; flex-wrap:wrap;">
      <span class="vr-main">
        <span class="nick">${escapeHtml(d.nickname || d.uid || '?')}</span> ${deviceMini(d.client?.device)}
        · <b>${fmtNum(d.client?.finalScore ?? 0)}점</b>
        ${nWarn ? `<span class="badge warn">모순 ${nWarn}</span>` : ''}
        <span class="vr-sub">${when} · 눌러서 상세 ▾</span>
      </span>
      <span class="vr-verdict ${decCls}">${decText}</span>
      <div class="hs-detail" style="display:none; flex-basis:100%; margin-top:4px;"></div>
    </div>`;
}
// 정렬 모드 — 기본 '최근순'(방금 친 판이 맨 위에 떠서 등록 확인 쉬움), 토글로 '점수순'(핵 의심 상위부터).
//  Firestore는 부등호 필터(finalScore>=4만) 필드가 첫 orderBy여야 해서 서버 정렬은 점수순만 가능 →
//  4만+ 세션을 (희소하므로) 한 번에 다 불러온 뒤 클라이언트에서 정렬만 바꾼다.
let hsSort = 'recent';
const HS_MAX_LOAD = 600; // 안전 상한 — 4만+는 희소하지만 폭주 대비
function hsSortRows() {
  if (hsSort === 'score') hsRows.sort((a, b) => (b.client?.finalScore ?? 0) - (a.client?.finalScore ?? 0));
  else hsRows.sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0)); // recent: 최근 제출 먼저
}
function hsRender() {
  hsSortRows();
  const el = document.getElementById('highScoreList');
  el.innerHTML = hsRows.map((d, i) => hsRowHtml(d, i)).join('');
  const more = document.getElementById('highScoreMoreBtn');
  if (more) more.style.display = 'none'; // 한 번에 다 불러오므로 더보기 미사용
  const sortUi = document.getElementById('highScoreSort');
  if (sortUi) sortUi.style.display = hsRows.length ? '' : 'none';
}
async function loadHighScores() {
  const el = document.getElementById('highScoreList');
  hsRows = []; _hsRhythmCache.clear();
  const pager = makePager(() => [
    collection(db, 'game_sessions'),
    where('client.finalScore', '>=', HIGH_SCORE_MIN),
    orderBy('client.finalScore', 'desc'), // 서버 정렬은 점수순 고정(부등호 필터 제약) — 표시는 hsSort로
  ], 50);
  setLoading(el, '4만점 이상 세션을 찾는 중...');
  try {
    let capped = false;
    while (!pager.done) {
      const page = await pager.next();
      hsRows.push(...page);
      if (hsRows.length >= HS_MAX_LOAD) { capped = true; break; }
    }
    if (!hsRows.length) {
      setEmpty(el, '4만점 이상 세션이 아직 없어요');
      const sortUi = document.getElementById('highScoreSort');
      if (sortUi) sortUi.style.display = 'none';
      return;
    }
    hsRender();
    if (capped) {
      const note = document.createElement('div');
      note.className = 'card-note';
      note.style.marginTop = '6px';
      note.textContent = `※ 최근 4만+ 세션 ${HS_MAX_LOAD}건까지만 불러왔어요(그 이전 판은 생략).`;
      el.appendChild(note);
    }
    // 줄 클릭 → 상세 토글 (위임 1회 바인딩 — 유저 통계는 처음 펼칠 때 1건만 읽고 캐시)
    if (!el.dataset.hsBound) {
      el.dataset.hsBound = '1';
      el.addEventListener('click', async (ev) => {
        const rowEl = ev.target.closest('[data-hs]');
        if (!rowEl) return;
        const d = hsRows[Number(rowEl.dataset.hs)];
        if (!d) return;
        const box = rowEl.querySelector('.hs-detail');
        if (box.style.display !== 'none') { box.style.display = 'none'; return; }
        if (!box.dataset.loaded) {
          box.innerHTML = '<div class="list-loading">유저 통계 확인 중...</div>';
          box.style.display = 'block';
          let stats = null;
          try { const r = await getUserDocByNick('user_stats', d.nickname || ''); stats = r && r.data; } catch {}
          box.innerHTML = highScoreDetailHtml(d, stats, hsRows);
          box.dataset.loaded = '1';
        }
        box.style.display = 'block';
      });
    }
  } catch (e) {
    const msg = humanError(e);
    const extra = /index/i.test(String(e && (e.code || e.message)))
      ? '<br><span style="color:var(--muted);font-size:11.5px;">※ 처음 실행이면 브라우저 콘솔(F12)의 "인덱스 생성" 링크를 한 번 눌러주세요.</span>' : '';
    setError(el, msg + extra);
  }
}

// ── 🚨 서버 자동 판정 알림 (game_sessions, 읽기 전용) ──
// 대시보드는 이 컬렉션을 절대 수정/삭제하지 않는다 (규칙상 write도 Cloud Function만 가능).
// 문서는 30일 TTL(expireAt)로 서버가 알아서 지우므로 별도 보관 로직 없음.
const VERDICT_DECISIONS = ['pending_review', 'rejected_invalid'];
const REASON_LABELS = {
  ELAPSED_TOO_SHORT: '30초 미만 즉시클리어',
  SCORE_OVER_OFFICIAL_CAP: '점수 상한 초과(5.8만+)',
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

// ELAPSED_TOO_SHORT(30초 미만 즉시클리어) 단독 사유는 실제로는 대부분 오탐이다:
// 게임 자체는 정상적으로 120초를 채워야 끝나므로, 진짜로 30초 안에 낸 점수라면 클라이언트가
// 아예 제출을 안 한다 — 이 사유가 뜨는 실제 원인은 startSession 응답 지연(콜드스타트·네트워크
// 지연)으로 세션의 serverStartedAt이 실제 게임 시작보다 한참 늦게 찍히는 경우가 대부분이다.
// 점수를 랭킹에 반영하지 않는 서버 판정 자체는 그대로 두되(보수적으로 안전한 방향),
// 관리자 "의심 판정" 알림에서는 제외해 진짜 의심 신호(점수 상한 초과·버스트 등)에 집중되게 한다.
const isElapsedOnly = (d) => Array.isArray(d.official?.reasons)
  && d.official.reasons.length === 1 && d.official.reasons[0] === 'ELAPSED_TOO_SHORT';
// 위 두 가지(검증 불가 · 짧은 플레이 오탐)를 합쳐 "의심 아님" 버킷으로 취급한다.
const isLowSignal = (d) => isUnverifiable(d) || isElapsedOnly(d);

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

// 상단 "📝 보류 리뷰" 배지 — 승인 대기 리뷰(game_reviews_pending) 개수. 진입 시 1회 count 집계
// (문서를 내려받지 않고 개수만 — 저렴). 1~2점/욕설 필터로 보류된 리뷰를 바로 알아채는 용도.
export async function loadReviewPendingBadge() {
  const badge = document.getElementById('reviewPendingBadge');
  const countEl = document.getElementById('reviewPendingCount');
  if (!badge || !countEl) return;
  try {
    const n = await countQuery(collection(db, 'game_reviews_pending'));
    if (n > 0) { countEl.textContent = n >= 50 ? '50+' : String(n); badge.style.display = ''; }
    else badge.style.display = 'none';
  } catch (e) {
    console.warn('보류 리뷰 배지 로드 실패(무해):', e && (e.code || e.message));
    badge.style.display = 'none';
  }
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
    const n = rows.filter(d => !isLowSignal(d) && !seen.has(d.id)).length; // 안 본 의심만
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
  const elapsedOnly = isElapsedOnly(d);
  const rejected = dec === 'rejected_invalid';
  const cls = (unverifiable || elapsedOnly) ? 'unverifiable' : (rejected ? 'rejected' : 'pending');
  const verdictText = unverifiable ? '검증 불가' : (elapsedOnly ? '오탐 가능' : (rejected ? '거부' : '보류'));
  const reasons = Array.isArray(d.official?.reasons) ? d.official.reasons : [];
  const elapsedSec = typeof d.serverElapsed === 'number' ? Math.round(d.serverElapsed / 1000) : null;
  const burst = d.client?.maxSuccessesIn3Sec;
  return `
    <div class="verdict-row ${cls}">
      <span class="vr-main">
        <span class="nick">${escapeHtml(d.nickname || d.uid || '?')}</span>
        · ${fmtNum(d.client?.finalScore ?? '-')}점
        <span class="vr-reasons">${reasons.map(r => `<span class="verdict-tag ${cls}">${escapeHtml(reasonLabel(r))}</span>`).join('')}</span>
        <span class="vr-sub">플레이 ${elapsedSec != null ? fmtDuration(elapsedSec) : '-'}${burst != null ? ` · 3초내 최대 ${fmtNum(burst)}성공` : ''} · ${d.official?.decidedAt ? fmtDateTime(d.official.decidedAt) : '-'}</span>
      </span>
      <span class="vr-verdict ${cls}">${verdictText}</span>
    </div>`;
}

export async function loadVerdicts({ force = false } = {}) {
  const el = document.getElementById('verdictList');
  const seenListEl = document.getElementById('verdictSeenList');
  const seenToggle = document.getElementById('verdictSeenToggle'); // 구 UI 전용 — 새 처리함에선 null
  const ackBtn = document.getElementById('verdictAckBtn');
  if (force) cache.bust('security:verdicts');
  setLoading(el);
  try {
    const rows = await cache.get('security:verdicts', () => fetchDocs(verdictQuery()));
    const seen = loadSeenIds();
    const suspects = rows.filter(d => !isLowSignal(d));
    const unverifiable = rows.filter(isUnverifiable);
    const elapsedOnly = rows.filter(isElapsedOnly);
    const newSuspects = suspects.filter(d => !seen.has(d.id));  // 아직 안 본 의심 → 메인
    const seenSuspects = suspects.filter(d => seen.has(d.id));  // 이미 본 의심 → 토글로
    const folded = [...seenSuspects, ...unverifiable, ...elapsedOnly]; // 접어둘 것(본 의심 + 검증불가 + 짧은플레이 오탐)

    syncBadge(newSuspects.length);
    if (ackBtn) ackBtn.style.display = newSuspects.length ? '' : 'none';

    // 메인: 새(안 본) 의심만. 없으면 칸을 비운다(정신없지 않게).
    el.innerHTML = newSuspects.length
      ? newSuspects.map(verdictRowHtml).join('')
      : `<div class="list-empty">✅ 새 의심 판정 없음</div>`;

    // 새 처리함(토글 버튼 없음): "처리 완료" 탭에 항상 렌더 — 표시/숨김은 서브탭이 담당
    if (!seenToggle && seenListEl) {
      seenListEl.innerHTML = folded.length
        ? (seenSuspects.length ? seenSuspects.map(verdictRowHtml).join('') : '') +
          (unverifiable.length
            ? `<div class="card-note" style="margin:10px 0 6px;">❔ 검증 불가 (서버세션 없음) — 치팅 의심이 아니라 서버세션이 생성되지 않아 판정을 확정할 수 없는 기록입니다.</div>
               ${unverifiable.map(verdictRowHtml).join('')}`
            : '') +
          (elapsedOnly.length
            ? `<div class="card-note" style="margin:10px 0 6px;">⏱️ 짧은 플레이(30초 미만) — 대부분 오탐입니다. 점수는 랭킹에 반영되지 않지만 계정 조치는 필요 없습니다.</div>
               ${elapsedOnly.map(verdictRowHtml).join('')}`
            : '')
        : `<div class="list-empty">처리 완료한 기록이 없어요</div>`;
    }
    // 구 UI 토글: 이미 확인한 의심 + 검증불가 — 기본 접힘
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
            : '') +
          (elapsedOnly.length
            ? `<div class="card-note" style="margin:10px 0 6px;">⏱️ 짧은 플레이(30초 미만) — 대부분 오탐입니다. 게임은 정상적으로 120초를 채워야 끝나므로, 세션 생성 지연(콜드스타트·네트워크 지연) 때문에 실제로는 정상 플레이인데 짧게 찍히는 경우가 대부분입니다. 점수는 랭킹에 반영되지 않지만 계정 제재 등 조치는 필요 없습니다.</div>
               ${elapsedOnly.map(verdictRowHtml).join('')}`
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

// "모두 확인" — 현재 안 본 의심을 전부 확인 처리 → 배지 사라지고 목록은 처리 완료로 이동.
export async function ackAllVerdicts() {
  const rows = cache.peek('security:verdicts') || [];
  const seen = loadSeenIds();
  const newIds = rows.filter(d => !isLowSignal(d) && !seen.has(d.id)).map(d => d.id);
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

// ── ⭐ 리뷰 관리 ──
// 목록 조회는 어드민이 버튼을 눌렀을 때만(자동 조회 없음). 모든 변경(승인/거부/삭제/답글/확인)은
// reviewAction 서버 함수를 호출한다 — 클라이언트는 game_reviews* 에 직접 쓸 수 없음(rules).
function rvStars(r) { const n = Math.max(1, Math.min(5, r | 0)); return '★'.repeat(n) + '☆'.repeat(5 - n); }

async function callReviewAdmin(payload) {
  const res = await httpsCallable(fns, 'reviewAction')(payload);
  return (res && res.data) || {};
}

async function scanReviews() {
  const el = document.getElementById('reviewAdminResult');
  setLoading(el, '리뷰를 불러오는 중...');
  try {
    const [live, pending] = await Promise.all([
      fetchDocs(query(collection(db, 'game_reviews'), orderBy('updatedAt', 'desc'), limit(200))),
      fetchDocs(collection(db, 'game_reviews_pending')),
    ]);

    const pendingHtml = pending.length ? `
      <div style="margin-bottom:10px;">
        <b style="color:#e5a33c;">⏳ 보류 중 (승인해야 공개) — ${pending.length}건</b>
        ${pending.map(p => `
          <div style="border:1px solid #4a3a1a; border-radius:8px; padding:8px 10px; margin-top:6px;">
            <b>${escapeHtml(p.nickname || '')}</b> ${rvStars(p.rating)}
            <span style="opacity:.6; font-size:11px;">(걸린 단어: ${escapeHtml(p.holdMatch || '?')})</span>
            <div style="margin:4px 0;">${escapeHtml(p.text || '(별점만)')}</div>
            <button class="btn btn-primary btn-sm" data-rv-approve="${escapeHtml(p.id)}">✅ 승인(공개)</button>
            <button class="btn btn-danger btn-sm" data-rv-reject="${escapeHtml(p.id)}">거부(삭제)</button>
          </div>`).join('')}
      </div>` : '';

    const unchecked = live.filter(r => !r.checked);
    const checked = live.filter(r => r.checked);
    const row = (r) => `
      <div style="border:1px solid ${r.checked ? '#223347' : '#5a2323'}; border-radius:8px; padding:8px 10px; margin-top:6px;">
        ${r.checked ? '' : `<b style="color:#ff8a8a;">${(r.editCount || 0) > 0 ? '✏️ 수정됨' : '🔴 새 리뷰'}</b> `}
        <b>${escapeHtml(r.nickname || '')}</b> ${rvStars(r.rating)}
        <span style="opacity:.6; font-size:11px;">${fmtDateTime(r.updatedAt || r.createdAt)} · ❤️${r.hearts || 0}${(r.editCount || 0) > 0 ? ` · 수정 ${r.editCount}회` : ''}</span>
        <div style="margin:4px 0;">${escapeHtml(r.text || '(별점만)')}</div>
        ${r.reply && r.reply.text ? `<div style="font-size:12px; color:#e5c36a; margin:4px 0;">😺 답글: ${escapeHtml(r.reply.text)}</div>` : ''}
        ${Array.isArray(r.history) && r.history.length ? `
          <details style="font-size:11.5px; opacity:.75; margin:4px 0;"><summary>📜 이전 내용 ${r.history.length}개</summary>
            ${r.history.map(h => `<div style="margin-top:3px;">${rvStars(h.rating)} ${escapeHtml(h.text || '(별점만)')} <span style="opacity:.6;">(${fmtDateTime(h.ts)})</span></div>`).join('')}
          </details>` : ''}
        ${r.checked ? '' : `<button class="btn btn-primary btn-sm" data-rv-check="${escapeHtml(r.id)}">👌 확인</button>`}
        <button class="btn btn-sm" data-rv-reply="${escapeHtml(r.id)}" data-rv-reply-cur="${escapeHtml((r.reply && r.reply.text) || '')}">💬 답글${r.reply && r.reply.text ? ' 수정' : ''}</button>
        <button class="btn btn-danger btn-sm" data-rv-del="${escapeHtml(r.id)}">삭제</button>
      </div>`;

    el.innerHTML = `
      ${pendingHtml}
      ${unchecked.length ? `<b>미확인 ${unchecked.length}건</b>${unchecked.map(row).join('')}` : '<div style="opacity:.7;">미확인 리뷰 없음 ✅</div>'}
      ${checked.length ? `<details style="margin-top:10px;"><summary>확인 완료 ${checked.length}건 보기</summary>${checked.map(row).join('')}</details>` : ''}
    `;

    // 액션 바인딩 — 처리 후 재스캔
    const rescan = () => scanReviews();
    el.querySelectorAll('[data-rv-approve]').forEach(b => b.addEventListener('click', guardBtn(b, async () => {
      await callReviewAdmin({ action: 'adminApprove', targetUid: b.dataset.rvApprove }); rescan();
    })));
    el.querySelectorAll('[data-rv-reject]').forEach(b => b.addEventListener('click', guardBtn(b, async () => {
      if (!confirm('이 보류 리뷰를 거부(삭제)할까요?')) return;
      await callReviewAdmin({ action: 'adminReject', targetUid: b.dataset.rvReject }); rescan();
    })));
    el.querySelectorAll('[data-rv-check]').forEach(b => b.addEventListener('click', guardBtn(b, async () => {
      await callReviewAdmin({ action: 'adminCheck', targetUid: b.dataset.rvCheck }); rescan();
    })));
    el.querySelectorAll('[data-rv-del]').forEach(b => b.addEventListener('click', guardBtn(b, async () => {
      if (!confirm('이 리뷰를 삭제할까요? 평균 별점에서도 빠집니다.')) return;
      await callReviewAdmin({ action: 'adminDelete', targetUid: b.dataset.rvDel }); rescan();
    })));
    el.querySelectorAll('[data-rv-reply]').forEach(b => b.addEventListener('click', guardBtn(b, async () => {
      const cur = b.dataset.rvReplyCur || '';
      const text = prompt('😺 오잉냥이 답글 (비우고 확인하면 답글 삭제, 200자까지)', cur);
      if (text === null) return; // 취소
      await callReviewAdmin({ action: 'adminReply', targetUid: b.dataset.rvReply, text: text.trim() }); rescan();
    })));
  } catch (e) {
    setError(el, humanError(e));
  }
}

// ══════════════════════════════
//  🚫 랭킹 영구차단 (섀도우밴)
// ══════════════════════════════
// ranking_blocklist/{uid} 문서를 만들면 서버(submitScore)가 그 계정 점수를 랭킹에 영구 미반영.
// 닉네임 → uid 해석은 nickname_lookup 우선, 없으면 rankings/{nick}.uid 폴백(레거시/핵 계정 대비).
async function resolveBlockUid(nick) {
  const { uid } = await resolveUserDocId(nick);
  if (uid) return uid;
  // 폴백: 랭킹 문서에 박힌 uid (nickname_lookup에 없던 레거시/익명 계정)
  const rk = await fetchDoc(doc(db, 'rankings', nick)).catch(() => null);
  if (rk && rk.uid) return rk.uid;
  return null;
}
async function blockAccount(nick) {
  const el = 'blocklistResult';
  if (!nick) { resultMsg(el, '닉네임을 입력하세요.', false); return; }
  const uid = await resolveBlockUid(nick);
  if (!uid) { resultMsg(el, `"${nick}"의 계정(UID)을 못 찾았어요. 랭킹/닉네임 기록이 있는 계정만 차단할 수 있어요.`, false); return; }
  await setDoc(doc(db, 'ranking_blocklist', uid), {
    nickname: nick, blockedAt: Date.now(), blockedBy: 'admin',
  });
  resultMsg(el, `🚫 "${nick}" 차단 완료 — 이제 이 계정 점수는 랭킹에 안 올라가요(섀도우밴).`, true);
  await loadBlocklist();
}
async function unblockAccount(uid, nick) {
  await deleteDoc(doc(db, 'ranking_blocklist', uid));
  resultMsg('blocklistResult', `✅ "${nick || uid}" 차단 해제됨.`, true);
  await loadBlocklist();
}
async function loadBlocklist() {
  const listEl = document.getElementById('blocklistList');
  if (!listEl) return;
  setLoading(listEl);
  try {
    const rows = await fetchDocs(collection(db, 'ranking_blocklist'));
    if (!rows.length) { setEmpty(listEl, '차단된 계정이 없어요.'); return; }
    rows.sort((a, b) => (b.blockedAt || 0) - (a.blockedAt || 0));
    listEl.innerHTML = rows.map(r => `
      <div class="list-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div>
          <span class="nick" style="font-weight:700;">${escapeHtml(r.nickname || '(닉 없음)')}</span>
          <span style="color:var(--muted);font-size:11px;"> · ${escapeHtml(r.id)}</span>
          <div style="color:var(--muted);font-size:11px;">${r.blockedAt ? fmtDateTime(r.blockedAt) : ''}</div>
        </div>
        <button class="btn btn-ghost btn-sm unblock-btn" data-uid="${escapeHtml(r.id)}" data-nick="${escapeHtml(r.nickname || '')}">해제</button>
      </div>`).join('');
    listEl.querySelectorAll('.unblock-btn').forEach(btn => {
      btn.addEventListener('click', guardBtn(btn, () => unblockAccount(btn.dataset.uid, btn.dataset.nick)));
    });
  } catch (e) { setError(listEl, humanError(e)); }
}

// ── 바인딩 / 로드 ──
export function initSecurityTab() {
  const scanBtn = document.getElementById('suspectScanBtn');
  scanBtn.addEventListener('click', guardBtn(scanBtn, scanSuspects));

  const recoverBtn = document.getElementById('recoverScanBtn');
  if (recoverBtn) recoverBtn.addEventListener('click', guardBtn(recoverBtn, scanRecoverCandidates));

  const hsBtn = document.getElementById('highScoreScanBtn');
  if (hsBtn) hsBtn.addEventListener('click', guardBtn(hsBtn, () => loadHighScores()));
  // 정렬 토글(최근순/점수순) — 이미 불러온 목록을 클라이언트에서 다시 정렬만 (재조회 없음)
  const hsSortUi = document.getElementById('highScoreSort');
  if (hsSortUi) hsSortUi.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-hssort]');
    if (!btn || !hsRows.length) return;
    hsSort = btn.dataset.hssort;
    hsSortUi.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    hsRender();
  });

  const blockLoadBtn = document.getElementById('blocklistLoadBtn');
  if (blockLoadBtn) blockLoadBtn.addEventListener('click', guardBtn(blockLoadBtn, loadBlocklist));
  const blockAddBtn = document.getElementById('blockAddBtn');
  if (blockAddBtn) blockAddBtn.addEventListener('click', guardBtn(blockAddBtn, async () => {
    const nick = document.getElementById('blockNick').value.trim();
    await blockAccount(nick);
    if (nick) document.getElementById('blockNick').value = '';
  }));

  const pinResetBtn = document.getElementById('pinResetBtn');
  if (pinResetBtn) pinResetBtn.addEventListener('click', guardBtn(pinResetBtn, resetPin));

  const reviewScanBtn = document.getElementById('reviewScanBtn');
  if (reviewScanBtn) reviewScanBtn.addEventListener('click', guardBtn(reviewScanBtn, scanReviews));

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
// (2026-07 개편) 의심 판정 UI는 처리함(inbox.js)으로 이동 — loadVerdicts/ackAllVerdicts export 사용.
// 이 파일의 initSecurityTab은 관리(tools) 탭의 보안 도구·백업·초기화 바인딩만 담당한다.

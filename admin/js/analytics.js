// ══════════════════════════════════════════════════════════════
//  analytics.js — 분석 탭
//
//  · 이 탭은 관리자가 "분석" 탭을 직접 클릭했을 때만 조회된다.
//  · 14일 그래프: dailyStats 캐시(stats.js) — 지난 날짜는 날짜당 문서 1개,
//    최초 1회만 원본에서 백필. 오늘만 라이브 계산.
//  · 유입경로/추천인: user_stats 최대 500명 1회 fetch → 세 가지 분석에 재사용.
//    비용이 커서 버튼을 눌렀을 때만 조회.
//  · 차트는 외부 라이브러리 없이 CSS 막대로 렌더링.
// ══════════════════════════════════════════════════════════════
import {
  db, collection, query, orderBy, limit,
  fetchDocs, fmtNum, fmtDuration, escapeHtml, cache, humanError,
} from './firebase.js';
import { getDailyStatsRange, computeWeeklyMetrics } from './stats.js';
import { setLoading, setError, guardBtn } from './admin.js';

const DAYS = 14;
const REFERRER_FETCH_CAP = 500;

function barChart(el, data, { valueKey, todayIdx = data.length - 1, unit = '' }) {
  const max = Math.max(1, ...data.map(d => d[valueKey] ?? 0));
  el.innerHTML = data.map((d, i) => {
    const v = d[valueKey] ?? 0;
    const h = Math.round(v / max * 100);
    const label = (d.date || '').slice(5).replace('-', '/');
    return `
      <div class="bar-wrap" title="${d.date}: ${fmtNum(v)}${unit}">
        <div class="bar-val">${v > 0 ? fmtNum(v) : ''}</div>
        <div class="bar ${i === todayIdx ? 'today' : ''}" style="height:${h}%"></div>
        <div class="bar-label">${label}</div>
      </div>`;
  }).join('');
}

function hourChart(el, hours) {
  const max = Math.max(1, ...hours);
  el.innerHTML = hours.map((v, h) => `
    <div class="bar-wrap" title="${h}시: ${fmtNum(v)}회">
      <div class="bar-val">${v > 0 ? v : ''}</div>
      <div class="bar" style="height:${Math.round(v / max * 100)}%"></div>
      <div class="bar-label">${h % 3 === 0 ? h + '시' : ''}</div>
    </div>`).join('');
}

export async function loadAnalytics({ force = false } = {}) {
  const chartEls = ['chartVisitors', 'chartNewUsers', 'chartPlays', 'chartHourly']
    .map(id => document.getElementById(id));
  chartEls.forEach(el => setLoading(el, '집계 중... (처음엔 지난 날짜 백필로 시간이 걸릴 수 있어요)'));
  const weeklyEl = document.getElementById('analyticsWeekly');
  weeklyEl.innerHTML = '';

  try {
    if (force) cache.bust('shared:dailyStats'); // 강제 새로고침이어도 확정(final) 날짜는 로컬/서버 캐시로 재구성됨
    const daily = await getDailyStatsRange(DAYS, { force });

    barChart(chartEls[0], daily, { valueKey: 'uniqueVisitors', unit: '명' });
    barChart(chartEls[1], daily, { valueKey: 'newUsers', unit: '명' });
    barChart(chartEls[2], daily, { valueKey: 'gamePlays', unit: '판' });

    // 시간대별 세션 — 14일치 dailyStats의 sessionsByHour 합산 (추가 조회 0)
    const hours = new Array(24).fill(0);
    for (const d of daily) (d.sessionsByHour || []).forEach((v, h) => { hours[h] += v; });
    hourChart(chartEls[3], hours);

    // 주간 지표 + 성장 추이
    const wk = computeWeeklyMetrics(daily);
    const last7 = daily.slice(-7), prev7 = daily.slice(0, 7);
    const sum = (arr, k) => arr.reduce((s, d) => s + (d[k] ?? 0), 0);
    const growth = (cur, prev) => prev > 0 ? `${cur >= prev ? '+' : ''}${Math.round((cur - prev) / prev * 100)}%` : '-';
    const tiles = [
      ['WAU (7일 고유 방문자)', `${fmtNum(wk.wau)}명`],
      ['오늘 재방문율', `${wk.returnRate}%`],
      ['주간 방문 (전주 대비)', `${fmtNum(sum(last7, 'uniqueVisitors'))} (${growth(sum(last7, 'uniqueVisitors'), sum(prev7, 'uniqueVisitors'))})`],
      ['주간 플레이 (전주 대비)', `${fmtNum(sum(last7, 'gamePlays'))} (${growth(sum(last7, 'gamePlays'), sum(prev7, 'gamePlays'))})`],
      ['주간 신규 유저', `${fmtNum(sum(last7, 'newUsers'))}명`],
      ['주간 평균 체류', fmtDuration(Math.round(sum(last7, 'avgDurationSec') / Math.max(1, last7.length)))],
      ['주간 990원 클릭', `${fmtNum(sum(last7.slice(0, -1), 'donateClicks'))}회+오늘`],
      ['주간 공유 클릭', `${fmtNum(sum(last7.slice(0, -1), 'shareClicks'))}회+오늘`],
    ];
    weeklyEl.innerHTML = tiles.map(([label, val]) => `
      <div class="stat-tile">
        <div class="stat-label">${label}</div>
        <div class="stat-value" style="font-size:16px;">${val}</div>
      </div>`).join('');
  } catch (e) {
    chartEls.forEach(el => setError(el, humanError(e)));
  }
}

// ── 유입경로 / 추천인 / 친구초대 — 버튼 클릭 시에만 조회 ──
async function loadReferrerData({ force = false } = {}) {
  const el = document.getElementById('referrerResult');
  setLoading(el, `user_stats 최대 ${REFERRER_FETCH_CAP}명 조회 중...`);
  try {
    if (force) cache.bust('analytics:referrer');
    // 한 번의 fetch 결과를 유입경로/추천인랭킹/친구초대 세 분석에 모두 재사용
    const rows = await cache.get('analytics:referrer', () =>
      fetchDocs(query(collection(db, 'user_stats'), orderBy('lastPlayed', 'desc'), limit(REFERRER_FETCH_CAP))));

    const bySrc = new Map();
    const byRef = new Map();
    const invited = [];
    for (const r of rows) {
      const src = r.referrerSrc || '알수없음';
      bySrc.set(src, (bySrc.get(src) || 0) + 1);
      if (r.refBy) {
        byRef.set(r.refBy, (byRef.get(r.refBy) || 0) + 1);
        invited.push(r);
      }
    }
    const srcRows = [...bySrc.entries()].sort((a, b) => b[1] - a[1]);
    const refRows = [...byRef.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const capNote = rows.length >= REFERRER_FETCH_CAP
      ? `<div class="card-note">⚠️ 최근 활동 ${REFERRER_FETCH_CAP}명까지만 집계했어요 (전체 아님)</div>` : '';

    el.innerHTML = `
      ${capNote}
      <h4 style="margin:10px 0 6px; font-size:13.5px;">🧭 유입경로 (${fmtNum(rows.length)}명 기준)</h4>
      <div class="list">${srcRows.map(([src, n]) => `
        <div class="list-row"><span class="main">${escapeHtml(src)}</span>
          <span class="sub">${fmtNum(n)}명 (${Math.round(n / rows.length * 100)}%)</span></div>`).join('')}
      </div>
      <h4 style="margin:14px 0 6px; font-size:13.5px;">🏅 추천인 랭킹 (초대 많은 순)</h4>
      <div class="list">${refRows.length ? refRows.map(([nick, n], i) => `
        <div class="list-row"><span class="main">${i < 3 ? ['🥇', '🥈', '🥉'][i] : (i + 1) + '.'} <span class="nick">${escapeHtml(nick)}</span></span>
          <span class="sub">${fmtNum(n)}명 초대</span></div>`).join('')
        : '<div class="list-empty">추천인 기록이 없어요</div>'}
      </div>
      <h4 style="margin:14px 0 6px; font-size:13.5px;">🤝 친구초대로 들어온 유저 (${fmtNum(invited.length)}명)</h4>
      <div class="list">${invited.slice(0, 30).map(r => `
        <div class="list-row"><span class="main"><span class="nick">${escapeHtml(r.nickname || r.id)}</span></span>
          <span class="sub">추천인: ${escapeHtml(r.refBy)}</span></div>`).join('') || '<div class="list-empty">없음</div>'}
      </div>`;
  } catch (e) {
    setError(el, humanError(e));
  }
}

export function initAnalyticsTab() {
  const btn = document.getElementById('referrerLoadBtn');
  btn.addEventListener('click', guardBtn(btn, () => loadReferrerData({ force: cache.peek('analytics:referrer') != null })));
}

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
import {
  getDailyStatsRange, computeWeeklyMetrics, dailyStatsWriteState,
  countTodayCached, todayNewUsersCount, SESSION_FETCH_CAP,
} from './stats.js';
import { setLoading, setError, guardBtn } from './admin.js';

const DAYS = 14;
const REFERRER_FETCH_CAP = 500;

// 14일 막대 — 데이터 14개는 그대로, 모바일 가독성을 위해
// 날짜 라벨은 오늘 기준 3일 간격만 표시하고, 모바일에서는 값 숫자를
// "최고값·오늘"만 남긴다 (나머지는 터치/hover 툴팁으로 확인 — CSS 처리)
function barChart(el, data, { valueKey, todayIdx = data.length - 1, unit = '' }) {
  const vals = data.map(d => d[valueKey] ?? 0);
  const max = Math.max(1, ...vals);
  const peakIdx = vals.indexOf(Math.max(...vals));
  el.classList.add('day');
  el.innerHTML = data.map((d, i) => {
    const v = vals[i];
    const h = Math.round(v / max * 100);
    const showLabel = (data.length - 1 - i) % 3 === 0; // 오늘부터 3일 간격
    const label = showLabel ? (d.date || '').slice(5).replace('-', '/') : '';
    const cls = `bar-wrap${i === todayIdx ? ' is-today' : ''}${i === peakIdx ? ' is-peak' : ''}`;
    return `
      <div class="${cls}" title="${d.date}: ${fmtNum(v)}${unit}">
        <div class="bar-val">${v > 0 ? fmtNum(v) : ''}</div>
        <div class="bar ${i === todayIdx ? 'today' : ''}" style="height:${h}%"></div>
        <div class="bar-label">${label}</div>
      </div>`;
  }).join('');
}

// 시간대별 — 막대 위 숫자를 표시하지 않음(24개가 전부 겹치므로), 값은 툴팁 +
// 아래 캡션에 "가장 활발한 시간대"만 요약
function hourChart(el, hours) {
  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  el.innerHTML = hours.map((v, h) => `
    <div class="bar-wrap" title="${h}시: ${fmtNum(v)}회">
      <div class="bar ${h === peak ? 'today' : ''}" style="height:${Math.round(v / max * 100)}%"></div>
      <div class="bar-label">${h % 3 === 0 ? h + '시' : ''}</div>
    </div>`).join('');
  const prevNote = el.parentElement && el.parentElement.querySelector('.hour-note');
  if (prevNote) prevNote.remove(); // 새로고침 시 캡션 중복 방지
  el.insertAdjacentHTML('afterend',
    `<div class="chart-note hour-note">가장 활발한 시간대: <b>${peak}시</b> (${fmtNum(hours[peak])}회) · 막대를 누르면 값이 표시돼요</div>`);
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

    // 오늘 항목에 신규 유저/클릭 수 주입 — 홈 타일과 "완전히 같은" 캐시된 count 값을 사용.
    // (오늘 세션 집계에는 이 필드들이 없어서, 주입하지 않으면 그래프 오늘 막대와
    //  주간 합계가 0으로 어긋난다 — 홈 11명 vs 그래프 0명 불일치의 원인이었음)
    const todayEntry = daily[daily.length - 1];
    const [tNew, tDonate, tShare] = await Promise.all([
      todayNewUsersCount().catch(() => null),
      countTodayCached('donate_clicks').catch(() => null),
      countTodayCached('share_clicks').catch(() => null),
    ]);
    todayEntry.newUsers = tNew;
    todayEntry.donateClicks = tDonate;
    todayEntry.shareClicks = tShare;

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
      ['주간 990원 클릭', `${fmtNum(sum(last7, 'donateClicks'))}회`],
      ['주간 공유 클릭', `${fmtNum(sum(last7, 'shareClicks'))}회`],
    ];
    weeklyEl.innerHTML = tiles.map(([label, val]) => `
      <div class="stat-tile">
        <div class="stat-label">${label}</div>
        <div class="stat-value" style="font-size:16px;">${val}</div>
      </div>`).join('');

    // 운영자에게 알려야 할 상태 안내 (조용한 잘림/캐시 미공유 방지)
    const notices = [];
    if (daily.some(d => d && d.truncated)) {
      notices.push(`⚠️ 세션이 하루 ${SESSION_FETCH_CAP}건을 넘은 날이 있어 해당 날짜는 근사치입니다.`);
    }
    if (dailyStatsWriteState.blocked) {
      notices.push('⚠️ dailyStats 저장이 보안 규칙에 막혀 이 기기(localStorage)에만 캐시됩니다. '
        + '다른 기기/브라우저에서는 백필이 반복되니, 규칙에 dailyStats 쓰기 허용을 추가하는 것을 권장합니다 (README 참고).');
    }
    document.getElementById('analyticsNotice').innerHTML = notices.join('<br>');
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

// 오늘의 목표 계단(ladder) + 스트릭 안전망 검증 (node --test, index.html에서 함수 추출 실행)
//
// 2026-07-22 부담 완화 반영을 고정한다:
//  · 달성 시 +5% (3일 이상 연속 달성 중이면 +3%로 둔화, 최소 +50)
//  · 상한 가드: 최근 중간값 ×1.25 (예전 1.6), 최고기록 ×75% (예전 85%), 하한 500
//  · 미달성 유지 / 이틀 연속 실패 -8% 는 기존 그대로
//  · 🛟 mergeGoalBackup: 로컬 백업이 서버보다 최신일 때만 목표/스트릭 필드를 이어받음
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
function extract(re, name) {
  const m = src.match(re);
  assert.ok(m, `${name} 추출 실패`);
  return m[0];
}
const code = [
  extract(/function hashSeed\(str\) \{[\s\S]*?\n\}/, 'hashSeed'),
  extract(/function medianOf\(arr\) \{[\s\S]*?\n\}/, 'medianOf'),
  extract(/function computeDailyGoal\(prevStats, nickname, dateStr\) \{[\s\S]*?\n\}/, 'computeDailyGoal'),
  extract(/const GOAL_BACKUP_FIELDS = [\s\S]*?function saveGoalBackup\(nick, stats\) \{[\s\S]*?\n\}\nfunction mergeGoalBackup\(nick, server\) \{[\s\S]*?\n\}/, 'goalBackup helpers'),
].join('\n');
// localStorage 셧 — 브라우저 전역을 노드에서 흉내
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const api = new Function('localStorage', code +
  '\nreturn { computeDailyGoal, saveGoalBackup, mergeGoalBackup };')(localStorage);

// 최근 7판 중간값이 목표를 안 깎게 넉넉한 실측치 (중간값 6000, 최고 10000)
const RECENT = [5500, 6000, 6500, 5800, 6200, 6000, 6100];
const baseStats = (over = {}) => ({
  bestScore: 10000, recentScores: RECENT,
  dailyGoalScore: 4000, dailyGoalDate: '2026-07-21', dailyDate: '2026-07-21',
  dailyGoalAchievedToday: true, dailyPlayCount: 3, goalStreak: 1, goalMissStreak: 0,
  ...over,
});

test('달성(연속 3일 미만) → +5% 계단: 4000 → 4200', () => {
  const r = api.computeDailyGoal(baseStats({ goalStreak: 1 }), '냥', '2026-07-22');
  assert.equal(r.score, 4200); // round(4000*1.05/50)*50
  assert.equal(r.label, '도전냥');
});

test('달성(연속 3일 이상) → +3%로 둔화: 4000 → 4100', () => {
  const r = api.computeDailyGoal(baseStats({ goalStreak: 3 }), '냥', '2026-07-22');
  assert.equal(r.score, 4100); // round(4000*1.03/50)*50
});

test('상한 가드: 중간값×1.25 에서 멈춤 (예전 1.6배 아님)', () => {
  // 목표가 이미 중간값(6000) 부근까지 올라온 유저 — 달성해도 7500(=6000×1.25) 초과 불가
  const r = api.computeDailyGoal(baseStats({ dailyGoalScore: 7400, goalStreak: 5 }), '냥', '2026-07-22');
  assert.ok(r.score <= Math.round(6000 * 1.25 / 50) * 50, `상한 7500 이하여야 함: ${r.score}`);
});

test('상한 가드: 최고기록 75% (예전 85% 아님)', () => {
  // 중간값 가드가 안 걸리게 recentScores를 높게, 최고기록 10000 → 상한 7500
  const highRecent = [9000, 9500, 9200, 9400, 9100, 9300, 9600];
  const r = api.computeDailyGoal(baseStats({ recentScores: highRecent, dailyGoalScore: 7400, goalStreak: 0 }), '냥', '2026-07-22');
  assert.ok(r.score <= Math.floor((10000 * 0.75) / 100) * 100, `최고기록 75%(7500) 이하여야 함: ${r.score}`);
});

test('미달성(그날 플레이함) 1일 → 유지, 이틀 연속 → -8%', () => {
  const miss1 = api.computeDailyGoal(baseStats({ dailyGoalAchievedToday: false, goalMissStreak: 0 }), '냥', '2026-07-22');
  assert.equal(miss1.score, 4000);
  const miss2 = api.computeDailyGoal(baseStats({ dailyGoalAchievedToday: false, goalMissStreak: 1 }), '냥', '2026-07-22');
  assert.ok(miss2.score < 4000, `이틀 연속 실패면 내려가야 함: ${miss2.score}`);
  assert.equal(miss2.label, '가볍냥');
});

// ── 🛟 스트릭 안전망 (mergeGoalBackup) ──
const serverStale = {
  playCount: 100, dailyGoalDate: '2026-07-20', dailyGoalScore: 3800,
  goalStreak: 4, goalStreakLastDate: '2026-07-20', dailyGoalAchievedToday: true,
};
test('백업이 서버보다 최신(다음날 달성 저장 실패) → 백업의 스트릭을 이어받음', () => {
  api.saveGoalBackup('냥', { dailyGoalDate: '2026-07-21', dailyGoalScore: 4000, goalStreak: 5, goalStreakLastDate: '2026-07-21', dailyGoalAchievedToday: true, goalTotalCount: 9, goalMissStreak: 0, maxGoalStreak: 5 });
  const merged = api.mergeGoalBackup('냥', serverStale);
  assert.equal(merged.goalStreak, 5);
  assert.equal(merged.goalStreakLastDate, '2026-07-21');
  assert.equal(merged.playCount, 100); // 목표 외 필드는 서버 값 유지
});

test('서버가 더 최신(다른 기기에서 이후 달성) → 서버 값 유지', () => {
  api.saveGoalBackup('냥', { dailyGoalDate: '2026-07-19', goalStreak: 2, goalStreakLastDate: '2026-07-19', dailyGoalAchievedToday: true });
  const merged = api.mergeGoalBackup('냥', serverStale);
  assert.equal(merged.goalStreak, 4); // 서버(7/20)가 백업(7/19)보다 최신
});

test('백업 없음/서버 없음 → 그대로 반환(무해)', () => {
  assert.equal(api.mergeGoalBackup('없는닉', serverStale), serverStale);
  assert.equal(api.mergeGoalBackup('냥', null), null);
});

// 친구 랭킹 = 전체(역대) 점수 기준 고정 검증 (node --test, 정적 검사)
//
// 배경(2026-07-22): 친구탭이 주간 점수를 메인으로 써서 매주 월요일 리셋 때 친구 목록이
// 통째로 0점이 되어 "기록이 사라진" 것처럼 보였다. 이제 전체 점수를 메인으로 유지하고
// 이번 주 점수는 보조 표기로만 보여준다. 아래를 고정한다:
//  · 친구 분기에서 e.score(전체)를 주간 점수로 덮어쓰지 않음
//  · 주간 점수는 e.weekScore 로만 담김
//  · 정렬 1순위 = e.score(전체)
//  · 표시 보조 라벨 = "이번주 N" (예전 "최고 N" 아님)
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

// 친구 분기(주간 점수 조회 ~ 정렬)만 잘라낸다
function friendsBlock() {
  const i = src.indexOf('const weeklyList = await loadWeeklyRankings();');
  assert.notEqual(i, -1, '친구 분기 시작 마커를 찾지 못함');
  const j = src.indexOf('list.sort((a, b)', i);
  assert.notEqual(j, -1, '친구 분기 정렬 마커를 찾지 못함');
  const end = src.indexOf('\n', j);
  return src.slice(i, end);
}
const block = friendsBlock();

test('친구탭: 전체 점수(e.score)를 주간 점수로 덮어쓰지 않음', () => {
  assert.ok(!/e\.score\s*=/.test(block), 'e.score 재할당이 있으면 주간 리셋에 다시 휩쓸림');
  assert.ok(!/e\.ts\s*=/.test(block), 'e.ts(역대 갱신시각) 재할당 없어야 🔥 기준이 전체 탭과 통일됨');
});

test('친구탭: 주간 점수는 보조 필드(e.weekScore)로만 담김', () => {
  const assigns = block.match(/e\.weekScore\s*=/g) || [];
  assert.ok(assigns.length >= 2, `e.weekScore 대입이 있어야 함 (found ${assigns.length})`);
  assert.ok(!/e\.bestScore/.test(block), '예전 bestScore(역대→보조) 전환 흔적이 남아있으면 안 됨');
});

test('친구탭: 정렬 1순위 = 전체 점수, 2순위 = 이번주 점수', () => {
  const sortLine = block.slice(block.indexOf('list.sort((a, b)'));
  assert.ok(/\(b\.score \|\| 0\) - \(a\.score \|\| 0\)/.test(sortLine), '1순위가 전체 점수여야 함');
  assert.ok(/\(b\.weekScore \|\| 0\) - \(a\.weekScore \|\| 0\)/.test(sortLine), '2순위가 이번주 점수여야 함');
});

test('표시: 시상대·행 보조 라벨이 "이번주 N" (예전 "최고 N" 아님)', () => {
  const podium = src.match(/<div class="podium-score">[\s\S]{0,400}?<\/div>/);
  assert.ok(podium, '시상대 점수 마크업을 찾지 못함');
  assert.ok(/이번주 \$\{entry\.weekScore/.test(podium[0]), '시상대 보조 라벨이 이번주 점수여야 함');
  assert.ok(!/최고 \$\{entry\.bestScore/.test(src), '행/시상대에 옛 "최고 N" 라벨이 남아있으면 안 됨');
  const rowSub = src.match(/const bestSubR = [\s\S]{0,320}?;\n/);
  assert.ok(rowSub && /이번주 \$\{entry\.weekScore/.test(rowSub[0]), '행 보조 라벨이 이번주 점수여야 함');
});

test('안내 문구: 친구탭 부제에 주간 프레이밍이 남아있지 않음', () => {
  assert.ok(!/친구끼리 이번 주 점수로 겨뤄보자냥/.test(src), '옛 주간 부제 문구가 남아있으면 안 됨');
  assert.ok(/친구끼리 전체 기록으로 겨뤄보자냥/.test(src), '전체 기록 기준 부제가 있어야 함');
});

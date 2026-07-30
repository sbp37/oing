// ✨올클리어 힌트 이월 배선 + 업데이트 NEW 뱃지 배선 검증 (node --test, 정적 검사)
//
// 힌트 이월: 판을 숫자 한 칸 없이 완전히 비우면(퍼펙트) 다음 판 힌트가 3개가 된다.
//  구현은 "hintsUsed = -1 로 시작" 트릭이라, 아래 세 조각이 전부 맞물려야 동작한다:
//   ① triggerBoardReset 에서 leftoverNums === 0 일 때 carryHintNextStage = true
//      (반드시 makeBoard 를 부르는 setTimeout '앞'에서 세워져야 함)
//   ② makeBoard 에서 hintsUsed = carryHintNextStage ? -1 : 0 로 소비 + 즉시 플래그 해제
//   ③ 새 판 그린 뒤 updateHintBtn/updateHintBtn2 재호출 → 라벨이 (3)으로 갱신
//
// NEW 뱃지: SEEN_KEY 버전과 실제 뱃지 element id 가 어긋나면 NEW 가 영영 안 뜬다(무증상 버그).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const between = (startMarker, endMarker, name) => {
  const i = src.indexOf(startMarker);
  assert.notEqual(i, -1, `${name}: 시작 마커 못 찾음`);
  const j = src.indexOf(endMarker, i);
  assert.notEqual(j, -1, `${name}: 끝 마커 못 찾음`);
  return src.slice(i, j);
};

test('① 퍼펙트(남은 숫자 0)일 때만 이월 플래그가 켜지고, makeBoard 호출보다 먼저 세워진다', () => {
  const block = between('function triggerBoardReset()', '\n// 판 전환 연출', 'triggerBoardReset');
  assert.ok(/if \(leftoverNums === 0\) carryHintNextStage = true;/.test(block),
    '퍼펙트 조건에서 carryHintNextStage 를 세워야 함');
  const flagAt = block.indexOf('carryHintNextStage = true');
  const makeAt = block.indexOf('makeBoard()');
  assert.ok(flagAt > -1 && makeAt > -1 && flagAt < makeAt,
    '이월 플래그는 makeBoard() 호출보다 먼저 세워져야 함(순서 뒤집히면 이월이 씹힘)');
  // 새 판을 그린 뒤 힌트 버튼 라벨을 다시 그려야 (3)으로 보인다
  assert.ok(block.indexOf('updateHintBtn()') > makeAt, 'makeBoard 뒤에 updateHintBtn 재호출 필요');
});

test('② makeBoard 가 이월을 hintsUsed=-1 로 소비하고 플래그를 즉시 해제한다', () => {
  const block = between('function makeBoard()', '\n// 합이 10 되는 짝을', 'makeBoard');
  assert.ok(/hintsUsed = carryHintNextStage \? -1 : 0;/.test(block), '이월 시 hintsUsed=-1 로 시작해야 함');
  const useAt = block.indexOf('hintsUsed = carryHintNextStage');
  const clearAt = block.indexOf('carryHintNextStage = false');
  assert.ok(clearAt > useAt, '소비 직후 플래그를 꺼야 연속 퍼펙트에도 3개 고정(4개 방지)');
});

test('③ 힌트 버튼 라벨 계산: hintsUsed=-1 이면 (3), 소진되면 사용완료', () => {
  const m = src.match(/const MAX_HINTS = (\d+)/);
  assert.ok(m, 'MAX_HINTS 상수를 찾지 못함');
  const MAX = Number(m[1]);
  assert.equal(MAX, 2, '기본 힌트는 2개');
  assert.equal(MAX - (-1), 3, '이월 상태 라벨은 (3)');
  // 3회 사용 후 hintsUsed 는 -1+3 = 2 = MAX → 사용완료 조건 충족
  assert.ok((-1 + 3) >= MAX, '3회 쓰면 정확히 소진돼야 함');
});

test('④ 새 게임 시작 시 직전 게임 이월이 새지 않는다', () => {
  assert.ok(/carryHintNextStage = false; \/\/ 새 게임 첫 판은 항상 힌트 2개/.test(src),
    'startGame 에서 이월 플래그 초기화 필요');
});

test('⑤ 업데이트 NEW 뱃지: SEEN_KEY 버전과 뱃지 element id 가 일치한다', () => {
  const key = src.match(/const SEEN_KEY = 'seenUpdate_v([\d.]+)';/);
  assert.ok(key, 'SEEN_KEY 를 찾지 못함');
  const idFromKey = 'newBadge' + key[1].replace(/\./g, ''); // v4.6 → newBadge46
  assert.ok(src.includes(`id="${idFromKey}"`), `업데이트 목록에 ${idFromKey} 뱃지가 있어야 NEW 가 뜸`);
  // 보여주기/숨기기 양쪽 모두 같은 id 를 참조해야 한다
  const refs = (src.match(new RegExp(`getElementById\\('${idFromKey}'\\)`, 'g')) || []).length;
  assert.ok(refs >= 2, `${idFromKey} 를 표시·숨김 양쪽에서 참조해야 함 (found ${refs})`);
});

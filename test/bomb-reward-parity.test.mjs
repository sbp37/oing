// 일반 폭탄 보상 파리티 정적 검증 (node --test, 에뮬레이터 불필요)
//
// 배경(2026-07-21 수정): 일반 폭탄이 "직접 탭"으로 발동하면 +20점·콤보+1을 줬지만,
// "드래그 매치에 포함"돼 발동하면 폭발 점수만 주는 비대칭이 있었다(메가폭탄은 원래 대칭).
// index.html의 네 발동 블록(탭/드래그 × 폭탄/메가폭탄)을 잘라내 아래를 고정한다:
//  · 일반 폭탄: 탭·드래그 모두 콤보+1(combo++) + 보너스 20 — 각 1회만(중복 지급 없음)
//  · 메가폭탄: 탭·드래그 모두 콤보+1 + 보너스 40 유지(회귀 방지), 20점 보너스 침범 없음
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

// 시작 마커(들여쓰기 포함으로 유일)부터 끝 마커 직전까지 잘라낸다.
function sliceBlock(name, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  assert.notEqual(i, -1, `${name}: 시작 마커를 찾지 못함 — ${startMarker.trim()}`);
  assert.equal(src.indexOf(startMarker, i + 1), -1, `${name}: 시작 마커가 유일하지 않음`);
  const j = src.indexOf(endMarker, i);
  assert.notEqual(j, -1, `${name}: 끝 마커를 찾지 못함 — ${endMarker.trim()}`);
  return src.slice(i, j);
}
const count = (block, re) => (block.match(re) || []).length;

const tapBomb   = sliceBlock('탭 폭탄',      '\n    if (d.bomb) {',      '\n    if (d.megabomb) {');
const tapMega   = sliceBlock('탭 메가폭탄',   '\n    if (d.megabomb) {',  '\n    if (d.clock) {');
const dragBomb  = sliceBlock('드래그 폭탄',   '\n  if (hasBomb) {',       '\n  if (hasClock) {');
const dragMega  = sliceBlock('드래그 메가폭탄','\n  if (hasMegabomb) {',   '\n  if (hasFreeze) {');

test('일반 폭탄: 직접 탭 발동 = 콤보+1 + 보너스 20 (각 1회)', () => {
  assert.equal(count(tapBomb, /combo\+\+/g), 1, '탭 폭탄 combo++ 정확히 1회');
  assert.equal(count(tapBomb, /const bonus = 20/g), 1, '탭 폭탄 보너스 20 정확히 1회');
  assert.equal(count(tapBomb, /bombScore \+= bonus/g), 1, '탭 폭탄 보너스 지급 1회');
});

test('일반 폭탄: 드래그 발동 = 콤보+1 + 보너스 20 (각 1회 — 탭과 최종 보상 동일)', () => {
  assert.equal(count(dragBomb, /combo\+\+/g), 1, '드래그 폭탄 combo++ 정확히 1회');
  assert.equal(count(dragBomb, /const bonus = 20/g), 1, '드래그 폭탄 보너스 20 정확히 1회');
  assert.equal(count(dragBomb, /bombScore \+= bonus/g), 1, '드래그 폭탄 보너스 지급 1회');
});

test('일반 폭탄: 탭·드래그 모두 점수 반영(score += bombScore)과 콤보 UI 갱신 존재', () => {
  for (const [name, block] of [['탭', tapBomb], ['드래그', dragBomb]]) {
    assert.ok(/score \+= bombScore/.test(block), `${name} 폭탄 score 반영`);
    assert.ok(/updateComboUI\(/.test(block), `${name} 폭탄 콤보 UI 갱신`);
    assert.ok(/if \(crossedB\) .*spawnRandomItem\(\)|if \(crossedB\)\s*spawnRandomItem\(\)/s.test(block), `${name} 폭탄 7배수 아이템 지급 판정`);
  }
});

test('메가폭탄 회귀 없음: 탭·드래그 모두 콤보+1 + 40 보너스, 20점 보너스 미침범', () => {
  for (const [name, block] of [['탭', tapMega], ['드래그', dragMega]]) {
    assert.equal(count(block, /combo\+\+/g), 1, `${name} 메가폭탄 combo++ 1회`);
    assert.ok(/bombScore \+= 40/.test(block), `${name} 메가폭탄 +40 유지`);
    assert.equal(count(block, /const bonus = 20/g), 0, `${name} 메가폭탄에 20 보너스 없음`);
  }
});

test('중복 지급 방지: 드래그 폭탄 블록에 점수 반영(score +=)은 1회뿐', () => {
  assert.equal(count(dragBomb, /score \+= bombScore/g), 1, '드래그 폭탄 score 반영 1회');
  assert.equal(count(tapBomb, /score \+= bombScore/g), 1, '탭 폭탄 score 반영 1회');
});

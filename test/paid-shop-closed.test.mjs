// 유료(현금) 결제 경로 차단 상태 검증 (node --test, 정적 검사)
//
// 사업자등록 정리 전까지 현금 결제 경로를 노출하지 않기로 함.
// 결제는 카카오페이 송금 링크(donateOverlay 안)로만 이뤄지므로, 그 오버레이로 가는
// 진입점이 전부 막혀 있어야 한다. 진입점이 하나라도 다시 열리면 이 테스트가 깨진다.
//
// ※ 코드는 지우지 않고 display:none 으로만 닫아둔 상태 — 다시 열 때는 해당 한 줄만 제거.
//   (구매 이력·보유 스킨은 서버 데이터라 이 변경과 무관하게 그대로 유지된다)
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

// 해당 id 를 가진 요소의 여는 태그 안에 display:none 이 있는지
function isHiddenById(id) {
  const i = src.indexOf(`id="${id}"`);
  assert.notEqual(i, -1, `#${id} 요소를 찾지 못함`);
  const start = src.lastIndexOf('<', i);
  const end = src.indexOf('>', i);
  return /display\s*:\s*none/.test(src.slice(start, end));
}

test('현금 결제 오버레이(donateOverlay) 진입 버튼이 전부 숨겨져 있다', () => {
  // 상단 "스킨샵 🐱" — donateOverlay 를 직접 여는 유일한 상시 노출 버튼이었음
  assert.ok(isHiddenById('supportTopBtn'), '스킨샵(상단) 버튼이 열려 있으면 안 됨');
});

test('젤리샵 안 서포터팩(990원) 박스가 숨겨져 있다', () => {
  // 젤리샵은 랭킹의 "+ 말풍선" 탭으로도 열리므로 박스 자체를 숨겨야 결제 경로가 막힌다
  const i = src.indexOf('class="jshop-support-box"');
  assert.notEqual(i, -1, '서포터팩 박스를 찾지 못함');
  const end = src.indexOf('>', i);
  assert.ok(/display\s*:\s*none/.test(src.slice(i, end)), '서포터팩 박스가 열려 있으면 안 됨');
});

test('젤리샵 직접 진입 버튼들도 닫힌 상태 유지', () => {
  for (const id of ['jellyShopBtn', 'jellyBalanceBtn', 'skinOpenBtn']) {
    assert.ok(isHiddenById(id), `#${id} 이 열려 있으면 안 됨`);
  }
});

test('결제 링크는 donateOverlay 안에만 있고, 그 오버레이는 기본 숨김', () => {
  const links = [...src.matchAll(/qr\.kakaopay\.com/g)];
  assert.ok(links.length > 0, '결제 링크가 아예 없으면 이 테스트는 의미 없음(구조 변경 확인 필요)');
  const ovStart = src.indexOf('<div id="donateOverlay"');
  assert.notEqual(ovStart, -1, 'donateOverlay 를 찾지 못함');
  const ovTagEnd = src.indexOf('>', ovStart);
  assert.ok(/display\s*:\s*none/.test(src.slice(ovStart, ovTagEnd)), 'donateOverlay 는 기본 숨김이어야 함');
  // 모든 결제 링크가 donateOverlay 시작 이후에 위치(= 그 안에 들어있음)
  const nextOverlay = src.indexOf('class="overlay"', ovTagEnd);
  for (const m of links) {
    assert.ok(m.index > ovStart && m.index < nextOverlay,
      '결제 링크가 donateOverlay 밖에 노출되어 있으면 안 됨');
  }
});

test('openDonateOverlay 호출부는 숨겨진 두 버튼뿐', () => {
  const calls = [...src.matchAll(/openDonateOverlay\(\)/g)];
  // 함수 정의 1 + 호출 2 (supportTopBtn, jshopSupportBtn) = 3 이하로 유지
  assert.ok(calls.length <= 3,
    `openDonateOverlay 호출 지점이 늘어남(${calls.length}) — 새 진입점이 생겼는지 확인 필요`);
});

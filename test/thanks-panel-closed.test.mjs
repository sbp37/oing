// 후원자 감사 패널("🐾 함께해주신 분") 비노출 상태 검증 (node --test, 정적 검사)
//
// 후원자 닉네임 공개가 문제될 소지가 있어 랭킹 화면에서 노출을 중단했다.
// 스위치(SHOW_WEEKLY_THANKS) 하나로 껐고, true 로 바꾸면 그대로 원복된다.
// meta/weeklyThanks 저장 데이터와 어드민 입력 기능은 건드리지 않았다.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

test('스위치가 꺼져 있다 (SHOW_WEEKLY_THANKS = false)', () => {
  const m = src.match(/const SHOW_WEEKLY_THANKS = (\w+);/);
  assert.ok(m, 'SHOW_WEEKLY_THANKS 스위치를 찾지 못함');
  assert.equal(m[1], 'false', '후원자 패널이 다시 켜져 있으면 안 됨');
});

test('스위치가 꺼지면 토글 버튼과 패널을 둘 다 숨기고 즉시 빠져나간다', () => {
  const i = src.indexOf('async function renderWeeklyThanks()');
  assert.notEqual(i, -1, 'renderWeeklyThanks 를 찾지 못함');
  const head = src.slice(i, i + 600);
  const guard = head.match(/if \(!SHOW_WEEKLY_THANKS\) \{([^}]*)\}/);
  assert.ok(guard, '스위치 가드가 함수 앞부분에 있어야 함');
  assert.ok(/el\.style\.display = 'none'/.test(guard[1]), '패널을 숨겨야 함');
  assert.ok(/toggle\.style\.display = 'none'/.test(guard[1]), '토글 버튼을 숨겨야 함');
  assert.ok(/return;/.test(guard[1]), '즉시 return 해야 이후 렌더가 안 돎');
  // 가드가 Firestore 조회보다 앞에 있어야 불필요한 읽기도 안 생긴다
  const guardAt = head.indexOf('if (!SHOW_WEEKLY_THANKS)');
  const readAt = head.indexOf("getDoc(doc(db, 'meta', 'weeklyThanks')");
  assert.ok(readAt === -1 || guardAt < readAt, '가드가 Firestore 조회보다 앞에 있어야 함');
});

test('마크업 기본값도 숨김 (스크립트 실행 전 깜빡임 방지)', () => {
  for (const id of ['weeklyThanksToggle', 'weeklyThanksDisplay']) {
    const i = src.indexOf(`id="${id}"`);
    assert.notEqual(i, -1, `#${id} 요소를 찾지 못함`);
    const start = src.lastIndexOf('<', i);
    const end = src.indexOf('>', i);
    assert.ok(/display\s*:\s*none/.test(src.slice(start, end)), `#${id} 기본값이 숨김이어야 함`);
  }
});

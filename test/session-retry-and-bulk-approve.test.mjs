// 2026-08 랭킹 누락 장애 대응 검증 (node --test, 정적 검사)
//
// 장애 사슬: startSession 실패(조용히 무시) → sessionId 없음 → 서버가 NO_SESSION 판정 →
//            판정 v4부터 NO_SESSION = 보류 → 랭킹·주간랭킹에 반영 안 됨.
// 근본 원인(서버 startSession)은 백엔드 저장소 소관이고, 여기서는 두 가지를 고정한다:
//   ① 클라: 세션 생성 실패를 한 번에 포기하지 않고 재시도 + 실패를 콘솔에 남김
//   ② 어드민: 그렇게 보류로 쌓인 "검증 불가" 기록을 한꺼번에 랭킹에 올리는 버튼
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const game = readFileSync(join(root, 'index.html'), 'utf8');
const admin = readFileSync(join(root, 'admin', 'js', 'security.js'), 'utf8');

// ── ① 클라: 세션 생성 재시도 ──
function startSessionBody() {
  const i = game.indexOf('async function _shadowStartSession()');
  assert.notEqual(i, -1, '_shadowStartSession 을 찾지 못함');
  const j = game.indexOf('\n}', i);
  return game.slice(i, j);
}

test('① 세션 생성이 한 번 실패해도 재시도한다', () => {
  const body = startSessionBody();
  const m = body.match(/const DELAYS = \[([^\]]*)\]/);
  assert.ok(m, '재시도 간격(DELAYS) 배열이 있어야 함');
  const delays = m[1].split(',').map(s => Number(s.trim()));
  assert.ok(delays.length >= 2, `재시도가 2회 이상이어야 함 (found ${delays.length})`);
  assert.equal(delays[0], 0, '첫 시도는 지연 없이');
  for (let k = 1; k < delays.length; k++) {
    assert.ok(delays[k] > delays[k - 1], '재시도 간격은 점점 늘어나야 함(백오프)');
  }
});

test('① 성공하면 즉시 빠져나가 불필요한 재호출을 안 한다', () => {
  const body = startSessionBody();
  const okAt = body.indexOf('_shadowSessionId = res.data.sessionId');
  assert.notEqual(okAt, -1, 'sessionId 저장부를 찾지 못함');
  assert.ok(/_shadowSessionId = res\.data\.sessionId; return;/.test(body),
    'sessionId 를 받으면 곧바로 return 해야 함');
});

test('① 재시도를 다 쓰면 조용히 넘기지 않고 콘솔에 남긴다', () => {
  const body = startSessionBody();
  assert.ok(/console\.warn\('세션 시작 실패\(재시도 소진\)/.test(body),
    '최종 실패를 콘솔에 남겨야 원인 추적이 가능함');
  assert.ok(!/\/\* fail-open: 조용히 무시 \*\//.test(body),
    '무조건 조용히 삼키던 옛 catch 가 남아있으면 안 됨');
});

test('① 게임 진행 자체는 막지 않는다 (fail-open 유지)', () => {
  const body = startSessionBody();
  // 실패 경로에서 throw 하지 않아야 startGame 이 중단되지 않는다
  assert.ok(!/throw /.test(body), '세션 실패가 게임을 중단시키면 안 됨');
});

// ── ② 어드민: 검증 불가 보류 일괄 승인 ──
test('② 일괄 승인 대상은 "보류 + 검증 불가"로만 좁혀진다', () => {
  const i = admin.indexOf('function bulkApproveTargets()');
  assert.notEqual(i, -1, 'bulkApproveTargets 를 찾지 못함');
  const body = admin.slice(i, admin.indexOf('\n}', i));
  assert.ok(/decision === 'pending_review'/.test(body), '보류 건만 대상이어야 함');
  assert.ok(/isUnverifiable\(d\)/.test(body), '강한 의심 사유가 붙은 건은 제외해야 함');
});

test('② 확인창 없이 대량 반영되지 않는다', () => {
  const i = admin.indexOf('async function bulkApproveUnverifiable(');
  assert.notEqual(i, -1, 'bulkApproveUnverifiable 를 찾지 못함');
  const body = admin.slice(i, admin.indexOf('\nasync function', i + 10));
  const confirmAt = body.indexOf('confirm(');
  const callAt = body.indexOf("adminApproveScore");
  assert.ok(confirmAt !== -1 && confirmAt < callAt, '서버 호출 전에 confirm 이 있어야 함');
  assert.ok(/if \(!confirm\([\s\S]*?\)\) return;/.test(body), '취소하면 아무것도 안 해야 함');
});

test('② 서버 호출은 순차 처리 (동시 호출로 랭킹 트랜잭션을 때리지 않게)', () => {
  const i = admin.indexOf('async function bulkApproveUnverifiable(');
  const body = admin.slice(i, admin.indexOf('\nasync function', i + 10));
  assert.ok(/for \(let i = 0; i < total; i\+\+\)/.test(body), 'for 루프로 순차 처리해야 함');
  assert.ok(/await httpsCallable\(fns, 'adminApproveScore'\)/.test(body), '각 건을 await 해야 함');
  assert.ok(!/Promise\.all/.test(body), '병렬(Promise.all) 호출이면 안 됨');
});

test('② 개별 실패가 전체를 중단시키지 않고 결과를 요약한다', () => {
  const i = admin.indexOf('async function bulkApproveUnverifiable(');
  const body = admin.slice(i, admin.indexOf('\nasync function', i + 10));
  assert.ok(/catch \(e\) \{[\s\S]*?fails\.push/.test(body), '실패는 모아두고 계속 진행해야 함');
  assert.ok(/반영됨 \$\{ok\}건/.test(body) && /실패 \$\{fails\.length\}건/.test(body),
    '성공·실패 건수를 요약해 보여줘야 함');
});

test('② 대상이 없으면 버튼 자체가 안 그려진다', () => {
  const i = admin.indexOf('function bulkApproveBarHtml(');
  assert.notEqual(i, -1, 'bulkApproveBarHtml 를 찾지 못함');
  const body = admin.slice(i, admin.indexOf('\n}', i));
  assert.ok(/if \(!count\) return '';/.test(body), '대상 0건이면 빈 문자열이어야 함');
});

test('② 버튼이 두 UI 경로(신·구 처리함) 모두에 붙는다', () => {
  const bars = (admin.match(/\$\{bulkApproveBarHtml\(bulkApproveTargets\(\)\.length\)\}/g) || []).length;
  assert.equal(bars, 2, `검증 불가 묶음 두 곳 모두에 버튼이 있어야 함 (found ${bars})`);
  assert.ok(/bindBulkApprove\(\);/.test(admin), '렌더 후 버튼 이벤트를 연결해야 함');
});

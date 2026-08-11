#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// inspect-toss-build.mjs — 배포된 뉴오잉(토스/스토어용) 빌드의 구조를 뽑아 본다.
//
// 이 작업 환경에서는 oing-toss.vercel.app 으로 나가는 접속이 프록시에 막혀 있어
// 직접 열어볼 수 없다. GitHub Actions 러너는 나갈 수 있으므로 여기서 받아
// "평가에 필요한 구조 정보"만 요약해 출력한다.
//
// ⚠️ 이 저장소는 공개라 로그도 공개된다. 소스 전문을 통째로 찍지 않고
//    구조·수치·문구 등 평가에 필요한 요약만 남긴다.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET = process.env.TARGET_URL || 'https://oing-toss.vercel.app';
const MAX_ASSET = 6;

const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
};

const uniq = (a) => [...new Set(a)];
const show = (label, arr, n = 40) => {
  console.log(`  ${label} (${arr.length}개)`);
  for (const v of arr.slice(0, n)) console.log(`    · ${v}`);
  if (arr.length > n) console.log(`    … 외 ${arr.length - n}개`);
};

async function main() {
  console.log(`대상: ${TARGET}\n`);
  const root = await get(TARGET);
  console.log(`══ 0. 응답 ══`);
  console.log(`  HTTP ${root.status} · ${root.type} · ${root.text.length.toLocaleString()} bytes`);
  const html = root.text;

  // ── 문서 기본 ──
  console.log(`\n══ 1. 문서 기본 ══`);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  console.log(`  title: ${t ? t[1].trim() : '(없음)'}`);
  const vp = html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i);
  console.log(`  viewport: ${vp ? vp[0] : '(없음 — 모바일 대응 확인 필요)'}`);
  for (const k of ['theme-color', 'apple-mobile-web-app-capable', 'description', 'manifest']) {
    const m = html.match(new RegExp(`<(?:meta|link)[^>]+(?:name|rel)=["']${k}["'][^>]*>`, 'i'));
    console.log(`  ${k}: ${m ? '있음' : '없음'}`);
  }
  console.log(`  SPA 여부(빈 #root/#app): ${/<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html) ? '예 (렌더는 JS)' : '아니오/불명'}`);

  // ── 링크된 자원 ──
  const scripts = uniq([...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]));
  const styles = uniq([...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]));
  console.log(`\n══ 2. 번들 ══`);
  show('script', scripts, 10);
  show('css', styles, 10);

  // 실제 내용은 번들에 있다 — 받아서 합친다
  let bundle = html;
  const abs = (u) => (u.startsWith('http') ? u : new URL(u, TARGET).href);
  for (const u of [...scripts, ...styles].slice(0, MAX_ASSET)) {
    try {
      const r = await get(abs(u));
      console.log(`  받음: ${u.split('/').pop()} — ${r.text.length.toLocaleString()} bytes (HTTP ${r.status})`);
      bundle += '\n' + r.text;
    } catch (e) { console.log(`  실패: ${u} — ${e.message}`); }
  }
  console.log(`  합계 분석 대상: ${bundle.length.toLocaleString()} bytes`);

  // ── 한국어 문구(고양이 멘트·버튼·안내) ──
  console.log(`\n══ 3. 화면 문구 (톤·다양성 판단용) ══`);
  const ko = uniq(
    [...bundle.matchAll(/["'`]([^"'`\n]*[가-힣][^"'`\n]{1,40})["'`]/g)]
      .map((m) => m[1].trim())
      .filter((s) => s.length >= 2 && !/^[\s.,!?~]*$/.test(s)),
  );
  show('한국어 문자열', ko, 90);

  // ── 게임 상수 (난이도 곡선·보상 루프 판단용) ──
  console.log(`\n══ 4. 게임 상수 ══`);
  const keys = ['stage', 'Stage', 'STAGE', 'level', 'LEVEL', 'combo', 'COMBO', 'timeLimit', 'TIME',
    'hint', 'HINT', 'score', 'SCORE', 'rows', 'cols', 'GRID', 'size', 'target', 'goal', 'star'];
  const consts = uniq(
    [...bundle.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9]+(?:\.[0-9]+)?|\[[^\]]{0,160}\]|\{[^}]{0,160}\})/g)]
      .filter((m) => keys.some((k) => m[1].includes(k)))
      .map((m) => `${m[1]} = ${m[2].replace(/\s+/g, ' ').slice(0, 120)}`),
  );
  show('상수', consts, 50);

  // 객체 리터럴 안의 스테이지 파라미터 흔적
  const params = uniq(
    [...bundle.matchAll(/\b(rows|cols|size|timeLimit|timeLimitSec|hints|maxHints|target|goal|clearRate|stars?)\s*:\s*([0-9]+)/g)]
      .map((m) => `${m[1]}: ${m[2]}`),
  );
  show('스테이지/보드 파라미터', params, 40);

  // ── UI 구조 ──
  console.log(`\n══ 5. UI 구조 ══`);
  show('id', uniq([...bundle.matchAll(/\bid=["']([\w-]+)["']/g)].map((m) => m[1])), 40);
  const cls = uniq([...bundle.matchAll(/class(?:Name)?=["']([^"']+)["']/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean));
  show('class', cls, 60);

  // ── 시각/사운드 ──
  console.log(`\n══ 6. 시각·사운드 ══`);
  const fonts = uniq([...bundle.matchAll(/font-size\s*:\s*([\d.]+(?:px|rem|em|vw|vmin))/g)].map((m) => m[1]));
  show('font-size 값', fonts, 30);
  const colors = uniq([...bundle.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]));
  console.log(`  색상 종류: ${colors.length}개 ${colors.slice(0, 18).join(' ')}`);
  const anim = uniq([...bundle.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  show('@keyframes(연출)', anim, 30);
  const audio = uniq([...bundle.matchAll(/([\w./-]+\.(?:mp3|wav|ogg|m4a))/g)].map((m) => m[1]));
  show('사운드 파일', audio, 20);
  console.log(`  WebAudio 사용: ${/AudioContext|webkitAudioContext/.test(bundle) ? '예' : '아니오'}`);
  console.log(`  진동(vibrate): ${/navigator\.vibrate/.test(bundle) ? '예' : '아니오'}`);

  // ── 입력 처리 (드래그 안정성) ──
  console.log(`\n══ 7. 입력 처리 ══`);
  for (const [label, re] of [
    ['pointer 이벤트', /pointerdown|pointermove|pointerup/],
    ['touch 이벤트', /touchstart|touchmove|touchend/],
    ['mouse 이벤트', /mousedown|mousemove|mouseup/],
    ['setPointerCapture', /setPointerCapture/],
    ['touch-action CSS', /touch-action/],
    ['user-select 방지', /user-select\s*:\s*none/],
    ['preventDefault', /preventDefault/],
    ['passive:false', /passive\s*:\s*false/],
    ['elementFromPoint', /elementFromPoint/],
    ['requestAnimationFrame', /requestAnimationFrame/],
  ]) console.log(`  ${label}: ${re.test(bundle) ? '있음' : '없음'}`);

  // ── 토스/스토어 준비도 ──
  console.log(`\n══ 8. 토스/스토어 준비도 ══`);
  for (const [label, re] of [
    ['앱인토스 SDK 흔적', /apps-in-toss|appsInToss|TossSDK|tossapp/i],
    ['리더보드', /leaderboard|리더보드|랭킹/i],
    ['광고', /rewarded|adUnit|showAd|광고/i],
    ['햅틱', /haptic|진동/i],
    ['safe-area', /safe-area-inset/],
    ['풀스크린 대응', /100dvh|100svh|-webkit-fill-available/],
    ['Firebase 잔재', /firebase|firestore/i],
    ['튜토리얼', /tutorial|튜토리얼|따라해|해보세요/i],
    ['스테이지 클리어 연출', /clear|클리어/i],
    ['별점/보상', /star|별|보상|reward/i],
  ]) console.log(`  ${label}: ${re.test(bundle) ? '있음' : '없음'}`);
}

main().catch((e) => { console.error('FAIL —', e); process.exit(1); });

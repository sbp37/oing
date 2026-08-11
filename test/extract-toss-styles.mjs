#!/usr/bin/env node
// 뉴오잉 배포본에서 "패치 작성에 필요한 선택자·선언"만 좁혀 뽑는다.
//
// 목적: 저장소 접근이 안 되는 상태에서 드롭인 CSS 패치를 쓰려면 실제 선택자와
//       현재 값(배경/색/폰트)을 알아야 한다. 소스 전문은 찍지 않고 관련 규칙만.
// ⚠️ 공개 저장소이므로 필요한 범위만 출력한다. 대상은 이미 공개 URL.

const TARGET = process.env.TARGET_URL || 'https://oing-toss.vercel.app';

const get = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } });
  return r.text();
};

// CSS 를 아주 단순하게 "선택자 { 선언 }" 단위로 자른다(@media 등은 통째로 넘어감)
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ sel: m[1].replace(/\s+/g, ' ').trim(), body: m[2].replace(/\s+/g, ' ').trim() });
  return out;
}

const dump = (title, list, n = 60) => {
  console.log(`\n──── ${title} (${list.length}건) ────`);
  for (const r of list.slice(0, n)) console.log(`  ${r.sel}\n      { ${r.body.slice(0, 260)} }`);
  if (list.length > n) console.log(`  … 외 ${list.length - n}건`);
};

async function main() {
  const html = await get(TARGET);
  const hrefs = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]);
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  let css = inline.join('\n');
  for (const h of hrefs) {
    const u = h.startsWith('http') ? h : new URL(h, TARGET).href;
    css += '\n' + (await get(u));
    console.log(`받음: ${u.split('/').pop()}`);
  }
  console.log(`CSS 총 ${css.length.toLocaleString()} bytes / 인라인 ${inline.length}개 · 외부 ${hrefs.length}개`);

  const all = rules(css);
  console.log(`규칙 ${all.length}개`);

  // ① 보드/타일 — STEP 1 패치 대상
  const tileWords = /(tile|cell|board|number|num|digit|slot|empty|selected|marquee|sum-)/i;
  dump('보드·타일 관련 규칙', all.filter((r) => tileWords.test(r.sel) && /(background|color|box-shadow|border|font)/.test(r.body)), 70);

  // ② 말풍선 — STEP 2
  dump('말풍선·고양이 대사', all.filter((r) => /(bubble|speech|cat-line|callout|toast|talk|say)/i.test(r.sel)), 30);

  // ③ 아이템 버튼 — STEP 3
  dump('아이템 버튼', all.filter((r) => /(item|hint|shuffle|bomb|clock|locked|depleted|소진)/i.test(r.sel)), 30);

  // ④ HUD/보드 레이아웃 비율 — STEP 4
  dump('HUD·레이아웃(높이/비율)', all.filter((r) => /(hud|play-screen|board-frame|app-shell|screen-play|feedback-rail)/i.test(r.sel) && /(height|flex|grid|padding|gap|aspect)/.test(r.body)), 40);

  // ⑤ 10px 미만 폰트 — STEP 6-A
  const small = all.filter((r) => {
    const m = [...r.body.matchAll(/font-size\s*:\s*([\d.]+)px/g)];
    return m.some((x) => parseFloat(x[1]) < 11);
  });
  dump('11px 미만 font-size 를 가진 규칙', small, 60);

  // ⑥ CSS 변수(토큰) 존재 여부
  const vars = [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
  const uniq = [...new Set(vars)];
  console.log(`\n──── CSS 변수 ${uniq.length}개 ────`);
  console.log('  ' + uniq.slice(0, 80).join('  '));
}

main().catch((e) => { console.error('FAIL —', e); process.exit(1); });

#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// guard-no-direct-score-write.mjs  —  targets Incident B
//
// Incident B: a pre-PR3 *direct client score-write* (addScore / addWeeklyScore /
//   setDoc rankings|weekly_rankings with score>0) got revived in a LIVE code path
//   (e.g. a stale branch merge re-added it to the game-over / submit flow).
//   After PR3 the ONLY legitimate way a real score reaches rankings/weekly is the
//   submitScore Cloud Function (Admin SDK). The client must never write a score.
//
// What this guard does: scans index.html and FAILS (exit 1) if a direct client
//   score-write appears anywhere that is NOT a known-legitimate occurrence.
//
// Deliberately NOT flagged (calibrated against the current index.html):
//   1. The score:0 new-nickname create — it does `setDoc(docRef, { score: 0 })`
//      via a `docRef`/`payload` variable, so it never matches the inline
//      `setDoc(doc(db,'rankings',…),{score:…})` shape, and score:0 is excluded anyway.
//   2. Comments — block and line comments are stripped before scanning.
//   3. Any `async function addScore/addWeeklyScore` DEFINITION (only *calls* are a
//      revival signal). Those helpers have since been deleted, but this keeps the
//      guard correct if a definition is ever reintroduced without a live call.
//
// (The old dead legacy rename path that used to be allow-listed here was removed.)
//
// No dependencies. Run: node test/guard-no-direct-score-write.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Defaults to ../index.html. Pass a path arg to scan a different file (used by tests).
const FILE = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'index.html');

// ── Allow-list of KNOWN-acceptable direct-write occurrences ──────────────────
// Previously this listed the dead legacy client-side rename flow (behind
// `if (RENAME_V2_ENABLED){…return;}`, unreachable while RENAME_V2 is ON). That
// dead block AND the addScore/addWeeklyScore helper definitions were DELETED, so
// nothing is allow-listed anymore: ANY direct client score-write now fails the
// guard. If a legitimate exception ever reappears, add its exact trimmed line
// here with a `max` count and a justification.
const ALLOW = [];

// ── Strip comments while preserving line numbers ─────────────────────────────
function stripComments(src) {
  // Block comments -> blanks (keep newlines so line numbers stay correct).
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Line comments -> removed (but keep `://` in URLs intact via lookbehind).
  return noBlock
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

// ── Forbidden-pattern detectors ──────────────────────────────────────────────
const CALL_RE = /\b(addScore|addWeeklyScore)\s*\(/;      // a CALL to a legacy helper
const DEF_RE = /function\s+(addScore|addWeeklyScore)\b/; // its definition (allowed)

// Inline direct writes: setDoc(doc(db,'rankings'|'weekly_rankings', …), { … score: X … })
// `[\s\S]{0,300}?` lets the object span onto following lines; score:0 is excluded
// (the legitimate new-nickname create). Weekly has NO legitimate inline write.
const RANK_WRITE_RE =
  /setDoc\s*\(\s*doc\(\s*db\s*,\s*['"]rankings['"][\s\S]{0,300}?score\s*:\s*(?!0[\s,}])/g;
const WEEK_WRITE_RE =
  /setDoc\s*\(\s*doc\(\s*db\s*,\s*['"]weekly_rankings['"][\s\S]{0,300}?score\s*:/g;

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}
function trimmedLineAt(lines, lineNo) {
  return (lines[lineNo - 1] || '').trim();
}

function main() {
  let raw;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch (e) {
    console.error(`GUARD ERROR: cannot read ${FILE}: ${e.message}`);
    process.exit(2);
  }
  const stripped = stripComments(raw);
  const lines = stripped.split('\n');

  const violations = []; // { line, text, kind }

  // (1) legacy helper CALLS (single-line)
  lines.forEach((line, i) => {
    if (CALL_RE.test(line) && !DEF_RE.test(line)) {
      violations.push({ line: i + 1, text: line.trim(), kind: 'legacy-helper-call' });
    }
  });

  // (2) inline direct rankings score-write (may span lines)
  for (const m of stripped.matchAll(RANK_WRITE_RE)) {
    const ln = lineOf(stripped, m.index);
    violations.push({ line: ln, text: trimmedLineAt(lines, ln), kind: 'inline-rankings-write' });
  }
  // (3) inline direct weekly score-write (may span lines)
  for (const m of stripped.matchAll(WEEK_WRITE_RE)) {
    const ln = lineOf(stripped, m.index);
    violations.push({ line: ln, text: trimmedLineAt(lines, ln), kind: 'inline-weekly-write' });
  }

  // ── Reconcile against the allow-list ───────────────────────────────────────
  const seen = new Map(); // allow.text -> count
  const failures = [];
  for (const v of violations) {
    const entry = ALLOW.find((a) => a.text === v.text);
    if (!entry) {
      failures.push(v);
      continue;
    }
    const n = (seen.get(entry.text) || 0) + 1;
    seen.set(entry.text, n);
    if (n > entry.max) failures.push(v); // an extra copy => revived somewhere new
  }

  if (failures.length === 0) {
    console.log(
      `guard-no-direct-score-write: OK — no direct client score-write in a live path ` +
        `(${violations.length} known/allow-listed occurrence(s) accounted for).`,
    );
    process.exit(0);
  }

  console.error('guard-no-direct-score-write: FAIL — direct client score-write detected (Incident B).');
  console.error('After PR3, only the submitScore Cloud Function may write a score. Remove these:');
  const name = basename(FILE);
  for (const f of failures) {
    console.error(`  ${name}:${f.line}  [${f.kind}]  ${f.text}`);
  }
  console.error(
    '\nIf an occurrence is genuinely dead/legitimate, add its exact trimmed line to ALLOW ' +
      'in test/guard-no-direct-score-write.mjs with a justification.',
  );
  process.exit(1);
}

main();

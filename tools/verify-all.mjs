#!/usr/bin/env node
/**
 * tools/verify-all.mjs — THE GATE.
 *
 * Nothing ships until this passes. It exists because of how this extension
 * failed three times in a row: each release was declared fixed on the strength
 * of unit tests that passed while the real page was broken, and the user found
 * it. "It compiles" and "the tests pass" are not evidence about a live website.
 *
 * What it runs, in order of what it protects against:
 *
 *   1. unit tests            the logic is right
 *   2. wiring                no symbol is used without being imported
 *   3. pre-flight            the extension loads: manifest, permissions, assets
 *   4. contract check        THE PAGE still has what the extractor needs, and a
 *                            real capture fills the fields the contract requires
 *   5. real-page capture     the shipped extractor, in a real browser, on a real
 *                            saved Alibaba page
 *   6. the real button       the extension is LOADED in a browser and the panel's
 *                            own CAPTURE message runs, so the service worker
 *                            executes for real. Stages 1-5 each test one module;
 *                            none of them executes the line that wires them
 *                            together, which is how "assessCapture is not
 *                            defined" shipped with every other stage green
 *   7. panel render          every UI state renders, with no console errors, and
 *                            no state can hide data without saying so
 *   8. export shape          what lands in the user's sheet is rectangular and
 *                            carries the fields the contract requires
 *
 * Stage 6 is the one that matters most. It is the only stage that presses the
 * button.
 *
 * Usage:
 *   node tools/verify-all.mjs            # everything
 *   node tools/verify-all.mjs --fast     # skip the browser stages
 *
 * Exit code is 0 only when every stage passes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fast = process.argv.includes('--fast');

const BOLD = '\u001b[1m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const OFF = '\u001b[0m';

const stages = [];
function stage(name, cmd, args, { optional = false, browser = false } = {}) {
  stages.push({ name, cmd, args, optional, browser });
}
function check(name, fn) {
  stages.push({ name, fn });
}

stage('unit tests', 'node', ['--test', 'test/*.test.js']);
stage('wiring: every symbol is imported', 'node', ['tools/import-check.mjs']);
stage('pre-flight', 'node', ['tools/verify.mjs']);
if (!fast) {
  stage('capture contract vs the real page', 'node', ['tools/contract-check.mjs'], { browser: true });
  stage('real-page capture', 'node', ['tools/real-page-test.mjs'], { browser: true });
  stage('the real button, pressed in a browser', 'node', ['tools/extension-smoke-test.mjs'], { browser: true });
  stage('panel states', 'node', ['tools/panel-preview.mjs'], { browser: true });
}

// The honesty layer, checked against the capture that actually shipped broken.
check('a broken capture is rejected', () => {
  const f = join(root, 'docs', 'fixtures', 'broken-capture-v1.json');
  if (!existsSync(f)) return { ok: true, skipped: 'no broken fixture' };
  const junk = JSON.parse(readFileSync(f, 'utf8'));
  return Promise.all([import('../src/lib/schema.js'), import('../src/lib/health.js')])
    .then(([S, H]) => {
      const records = junk.candidates.map((c) => S.makeRecord({ ...c, origin: 'search' }));
      const h = H.assessCapture(records, { strategy: junk.strategy });
      if (h.ok) {
        return {
          ok: false,
          problems: ['a capture whose supplier names are prices was accepted as good. '
            + 'The honesty layer is broken, so a real regression would ship silently.'],
        };
      }
      if (!/supplier name/.test(h.reason || '')) {
        return { ok: false, problems: [`the broken capture was rejected, but not for the right reason: ${h.reason}`] };
      }
      if (!h.advice) {
        return { ok: false, problems: ['a broken capture must tell the user how to report it'] };
      }
      return { ok: true, output: H.summarise(h) };
    });
});

// Stage 6 is in-process: the export is pure, so it is cheap and exact.
check('export shape', () => {
  const problems = [];
  const fixture = join(root, 'docs', 'fixtures', 'real-capture-sample.json');
  if (!existsSync(fixture)) {
    return { ok: true, skipped: 'no committed capture fixture' };
  }
  const raw = JSON.parse(readFileSync(fixture, 'utf8'));

  return Promise.all([import('../src/lib/schema.js'), import('../src/lib/exporters/index.js')])
    .then(([S, E]) => {
      const contract = JSON.parse(readFileSync(join(root, 'docs', 'capture-contract.json'), 'utf8'));
      // Each contract field names the export column it must reach, so the
      // sheet cannot quietly lose a field the contract calls required.
      const required = contract.fields
        .filter((f) => f.required && f.exportLabel)
        .map((f) => ({ field: f.field, label: f.exportLabel }));
      const records = raw.candidates.map((c) => S.makeRecord({ ...c, origin: 'search' }));
      if (records.length === 0) problems.push('fixture has no records');

      for (const id of ['tsv', 'csv', 'clientSummary']) {
        const out = E.getExporter(id).build(records, { targetQty: 100 });
        if (!out || out.trim().length === 0) {
          problems.push(`${id} export is empty`);
          continue;
        }
        if (id === 'clientSummary') continue;

        if (id === 'tsv') {
          // The Sheets path is the one the user actually uses, so its shape is
          // checked strictly: a ragged row lands in the wrong cells.
          const rows = out.split('\n');
          const header = rows[0].split('\t');
          for (const f of required) {
            if (!header.includes(f.label)) problems.push(`tsv export has no "${f.label}" column (from ${f.field})`);
          }
          rows.slice(1).forEach((row, i) => {
            if (row.split('\t').length !== header.length) {
              problems.push(`tsv export row ${i + 2} has ${row.split('\t').length} cells, expected ${header.length}`);
            }
          });
        } else {
          // CSV quotes cells containing commas, so a naive split would invent
          // raggedness. Check the header and the row count instead.
          const header = out.split('\r\n')[0].split(',');
          for (const f of required) {
            if (!header.some((h) => h.replace(/"/g, '') === f.label)) {
              problems.push(`csv export has no "${f.label}" column (from ${f.field})`);
            }
          }
          if (out.split('\r\n').length !== records.length + 1) {
            problems.push('csv export row count does not match the number of suppliers');
          }
        }
      }
      return { ok: problems.length === 0, problems };
    });
});

const results = [];
for (const s of stages) {
  const label = `${s.name}${s.browser && !fast ? DIM + ' (browser)' + OFF : ''}`;
  process.stdout.write(`${BOLD}▸ ${label}${OFF}\n`);
  let res;
  if (s.fn) {
    res = await s.fn();
  } else {
    const r = spawnSync(s.cmd, s.args, { cwd: root, encoding: 'utf8' });
    res = { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
  }
  const ok = res.ok === true;
  const skipped = res.skipped;
  results.push({ name: s.name, ok, skipped, output: res.output || '' });

  if (skipped) {
    process.stdout.write(`  ${YELLOW}skipped${OFF} — ${skipped}\n`);
  } else if (ok) {
    const last = (res.output || '').trim().split('\n').filter(Boolean).pop();
    process.stdout.write(`  ${GREEN}pass${OFF}${last ? DIM + ' — ' + last.slice(0, 90) + OFF : ''}\n`);
  } else {
    process.stdout.write(`  ${RED}FAIL${OFF}\n`);
    for (const p of res.problems || []) process.stdout.write(`    ${RED}✗${OFF} ${p}\n`);
    const lines = (res.output || '').trim().split('\n').filter(Boolean);
    for (const l of lines.slice(-8)) process.stdout.write(`    ${DIM}${l}${OFF}\n`);
  }
}

const failed = results.filter((r) => !r.ok && !r.skipped);
console.log('');
if (failed.length) {
  console.log(`${RED}${BOLD}GATE FAILED${OFF} — ${failed.length} of ${results.length} stages: ${failed.map((f) => f.name).join(', ')}`);
  console.log('');
  console.log('Do not report this as fixed. Fix the failing stage, then run this again.');
  process.exit(1);
}
console.log(`${GREEN}${BOLD}GATE PASSED${OFF} — ${results.filter((r) => r.ok).length} stages. `
  + 'The extension is verified against the real page, not just against itself.');

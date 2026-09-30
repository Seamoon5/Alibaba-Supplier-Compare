#!/usr/bin/env node
/**
 * tools/import-check.mjs — find symbols that are used but never brought in.
 *
 * This is the smallest possible guard against the worst bug this project has
 * had: `assessCapture is not defined`. Every unit test passed, every gate stage
 * passed, the extension loaded cleanly, and pressing the button threw — because
 * the code called a function it had never imported, and nothing was executing
 * that line.
 *
 * Nothing else in the toolchain can see it:
 *   - `node --check` parses syntax, not names
 *   - unit tests cover the modules, not the code that wires them together
 *   - a dynamic import cannot catch it either: a missing NAME only fails when it
 *     is called, not when its module loads
 *
 * So: read each source file's imports and declarations, then look for a call to
 * a name it cannot account for. Comments and string literals are blanked first,
 * otherwise every word in a doc comment reads as a call.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(root, 'src');

/** Names that exist without being imported. */
const GLOBALS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol',
  'Proxy', 'Reflect', 'BigInt', 'Intl', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
  'fetch', 'Function', 'chrome', 'globalThis', 'window', 'document', 'AbortController', 'Headers',
  'Response', 'Request', 'crypto', 'performance', 'WeakRef', 'alert', 'confirm', 'prompt',
  'Blob', 'File', 'FileReader', 'FormData', 'ClipboardItem', 'Notification', 'CustomEvent',
  'Event', 'EventTarget', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'matchMedia', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
]);

/** Words that look like a call but never are. */
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'class', 'new',
  'await', 'yield', 'super', 'this', 'else', 'do', 'try', 'finally', 'case', 'delete', 'void',
  'in', 'of', 'instanceof', 'throw', 'with', 'async', 'await', 'import', 'export', 'default',
  'const', 'let', 'var', 'get', 'set', 'static', 'extends', 'then', 'constructor',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Blank out comments, string literals, template literals and regex literals,
 * keeping every newline so line numbers still line up in a report.
 *
 * A character scanner rather than a pile of regexes, because a regex cannot
 * handle a nested `${ {a:1} }` or know that `\b(` is a regex and not a call.
 * Getting this wrong produces false positives, and a checker that cries wolf
 * gets switched off.
 */
function stripNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // Where a `/` starts a regex literal rather than a division.
  const REGEX_OK_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return']);

  let i = 0;
  let prevSignificant = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      prevSignificant = 'x';
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '$' && src[j + 1] === '{') {
          // keep the interpolated code, skip the expression
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            if (depth === 0) break;
            j++;
          }
        } else j++;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      prevSignificant = 'x';
      continue;
    }
    if (c === '/' && (prevSignificant === '' || REGEX_OK_BEFORE.has(prevSignificant))) {
      // A regex literal. Skip to the unescaped closing slash, keeping flags.
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break; // not a regex after all
        j++;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
      prevSignificant = 'x';
      continue;
    }

    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join('');
}

/** Everything the file imports or declares. Read from the RAW source. */
function collect(raw) {
  const known = new Set();

  // import { a, b as c } from '...'   /   import x, { a } from '...'
  for (const m of raw.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) known.add(name);
      }
    }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(def)) known.add(def);
  }
  // export { a, b } / export const x / export function f / export class C
  for (const m of raw.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    known.add(m[1]);
  }
  for (const m of raw.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) known.add(name);
    }
  }

  // declarations and parameters, anywhere in the file
  for (const m of raw.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  for (const m of raw.matchAll(/\b(?:const|let|var)\s*\{([\s\S]*?)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) known.add(name);
    }
  }
  for (const m of raw.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  for (const m of raw.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  // arrow-function parameters, and single-argument arrows without parentheses
  for (const m of raw.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) known.add(name);
    }
  }
  for (const m of raw.matchAll(/(?:^|[=(,{;\s])([A-Za-z_$][\w$]*)\s*=>/gm)) known.add(m[1]);
  // object-literal shorthand methods: `build(records, settings) {`
  for (const m of raw.matchAll(/(?:^|[{,]\s*)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) known.add(m[1]);

  return known;
}

const files = walk(SRC);
const problems = [];
let callSites = 0;

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const known = collect(raw);
  for (const name of GLOBALS) known.add(name);
  const code = stripNonCode(raw);

  const seen = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (NOT_A_CALL.has(name)) continue;
    callSites++;
    if (known.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const line = code.slice(0, m.index).split('\n').length;
    problems.push(`${relative(root, file)}:${line}  "${name}" is called but never imported or declared`);
  }

}

if (problems.length) {
  console.log(`import-check FAILED — ${problems.length} problem(s) across ${files.length} files:`);
  for (const p of problems) console.log('  ✗', p);
  console.log('');
  console.log('A name that is used but never imported fails at the moment it is CALLED,');
  console.log('which is why tests over the other modules do not catch it. Add the import.');
  process.exit(1);
}

console.log(`import-check: ${files.length} files, ${callSites} call sites, every name imported or declared`);

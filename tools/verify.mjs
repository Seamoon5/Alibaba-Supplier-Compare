/**
 * tools/verify.mjs — pre-flight checks that would otherwise only surface as a
 * Chrome Web Store review failure or a broken install.
 *
 * Run: node tools/verify.mjs
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

// ------------------------------------------------------------------ manifest

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
} catch (err) {
  console.error('manifest.json is not valid JSON:', err.message);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');

// A web_accessible_resources entry that does not exist is a hard load error.
for (const [size, path] of Object.entries(manifest.icons || {})) {
  if (!existsSync(join(root, path))) fail(`icons.${size} points at a missing file: ${path}`);
}
for (const [size, path] of Object.entries(manifest.action?.default_icon || {})) {
  if (!existsSync(join(root, path))) fail(`action.default_icon.${size} missing: ${path}`);
}
const sidePanel = manifest.side_panel?.default_path;
if (!sidePanel) fail('side_panel.default_path is required for the panel to exist');
else if (!existsSync(join(root, sidePanel))) fail(`side_panel.default_path missing: ${sidePanel}`);

const sw = manifest.background?.service_worker;
if (!existsSync(join(root, sw || ''))) fail(`background.service_worker missing: ${sw}`);

// ------------------------------------------------- permission expectations

const perms = manifest.permissions || [];
const EXPECTED = ['storage', 'scripting', 'sidePanel'];
for (const p of EXPECTED) if (!perms.includes(p)) fail(`expected permission missing: ${p}`);

const EXTRA = perms.filter((p) => !EXPECTED.includes(p));
if (EXTRA.length) notes.push(`extra permissions present (review may question these): ${EXTRA.join(', ')}`);

/**
 * Host access must be scoped to Alibaba and nothing else.
 *
 * activeTab alone turned out not to be enough: a one-shot grant from the
 * toolbar click does not survive a navigation, so the in-panel Re-scan button
 * could not read the tab URL and could not inject into the page at all. That
 * made the most-used control silently broken on exactly the pages the tool
 * exists for. A host permission is the honest fix; a blanket one is not.
 */
const hosts = manifest.host_permissions || [];
if (hosts.length === 0) {
  fail('no host_permissions: Re-scan cannot read the tab URL or inject after a navigation');
}
const ALIBABA_HOST = /^(\*|https?):\/\/(\*\.)?alibaba\.com\/\*$/;
for (const h of hosts) {
  if (!ALIBABA_HOST.test(h)) {
    fail(`host permission is not scoped to alibaba.com: ${h}`);
  }
}
if (hosts.includes('<all_urls>') || hosts.includes('*://*/*')) {
  fail('host permissions must never be wildcard-wide');
}

// "tabs" would let the extension read the URL of every site the user visits.
if (perms.includes('tabs')) {
  fail('permission "tabs" is not needed once host_permissions is scoped to alibaba.com');
}
for (const p of ['webRequest', 'declarativeNetRequest', 'cookies', 'history', 'bookmarks']) {
  if (perms.includes(p)) fail(`permission "${p}" is broad and should not be requested: ${p}`);
}

if (!manifest.background?.type) {
  notes.push('background.service_worker has no "type": "module" but the code uses import');
}
if (!manifest.minimum_chrome_version) {
  notes.push('no minimum_chrome_version declared; the side panel needs Chrome 116+');
}

// ------------------------------------------------------------ module graph

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
let checked = 0;
for (const file of walk(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) {
      fail(`${file.replace(root + '/', '')} imports a bare specifier "${spec}" — extensions have no node_modules`);
      continue;
    }
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      fail(`${file.replace(root + '/', '')} imports "${spec}" which does not exist`);
    }
    checked++;
  }
}
notes.push(`${checked} relative imports resolved`);

// ------------------------------------------------------------- safety scan

const BANNED = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/innerHTML\s*=\s*[^;]*document\.body\.innerHTML/, 'body.innerHTML assignment'],
  [/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org|www\.alibaba\.com|.*\.alibaba\.com|.*github\.com|githubusercontent)[^\s'"`)]*/g, 'external URL'],
];

for (const file of walk(join(root, 'src'))) {
  const rel = file.replace(root + '/', '');
  const src = readFileSync(file, 'utf8');
  for (const [re, label] of BANNED) {
    if (re.test(src)) fail(`${rel} contains ${label}`);
  }
  // Remote code execution is a hard store rejection.
  if (/importScripts\s*\(/.test(src) || /import\s*\(\s*['"]http/.test(src)) {
    fail(`${rel} loads remote code`);
  }
}

// A manifest may not use the MV2 background page or remote code CSP.
const csp = manifest.content_security_policy;
if (csp?.extension_pages && /https?:/.test(csp.extension_pages)) {
  fail('content_security_policy permits remote code');
}

// -------------------------------------------------------------------- icons

for (const size of [16, 32, 48, 128]) {
  const p = join(root, `icons/icon${size}.png`);
  if (!existsSync(p)) { fail(`missing icons/icon${size}.png`); continue; }
  const buf = readFileSync(p);
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) { fail(`icons/icon${size}.png is not a PNG`); continue; }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== size || h !== size) fail(`icons/icon${size}.png is ${w}x${h}, expected ${size}x${size}`);
}

// ------------------------------------------------------------------ report

console.log('manifest   : v%s, permissions [%s]', manifest.manifest_version, perms.join(', '));
console.log('host access: %s', hosts.join(', ') || 'none');
for (const n of notes) console.log('note       :', n);
if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log('\nall pre-flight checks passed');

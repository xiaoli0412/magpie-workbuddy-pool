// Checks the page package is complete and loadable: every file index.html
// names exists, every script parses, and nothing inline would be refused by
// the sandboxed frame magpie serves a page in (no inline script, no
// inline style, no external origin).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'page');
const fail = [];
const ok = (c, m) => c || fail.push(m);

const html = readFileSync(join(PAGE, 'index.html'), 'utf8');

// 1. the files the page names
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (ref.startsWith('_magpie/')) continue; // served by magpie itself
  ok(existsSync(join(PAGE, ref)), `index.html names a missing file: ${ref}`);
}
ok(refs.includes('_magpie/bridge.js'), 'the page loads magpie\'s bridge');
ok(refs.includes('data.js'), 'the page loads the generated snapshot');
ok(refs.includes('view.js') && refs.includes('app.js'), 'the page loads its own logic');
ok(refs.indexOf('data.js') < refs.indexOf('app.js'), 'data.js loads before app.js');

// 2. scripts parse (nothing runs)
for (const f of ['data.js', 'view.js', 'app.js']) {
  try {
    new Function(readFileSync(join(PAGE, f), 'utf8'));
  } catch (e) {
    fail.push(`${f} does not parse: ${e.message}`);
  }
}

// 3. the sandbox's rules: no inline script, no inline style, no outside origin
ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'index.html has no inline script');
ok(!/\sstyle="/i.test(html), 'index.html has no inline style attribute');
ok(!/(src|href)="https?:\/\//i.test(html), 'index.html loads nothing from another origin');
ok(!/<style[\s>]/i.test(html), 'index.html has no <style> block');

// 4. the manifest points at the page and asks for nothing
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
ok(pkg.magpie?.page?.file === 'page/index.html', 'manifest page.file is page/index.html');
ok(existsSync(join(ROOT, pkg.magpie.page.file)), 'manifest page.file exists');
ok(Array.isArray(pkg.magpie.permissions) && pkg.magpie.permissions.length === 0, 'the page asks for no permission');
ok(pkg.keywords.includes('magpie-plugin'), 'manifest carries the magpie-plugin keyword');

// 5. plugin entry exports a function magpie can call
const entry = await import(join(ROOT, 'index.mjs'));
ok(typeof entry.default === 'function', 'index.mjs default export is a function');
ok(typeof entry.workbuddyPool === 'function', 'index.mjs exports workbuddyPool');

if (fail.length) {
  console.error('FAIL');
  for (const f of fail) console.error(' -', f);
  process.exit(1);
}
console.log(`PASS  page package (${refs.length} references, 3 scripts, 0 permissions)`);

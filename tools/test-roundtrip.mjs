// Exercises the page's import path exactly as magpie runs it: an import is
// staged in the plugin's options (which is what magpie.options.set writes),
// then the plugin is loaded, and it must take the work, clear the option, and
// record what it did.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, AUTH_FILE, STATE_FILE, POOL_DIR } from '../lib/pools.mjs';
import { PLUGINS_FILE, entryOf, pendingOf } from '../lib/options.mjs';

const fail = [];
const ok = (c, m) => c || fail.push(m);

// 1. the pool the page would be handed: the same ten accounts, already on disk
const poolFile = join(POOL_DIR, 'cn-codebuddy-20261027.json');
const other = join(POOL_DIR, 'wb852-20261027.json');
ok(existsSync(poolFile) && existsSync(other), 'the pool files are in place');
const text = `[${readFileSync(poolFile, 'utf8').replace(/^\s*\[|\]\s*$/g, '')},${readFileSync(other, 'utf8').replace(/^\s*\[|\]\s*$/g, '')}]`;

// 2. stage it the way the page does (POST /api/plugin-pages/options)
const backup = join(CONFIG_DIR, 'plugins.json.pool-test.bak');
copyFileSync(PLUGINS_FILE, backup);
const found = entryOf();
ok(found.index >= 0, 'the plugin is registered in plugins.json');
const plugins = found.data;
const entry = plugins.plugins[found.index];
entry.options = { ...(entry.options || {}), pendingImport: { name: 'page-test.json', text, at: Date.now() } };
writeFileSync(PLUGINS_FILE, JSON.stringify(plugins, null, 2), 'utf8');

ok(pendingOf() !== null, 'the staged import is readable back');

// 3. load the plugin as magpie does
const before = readFileSync(AUTH_FILE, 'utf8');
const mod = await import('../index.mjs');
const hooks = await mod.default({ client: {} }, entry.options);
ok(hooks && typeof hooks === 'object' && Object.keys(hooks).length === 0, 'the plugin declares no hooks');

// 4. the option was consumed
ok(pendingOf() === null, 'the plugin cleared the staged import');
const after = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
const keys = Object.keys(after).filter((k) => k.startsWith('workbuddy'));
ok(keys.length === 10, `still ten accounts, got ${keys.length}`);
ok(JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(JSON.parse(before))), 'importing the same pool added no key');

// 5. it said what it did
const last = JSON.parse(readFileSync(join(POOL_DIR, 'last-import.json'), 'utf8'));
ok(last.imported === 10, `last import recorded 10, got ${last.imported}`);

// 6. the store is still honest about ownership
for (const k of keys) {
  const a = after[k];
  ok(a.accountId && !/[^\x20-\x7e]/.test(a.accountId), `${k} accountId is pinnable: ${a.accountId}`);
  ok(a.method === 'workbuddy-pool', `${k} is marked as the pool’s`);
}

copyFileSync(backup, PLUGINS_FILE);

if (fail.length) {
  console.error('FAIL');
  for (const f of fail) console.error(' -', f);
  process.exit(1);
}
console.log('PASS  page → options → plugin import round trip');
console.log(`  imported ${last.imported}, accounts ${keys.length}, option cleared`);

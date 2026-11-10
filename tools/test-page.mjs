// Checks the page's own logic without a browser: the snapshot parses, the
// grouping puts each account in its region, the health folds correctly, and
// the tiles agree.
//
// page/data.js is generated (the plugin writes it from the local store, and it
// is not in git), so a fresh clone has none to check. That is not a failure:
// the page says so itself and the plugin rewrites it on its next load.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'page');
const DATA = join(PAGE, 'data.js');

if (!existsSync(DATA)) {
  console.log('SKIP  no page/data.js yet (the plugin writes it from the local store)');
  process.exit(0);
}

new Function(readFileSync(DATA, 'utf8'))();
new Function(readFileSync(join(PAGE, 'view.js'), 'utf8'))();

const snap = globalThis.WB_POOL;
const V = globalThis.WBPoolView;
const fail = [];
const ok = (c, m) => c || fail.push(m);

ok(snap, 'data.js defines WB_POOL');
ok(V, 'view.js defines WBPoolView');
ok(snap.accounts.length > 0, `expected accounts, got ${snap.accounts.length}`);

const groups = V.groups(snap, {});
const byRegion = Object.fromEntries(groups.map((g) => [g.region, g.rows.length]));
console.log('groups:', JSON.stringify(byRegion), 'health:', JSON.stringify(snap.health));

ok(byRegion.cn === snap.counts.cn, `cn rows ${byRegion.cn} vs counts ${snap.counts.cn}`);
ok((byRegion.hmt ?? 0) === snap.counts.hmt, `hmt rows ${byRegion.hmt} vs counts ${snap.counts.hmt}`);
ok(!byRegion.intl, 'no intl account in this pool');
ok(groups[0].region === 'cn', 'cn group comes first');
ok(groups[1].rows.every((a) => a.label.startsWith('港澳台')), 'hmt labels are prefixed 港澳台');

// the row paints these; a missing one is an empty row on screen
for (const a of snap.accounts) {
  for (const k of ['key', 'provider', 'region', 'label', 'uid', 'health']) {
    ok(a[k] !== undefined && a[k] !== '', `account ${a.key ?? '?'} missing ${k}`);
  }
  ok(a.provider === 'workbuddy', `account ${a.label} provider ${a.provider}`);
  ok(a.present === true, `account ${a.label} is not present in the store`);
  ok(typeof a.accountId === 'string' && /^[A-Z]+-/.test(a.accountId), `account ${a.label} accountId is ASCII: ${a.accountId}`);
  ok(!/[^\x20-\x7e]/.test(a.accountId), `accountId ${a.accountId} must be ASCII to be pinnable`);
}

// health folds a live verdict over the token's own clock
const now = Date.now();
ok(V.levelOf({ present: true, health: 'ok', expiresAt: now + 864e5 }) === 'ok', 'healthy account reads ok');
ok(V.levelOf({ present: true, health: 'ok', expiresAt: now - 1000 }) === 'bad', 'an ended token outranks a stale ok');
ok(V.levelOf({ present: false, health: 'ok' }) === 'missing', 'a missing sign-in reads missing');

// tokens must never reach the frame
const raw = readFileSync(join(PAGE, 'data.js'), 'utf8');
ok(!/access_token|refresh_token|"access"|"refresh"|Bearer/.test(raw), 'data.js carries no token fields');

// tiles
const tiles = V.tiles(snap, 'zh');
ok(tiles.length === 4, 'four tiles');
ok(tiles[0].value === String(snap.accounts.length), `total tile ${tiles[0].value}`);

// search
const found = V.groups(snap, { query: '519' });
ok(found.length <= snap.accounts.length, 'search returns a subset');
ok(V.groups(snap, { query: 'no-such-thing' }).length === 0, 'a search with no match yields nothing');

// words in both languages
ok(V.text('zh').title !== V.text('en').title, 'the page speaks both');
ok(typeof V.when(snap.generatedAt) === 'string' && V.when(snap.generatedAt) !== '', 'generatedAt renders');
ok(V.left(now + 36e5) === '1h', 'hours are humanised');

if (fail.length) {
  console.error('\nFAIL');
  for (const f of fail) console.error(' -', f);
  process.exit(1);
}
console.log('\nPASS  page logic + snapshot');
console.log(`  counts: ${JSON.stringify(snap.counts)}`);
console.log(`  health: ${JSON.stringify(snap.health)}`);

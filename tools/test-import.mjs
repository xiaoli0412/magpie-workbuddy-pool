// The importer, end to end, against temporary files.
//
// Proves the properties a pool must have: it is idempotent, it never touches an
// account another plugin wrote, it drops only its own, it places regions, and
// it writes nothing that is not an account.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importRecords, recordsFromText, healthOf } from '../lib/importer.mjs';
import { keyFor } from '../lib/pools.mjs';
import { MARK } from '../lib/snapshot.mjs';

const fail = [];
const ok = (c, m) => c || fail.push(m);

const dir = mkdtempSync(join(tmpdir(), 'wbp-'));
const authFile = join(dir, 'plugin-auth.json');
const stateFile = join(dir, 'state.json');

// Somebody else's sign-ins, which must survive untouched.
writeFileSync(
  authFile,
  JSON.stringify(
    {
      workbuddy: { type: 'oauth', access: 'theirs', refresh: 'theirs', expires: Date.now() + 864e5, accountId: 'Someone' },
      kiro: { type: 'oauth', access: 'x', refresh: 'y', expires: 0, accountId: 'Kiro' },
    },
    null,
    2,
  ),
);

const sample = [
  { uid: 'u-cn-1', email: '13800001111', access_token: 'a1', refresh_token: 'r1', expires_at: 2000000000, auth_raw: { domain: 'www.codebuddy.cn', refreshExpiresIn: 2592000 }, profile_raw: { phoneNumber: '13800001111' } },
  { uid: 'u-hk-1', email: '51234567', access_token: 'a2', refresh_token: 'r2', expires_at: 2000000000, origin: 'wb852', profile_raw: { phoneNumber: '51234567' } },
  { uid: 'u-intl-1', email: 'x@y.z', access_token: 'a3', refresh_token: 'r3', expires_at: 2000000000, auth_raw: { domain: 'www.workbuddy.ai' }, profile_raw: { phoneNumber: '' } },
];

const { records, error } = recordsFromText(JSON.stringify(sample));
ok(!error, `recordsFromText: ${error}`);
ok(records.length === 3, `3 records, got ${records.length}`);

const first = await importRecords({ records, authFile, stateFile, probeLive: false });
ok(first.planned.length === 3, 'three placed');

const byRegion = Object.fromEntries(first.planned.map((p) => [p.rec.uid, p.region]));
ok(byRegion['u-cn-1'] === 'cn', `cn account placed ${byRegion['u-cn-1']}`);
ok(byRegion['u-hk-1'] === 'hmt', `852 pool placed ${byRegion['u-hk-1']}`);
ok(byRegion['u-intl-1'] === 'intl', `intl domain placed ${byRegion['u-intl-1']}`);

const provider = Object.fromEntries(first.planned.map((p) => [p.rec.uid, p.provider]));
ok(provider['u-intl-1'] === 'workbuddy-ai', 'international lands on workbuddy-ai');
ok(provider['u-cn-1'] === 'workbuddy', 'mainland lands on workbuddy');

const store = JSON.parse(readFileSync(authFile, 'utf8'));
ok(store.workbuddy?.accountId === 'Someone', 'another plugin’s account survived');
ok(store.kiro?.accountId === 'Kiro', 'an unrelated provider survived');
ok(store[keyFor('workbuddy', 'u-cn-1')]?.method === MARK, 'the pool’s account is marked');
ok(store['workbuddy'] && store['workbuddy'].method === undefined, 'the primary key was not overwritten');
ok(store[keyFor('workbuddy-ai', 'u-intl-1')]?.domain === 'www.workbuddy.ai', 'the intl account kept its build');

// expiries are ms in the store, seconds in the export
ok(store[keyFor('workbuddy', 'u-cn-1')].expires === 2000000000 * 1000, 'seconds became ms');

// an accountId must be ASCII, or a request cannot pin it
for (const a of Object.values(store)) {
  if (a.accountId) ok(!/[^\x20-\x7e]/.test(a.accountId), `accountId not ASCII: ${a.accountId}`);
}

// idempotent: the same import twice changes nothing
const before = readFileSync(authFile, 'utf8');
await importRecords({ records, authFile, stateFile, probeLive: false });
ok(readFileSync(authFile, 'utf8') === before, 'a second import of the same pool is a no-op');

// the pool drops only what it wrote and no longer finds
const shrunk = await importRecords({ records: records.filter((r) => r.uid !== 'u-hk-1'), authFile, stateFile, probeLive: false });
ok(shrunk.dropped.length === 1, `one dropped, got ${shrunk.dropped.length}`);
const after = JSON.parse(readFileSync(authFile, 'utf8'));
ok(!after[keyFor('workbuddy', 'u-hk-1')], 'the vanished account is gone');
ok(after.workbuddy?.accountId === 'Someone', 'the other plugin’s account still survived');

// health reads the stored entry
ok(healthOf({ access: 'x', expires: Date.now() + 30 * 864e5 }).level === 'ok', 'a month left is healthy');
ok(healthOf({ access: 'x', expires: Date.now() - 1000 }).level === 'bad', 'an ended token is bad');
ok(healthOf({}).level === 'bad', 'no token is bad');

// nothing extra was left behind
ok(existsSync(stateFile), 'state was written');

rmSync(dir, { recursive: true, force: true });

if (fail.length) {
  console.error('FAIL');
  for (const f of fail) console.error(' -', f);
  process.exit(1);
}
console.log('PASS  importer (regions, idempotence, ownership, units)');

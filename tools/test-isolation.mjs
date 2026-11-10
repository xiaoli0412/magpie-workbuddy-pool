// Importing one pool folder must never empty another. This is the bug that
// would quietly delete a user's accounts when they added a second folder.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importRecords, recordsFromText } from '../lib/importer.mjs';
import { keyFor } from '../lib/pools.mjs';

const fail = [];
const ok = (c, m) => c || fail.push(m);

const root = mkdtempSync(join(tmpdir(), 'wbp-iso-'));
const authFile = join(root, 'plugin-auth.json');
const stateFile = join(root, 'state.json');
const dirA = join(root, 'poolA');
const dirB = join(root, 'poolB');
mkdirSync(dirA);
mkdirSync(dirB);
writeFileSync(authFile, JSON.stringify({}, null, 2), 'utf8');

const rec = (uid, phone) => ({
  uid,
  email: phone,
  access_token: 'a-' + uid,
  refresh_token: 'r-' + uid,
  expires_at: 2000000000,
  auth_raw: { domain: 'www.codebuddy.cn' },
  profile_raw: { phoneNumber: phone },
});

// pool A
const a = recordsFromText(JSON.stringify([rec('uid-a1', '13800000001'), rec('uid-a2', '13800000002')]));
await importRecords({ records: a.records, authFile, stateFile, probeLive: false, poolDir: dirA });

let store = JSON.parse(readFileSync(authFile, 'utf8'));
ok(Object.keys(store).length === 2, `A imported 2, got ${Object.keys(store).length}`);

// pool B, a different folder
const b = recordsFromText(JSON.stringify([rec('uid-b1', '13900000001')]));
const reportB = await importRecords({ records: b.records, authFile, stateFile, probeLive: false, poolDir: dirB });

store = JSON.parse(readFileSync(authFile, 'utf8'));
ok(Object.keys(store).length === 3, `A + B = 3, got ${Object.keys(store).length}`);
ok(reportB.dropped.length === 0, `importing B dropped ${reportB.dropped.length} of A's accounts`);
ok(store[keyFor('workbuddy', 'uid-a1')], 'A’s first account survived B');
ok(store[keyFor('workbuddy', 'uid-a2')], 'A’s second account survived B');
ok(store[keyFor('workbuddy', 'uid-b1')], 'B’s account landed');

// re-importing A alone must drop nothing from B
const reportA2 = await importRecords({ records: a.records, authFile, stateFile, probeLive: false, poolDir: dirA });
store = JSON.parse(readFileSync(authFile, 'utf8'));
ok(reportA2.dropped.length === 0, `re-importing A dropped ${reportA2.dropped.length}`);
ok(store[keyFor('workbuddy', 'uid-b1')], 'B survived a re-import of A');

// but A dropping one of its own still works
const reportA3 = await importRecords({ records: a.records.filter((r) => r.uid !== 'uid-a2'), authFile, stateFile, probeLive: false, poolDir: dirA });
store = JSON.parse(readFileSync(authFile, 'utf8'));
ok(reportA3.dropped.length === 1, `A dropping its own: ${reportA3.dropped.length}`);
ok(!store[keyFor('workbuddy', 'uid-a2')], 'the account A no longer has is gone');
ok(store[keyFor('workbuddy', 'uid-b1')], 'B still there');

// the page's own imports live in their own namespace and are not swept either
const p = recordsFromText(JSON.stringify([rec('uid-p1', '13700000001')]));
await importRecords({ records: p.records, authFile, stateFile, probeLive: false, poolDir: 'page' });
const reportA4 = await importRecords({ records: a.records.slice(0, 1), authFile, stateFile, probeLive: false, poolDir: dirA });
store = JSON.parse(readFileSync(authFile, 'utf8'));
ok(reportA4.dropped.length === 0, 'a folder import does not sweep a page import');
ok(store[keyFor('workbuddy', 'uid-p1')], 'the page-imported account survived');

rmSync(root, { recursive: true, force: true });

if (fail.length) {
  console.error('FAIL');
  for (const f of fail) console.error(' -', f);
  process.exit(1);
}
console.log('PASS  pool isolation (one folder never empties another)');

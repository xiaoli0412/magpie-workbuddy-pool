#!/usr/bin/env bun
// Import a WorkBuddy/CodeBuddy pool into magpie's own sign-in store.
//
//   bun tools/import.mjs [--dir <folder>] [--dry] [--no-probe] [--json]
//
// Every *.json in the pool folder (default ~/.config/magpie/workbuddy-pool) is
// read and each account is written under the native provider its build owns:
//
//   workbuddy      the China build      (copilot.tencent.com)
//   workbuddy-ai   the international build (www.workbuddy.ai)
//
// The work itself lives in lib/importer.mjs, which the plugin uses too, so the
// command line and the page cannot drift apart.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH_FILE, POOL_DIR, STATE_FILE } from '../lib/pools.mjs';
import { loadPools } from '../lib/pools.mjs';
import { importRecords } from '../lib/importer.mjs';
import { collect, writeSnapshot, mask } from '../lib/snapshot.mjs';
import { readJsonFile, atomicJson, ensureDir } from '../lib/store.mjs';
import { REGION_LABEL } from '../lib/region.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const option = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const dir = option('dir', POOL_DIR);
const dry = flag('dry');
const probeLive = !flag('no-probe') && !flag('offline');
const asJson = flag('json');
const say = (...a) => {
  if (!asJson) console.log(...a);
};

if (!existsSync(dir)) {
  ensureDir(dir);
  console.error(`pool folder was missing and has been created: ${dir}`);
  console.error('drop the exported *.json files in it, then run this again.');
  process.exit(1);
}

const { files, records, problems } = loadPools(dir);

say(`pool: ${dir}`);
say(`files: ${files.length}${files.length ? ` (${files.map((f) => f.split(/[\\/]/).pop()).join(', ')})` : ''}`);
for (const p of problems) say(`  skipped ${p.file}: ${p.error}`);
say(`accounts read: ${records.length}`);

if (!records.length) {
  console.error('nothing to import.');
  process.exit(1);
}

const report = await importRecords({ records, fileName: '', authFile: AUTH_FILE, stateFile: STATE_FILE, dry, probeLive });

// A dry run still leaves the page's snapshot alone: it would claim numbers that
// were never written.
if (!dry) {
  const state = readJsonFile(STATE_FILE, { accounts: {} });
  atomicJson(join(POOL_DIR, 'last-import.json'), {
    at: Date.now(),
    name: 'cli',
    imported: report.planned.length,
    dropped: report.dropped.length,
    accounts: report.planned.map((p) => ({ key: p.key, label: p.label, region: p.region })),
  });
  writeSnapshot(collect({ authFile: AUTH_FILE, state }));
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        dry,
        files,
        accounts: report.planned.map((p) => ({
          key: p.key,
          provider: p.provider,
          region: p.region,
          label: p.label,
          uid: p.rec.uid,
          phone: mask(p.rec.phone),
          domain: p.entry.domain,
          expires: p.entry.expires,
          probe: p.live ? { ok: p.live.ok, nickname: p.live.nickname, build: p.live.build } : null,
        })),
        dropped: report.dropped,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const rows = report.planned.map((p) => ({
  region: REGION_LABEL[p.region] ?? '?',
  provider: p.provider,
  account: p.label,
  probe: p.live?.ok ? '✓ 实测通过' : probeLive ? '✗ 未通过' : '— 未实测',
  expires: p.entry.expires ? new Date(p.entry.expires).toISOString().slice(0, 16).replace('T', ' ') : '—',
  key: p.key,
}));
const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
const W = { region: w('region'), provider: w('provider'), account: w('account'), probe: w('probe'), expires: w('expires'), key: w('key') };

say('');
say(`${'区域'.padEnd(W.region)}  ${'provider'.padEnd(W.provider)}  ${'账号'.padEnd(W.account)}  ${'实测'.padEnd(W.probe)}  ${'到期'.padEnd(W.expires)}  key`);
say('─'.repeat(W.region + W.provider + W.account + W.probe + W.expires + W.key + 12));
for (const r of rows) {
  say(`${r.region.padEnd(W.region)}  ${r.provider.padEnd(W.provider)}  ${r.account.padEnd(W.account)}  ${r.probe.padEnd(W.probe)}  ${r.expires.padEnd(W.expires)}  ${r.key}`);
}
say('');

const byRegion = report.planned.reduce((a, p) => ({ ...a, [p.region]: (a[p.region] ?? 0) + 1 }), {});
say(
  `写入：${Object.entries(byRegion).map(([k, v]) => `${REGION_LABEL[k] ?? k} ${v}`).join(' · ')}  →  ${AUTH_FILE}${dry ? '  （dry run，未写盘）' : ''}`,
);
if (report.dropped.length) say(`清理：${report.dropped.length} 个本池已不存在的账号 → ${report.dropped.join(', ')}`);
say(`快照：page/data.js${dry ? '（dry run，未写）' : ''}`);

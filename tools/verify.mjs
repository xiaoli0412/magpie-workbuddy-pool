#!/usr/bin/env bun
// Check every imported account against WorkBuddy itself.
//
//   bun tools/verify.mjs [--refresh] [--json] [--models]
//
// Prints who each token is, which build answered, and how long it has left.
// With --refresh a token that is close to its end is renewed and written back,
// which is also the only honest test of a refresh token.
import { readFileSync } from 'node:fs';
import { AUTH_FILE, STATE_FILE } from '../lib/pools.mjs';
import { readAuth } from '../lib/store.mjs';
import { readJsonFile } from '../lib/store.mjs';
import { probe, renew, models, credits } from '../lib/wb.mjs';
import { collect, writeSnapshot, mask } from '../lib/snapshot.mjs';
import { REGION_LABEL } from '../lib/region.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const asJson = flag('json');
const say = (...a) => {
  if (!asJson) console.log(...a);
};

const state = readJsonFile(STATE_FILE, { accounts: {} });
const managed = state.accounts ?? {};
const { store } = readAuth(AUTH_FILE);

const rows = [];
for (const [key, meta] of Object.entries(managed)) {
  const auth = store[key]?.auth ?? store[key];
  const row = {
    key,
    label: meta.label,
    region: REGION_LABEL[meta.region] ?? '?',
    provider: meta.provider,
    phone: mask(meta.phone),
    uid: meta.uid,
    domain: auth?.domain ?? '',
    present: Boolean(auth?.access),
    ok: false,
    who: '',
    build: '',
    expiresIn: '',
    note: '',
    models: null,
  };

  if (!auth?.access) {
    row.note = '登录态缺失，请重新导入';
    rows.push(row);
    continue;
  }

  try {
    let live = auth;
    const r = await probe(meta.provider, live);
    if (r.ok) {
      row.ok = true;
      row.who = r.nickname || r.phone || r.uid;
      row.build = r.build;
    } else {
      // A refused token is worth one honest renewal before it is called dead.
      if (flag('refresh') && live.refresh) {
        try {
          const next = await renew(meta.provider, live);
          live = { ...live, ...next };
          const again = await probe(meta.provider, live);
          row.ok = Boolean(again.ok);
          row.who = again.nickname || again.phone || '';
          row.build = again.build;
          row.note = row.ok ? '已续期后通过' : `续期后仍被拒绝 (${again.reason ?? 'refused'})`;
        } catch (e) {
          row.note = `续期失败: ${e.message}`;
        }
      } else {
        row.note = `被拒绝 (${r.reason ?? r.status})`;
      }
    }

    if (flag('models') && row.ok) {
      const list = await models(meta.provider, live);
      row.models = list.length;
    }

    const exp = Number(live.expires) || 0;
    row.expiresIn = exp ? `${Math.round((exp - Date.now()) / 36e5)}h` : '—';
  } catch (e) {
    row.note = `请求失败: ${e.message}`;
  }
  rows.push(row);
}

if (asJson) {
  console.log(JSON.stringify({ accounts: rows }, null, 2));
} else {
  const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length));
  const W = { region: w('region'), label: w('label'), who: w('who'), expiresIn: w('expiresIn'), note: w('note') };
  say('');
  say(`${'区域'.padEnd(W.region)}  ${'账号'.padEnd(W.label)}  ${'身份'.padEnd(W.who)}  ${'剩余'.padEnd(W.expiresIn)}  状态`);
  say('─'.repeat(88));
  for (const r of rows) {
    const status = r.ok ? '✓ 可用' : `✗ ${r.note || '未通过'}`;
    say(
      `${r.region.padEnd(W.region)}  ${String(r.label).padEnd(W.label)}  ${String(r.who || '—').padEnd(W.who)}  ${String(r.expiresIn).padEnd(W.expiresIn)}  ${status}`,
    );
  }
  const ok = rows.filter((r) => r.ok).length;
  say('');
  say(`${ok}/${rows.length} 可用  ·  ${AUTH_FILE}`);
}

// keep the page honest about what was just found
try {
  writeSnapshot(collect({ authFile: AUTH_FILE, state }));
} catch {}

// The cooldown / auto-disable machine, checked without a network.
import { applyResult, emptyLife, isUsable, whyNot, dueForTest, kindOf, DISABLE_AFTER } from '../lib/lifecycle.mjs';

const fail = [];
const ok = (c, m) => c || fail.push(m);
const now = Date.now();

// a good answer clears everything
let life = applyResult(emptyLife(), { ok: true }, now);
ok(life.health === 'ok' && life.failStreak === 0 && life.disabled === false, 'a success is healthy');
ok(isUsable(life, now), 'a healthy account is usable');

// a rate limit is not the account's fault: short cooldown, streak untouched
life = applyResult(life, { ok: false, error: 'HTTP 429', status: 429 }, now);
ok(life.failStreak === 0, `429 must not count as a failure (got ${life.failStreak})`);
ok(life.disabled === false, '429 must not disable');
ok(life.cooldownUntil > now, '429 puts the account on a short cooldown');
ok(life.cooldownUntil - now <= 11 * 60e3, 'the 429 cooldown is minutes, not hours');
ok(!isUsable(life, now), 'a cooling account is not usable');
ok(whyNot(life, now).includes('冷却'), 'whyNot says it is cooling');

// the cooldown expires on its own
ok(isUsable(life, life.cooldownUntil + 1), 'a cooling account comes back by itself');

// a real refusal counts, and three in a row take the account out
life = applyResult(emptyLife(), { ok: false, error: 'HTTP 401' }, now);
ok(life.failStreak === 1 && !life.disabled, 'one refusal is a streak of one');
const firstWait = life.cooldownUntil - now;
life = applyResult(life, { ok: false, error: 'HTTP 401' }, now + 1000);
const secondWait = life.cooldownUntil - (now + 1000);
ok(secondWait > firstWait, `the wait grows: ${firstWait} → ${secondWait}`);
life = applyResult(life, { ok: false, error: '账号被限制 (11140)' }, now + 2000);
ok(life.disabled === true, `${DISABLE_AFTER} failures disable the account`);
ok(life.health === 'disabled', 'a disabled account says so');
ok(!isUsable(life, now), 'a disabled account is not usable');
ok(/自动关闭/.test(whyNot(life, now)), 'whyNot explains the disablement');

// a disabled account is not re-tested on its own
ok(!dueForTest(life, { now: now + 30 * 24 * 3600e3 }), 'a disabled account waits for a manual test');

// a manual success brings it back
life = applyResult(life, { ok: true }, now + 5000);
ok(life.disabled === false && life.health === 'ok', 'a success re-enables');

// a success resets the streak, so it takes three fresh failures again
life = applyResult(emptyLife(), { ok: false, error: 'HTTP 401' }, now);
life = applyResult(life, { ok: false, error: 'HTTP 401' }, now);
life = applyResult(life, { ok: true }, now);
life = applyResult(life, { ok: false, error: 'HTTP 401' }, now);
ok(life.failStreak === 1 && !life.disabled, 'a success resets the streak');

// classification
ok(kindOf('HTTP 429', 429) === 'rate', '429 is a rate limit');
ok(kindOf('账号被限制 (11140)') === 'refused', '11140 is a refusal');
ok(kindOf('HTTP 401') === 'auth', '401 is an auth problem');
ok(kindOf('超时（25s）') === 'network', 'a timeout is a network problem');
ok(kindOf('没有收到任何数据') === 'error', 'anything else is a plain error');

// healthy accounts are re-checked slowly
const fresh = applyResult(emptyLife(), { ok: true }, now);
ok(!dueForTest(fresh, { healthyEveryMs: 3600e3, now: now + 60e3 }), 'a fresh healthy account is left alone');
ok(dueForTest(fresh, { healthyEveryMs: 3600e3, now: now + 3601e3 }), 'an old healthy account is re-checked');
ok(dueForTest(emptyLife(), { now }), 'a never-tested account is due');

if (fail.length) {
  console.error('FAIL');
  for (const f of fail) console.error(' -', f);
  process.exit(1);
}
console.log('PASS  lifecycle (cooldown, backoff, auto-disable, recovery)');

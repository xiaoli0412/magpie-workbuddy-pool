// What happens to an account after a test.
//
// A pool is only useful if the bad accounts stop taking traffic and the
// temporarily-unlucky ones come back. So a test result is not just a colour: it
// feeds a small state machine.
//
//   ok                → cleared: streak reset, cooldown gone, re-enabled
//   429               → cooldown 10 min, streak unchanged (the pool was busy,
//                       not the account's fault)
//   refused (401/403/11140/11158/expired)
//                     → one more failure on the streak, cooldown doubles
//   3 failures in a row → disabled: taken out of magpie's sign-in store
//
// A disabled account is never thrown away: its token is kept aside so it can be
// restored, and re-importing the same file re-enables it.
const MIN = 60e3;

// How long a failing account sits out, by how many times it has failed.
const BACKOFF = [30 * MIN, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];

// Rate limiting is temporary and not the account's fault.
const RATE_LIMIT_COOLDOWN = 10 * MIN;

// This many failures in a row takes an account out of service.
export const DISABLE_AFTER = 3;

// Classify an error so the machine can decide what kind of failure it is.
export function kindOf(error, status) {
  const said = String(error ?? '');
  if (status === 429 || /429|限流|too many/i.test(said)) return 'rate';
  if (/账号被限制|11140|restricted/i.test(said)) return 'refused';
  if (/无权使用此模型|11158/i.test(said)) return 'no-model';
  if (/401|403|未完成登录|11217|已过期|refresh token/i.test(said)) return 'auth';
  if (/超时|timed out|ETIMEDOUT|ECONNRESET|网络/i.test(said)) return 'network';
  return 'error';
}

export function emptyLife() {
  return {
    health: 'unchecked',
    failStreak: 0,
    okStreak: 0,
    cooldownUntil: 0,
    disabled: false,
    lastTestAt: 0,
    lastTestError: '',
    lastKind: '',
  };
}

// applyResult folds one test into an account's state.
//
//   life   the previous state (or emptyLife())
//   result { ok, error, status, models }
//   now    for tests
export function applyResult(life, result, now = Date.now()) {
  const prev = { ...emptyLife(), ...(life ?? {}) };
  const next = { ...prev, lastTestAt: now };

  if (result?.ok) {
    return {
      ...next,
      health: 'ok',
      failStreak: 0,
      okStreak: prev.okStreak + 1,
      cooldownUntil: 0,
      disabled: false,
      lastTestError: '',
      lastKind: '',
    };
  }

  const kind = kindOf(result?.error, result?.status);

  // A rate limit says nothing about the account; it just needs a moment.
  if (kind === 'rate') {
    return {
      ...next,
      health: prev.health === 'ok' ? 'ok' : 'cooldown',
      cooldownUntil: now + RATE_LIMIT_COOLDOWN,
      lastTestError: result?.error ?? '限流',
      lastKind: 'rate',
    };
  }

  const streak = prev.failStreak + 1;
  const wait = BACKOFF[Math.min(streak - 1, BACKOFF.length - 1)];
  const disabled = streak >= DISABLE_AFTER;

  return {
    ...next,
    health: disabled ? 'disabled' : 'bad',
    failStreak: streak,
    okStreak: 0,
    cooldownUntil: disabled ? 0 : now + wait,
    disabled,
    lastTestError: result?.error ?? '无回包',
    lastKind: kind,
  };
}

// isUsable is what the router and the plugin ask before touching an account.
export function isUsable(life, now = Date.now()) {
  const l = { ...emptyLife(), ...(life ?? {}) };
  if (l.disabled) return false;
  if (l.cooldownUntil && l.cooldownUntil > now) return false;
  return true;
}

// whyNot is a short reason for the page.
export function whyNot(life, now = Date.now()) {
  const l = { ...emptyLife(), ...(life ?? {}) };
  if (l.disabled) return `已自动关闭（连续失败 ${l.failStreak} 次）`;
  if (l.cooldownUntil && l.cooldownUntil > now) {
    const min = Math.max(1, Math.round((l.cooldownUntil - now) / MIN));
    return `冷却中 ${min < 60 ? `${min} 分钟` : `${Math.round(min / 60)} 小时`}`;
  }
  return '';
}

// dueForTest says whether an account should be re-tested now. Healthy accounts
// are re-checked slowly, broken ones on their cooldown boundary.
export function dueForTest(life, { healthyEveryMs = 6 * 3600e3, now = Date.now() } = {}) {
  const l = { ...emptyLife(), ...(life ?? {}) };
  if (!l.lastTestAt) return true;
  if (l.disabled) return false; // a disabled account waits for a manual test
  if (l.cooldownUntil && l.cooldownUntil > now) return false;
  if (l.health === 'ok') return now - l.lastTestAt > healthyEveryMs;
  return true;
}

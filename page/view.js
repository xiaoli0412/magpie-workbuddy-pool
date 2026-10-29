// What the page shows, worked out from the snapshot alone, with no DOM, so
// every number can be checked without a browser.
(() => {
  const REGIONS = ['cn', 'hmt', 'intl', 'unknown'];
  const LABEL = { cn: '大陆', hmt: '港澳台', intl: '国际', unknown: '未知' };
  const PROVIDER = { workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI' };

  const TEXT = {
    zh: {
      title: 'WorkBuddy 账号池',
      since: '快照',
      empty: '没有符合条件的账号。',
      noSnapshot: '还没有导入账号：粘贴导出 JSON，或把文件放进 magpie 的 workbuddy-pool 文件夹。',
      total: '账号',
      alive: '实测可用',
      todo: '需处理',
      lastImport: '最近导入',
      never: '未导入',
      search: '搜索号码 / uid / 来源文件',
      health: { ok: '可用', bad: '失效', missing: '登录态缺失', error: '检测失败', unchecked: '待实测' },
      importTitle: '导入账号',
      requests: '请求',
      input: '输入',
      output: '输出',
      errors: '错误',
      models: '模型',
      account: '账号',
      daily: '近 14 天',
      foot:
        '账号是 magpie 原生 workbuddy / workbuddy-ai 登录态；「可用」= 真发一次模型请求并收到回包，不是看状态位。大陆/港澳台是账号归属标签，两者都走中国构建。',
      tabs: { accounts: '账号', usage: '用量', routing: '分流' },
    },
    en: {
      title: 'WorkBuddy pool',
      since: 'snapshot',
      empty: 'No account matches.',
      noSnapshot: 'Nothing imported yet: paste an export above, or drop files into magpie’s workbuddy-pool folder.',
      total: 'Accounts',
      alive: 'Answered',
      todo: 'To fix',
      lastImport: 'Last import',
      never: 'never',
      search: 'search number / uid / source file',
      health: { ok: 'answers', bad: 'dead', missing: 'missing', error: 'check failed', unchecked: 'unchecked' },
      importTitle: 'Import',
      requests: 'Requests',
      input: 'Input',
      output: 'Output',
      errors: 'Errors',
      models: 'Models',
      account: 'Account',
      daily: 'Last 14 days',
      foot:
        'Accounts are native magpie workbuddy / workbuddy-ai sign-ins. “answers” means a real model request came back, not that a token looked valid.',
      tabs: { accounts: 'Accounts', usage: 'Usage', routing: 'Routing' },
    },
  };

  const text = (lang) => (String(lang || '').toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en);
  const providerName = (id) => PROVIDER[id] || id || '';
  const regionLabel = (r) => LABEL[r] || LABEL.unknown;
  const healthText = (h, lang) => text(lang).health[h] || text(lang).health.unchecked;

  // compact numbers the way magpie writes them
  function num(n) {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return Math.round(v / 1e3) + 'K';
    return String(Math.round(v));
  }

  function left(ms) {
    if (!ms) return '—';
    const h = Math.round((ms - Date.now()) / 36e5);
    if (h <= 0) return h === 0 ? '0h' : `−${Math.abs(h)}h`;
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  }

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function matches(a, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return [a.label, a.uid, a.phone, a.sourceFile, a.domain, a.origin, a.key, a.provider, a.accountId]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  }

  // levelOf folds the live verdict over the token's own clock: a check that has
  // not run yet never outranks a token that has plainly ended.
  function levelOf(a) {
    if (!a.present) return 'missing';
    if (a.health === 'bad' || a.health === 'missing') return 'bad';
    if (a.expiresAt && a.expiresAt <= Date.now()) return 'bad';
    if (a.health === 'error') return 'error';
    if (a.health === 'ok') return 'ok';
    return 'unchecked';
  }

  function groups(snapshot, { query = '', region = 'all' } = {}) {
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const out = [];
    for (const r of REGIONS) {
      if (region !== 'all' && region !== r) continue;
      const rows = accounts.filter((a) => a.region === r && matches(a, query));
      if (rows.length) out.push({ region: r, label: regionLabel(r), rows });
    }
    return out;
  }

  function tiles(snapshot, lang) {
    const t = text(lang);
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const alive = accounts.filter((a) => levelOf(a) === 'ok').length;
    const todo = accounts.filter((a) => ['bad', 'missing', 'error'].includes(levelOf(a))).length;
    const li = snapshot?.lastImport;
    return [
      { key: 'total', label: t.total, value: String(accounts.length), sub: `${snapshot?.counts?.cn ?? 0} 大陆 · ${snapshot?.counts?.hmt ?? 0} 港澳台 · ${snapshot?.counts?.intl ?? 0} 国际` },
      { key: 'alive', label: t.alive, value: String(alive), sub: `${accounts.length - alive} 未实测/其他` },
      { key: 'todo', label: t.todo, value: String(todo), sub: todo ? '见下方红标' : '无需处理', bad: todo > 0 },
      { key: 'last', label: t.lastImport, value: li ? String(li.imported ?? 0) : '0', sub: li ? when(new Date(li.at).toISOString()) : t.never },
    ];
  }

  // usageTiles is the totals for the window magpie recorded.
  function usageTiles(snapshot, lang) {
    const t = text(lang);
    const u = snapshot?.usage?.total ?? {};
    return [
      { key: 'requests', label: t.requests, value: num(u.requests), sub: `${num(u.cacheRead)} 缓存读取` },
      { key: 'input', label: t.input, value: num(u.input), sub: 'tokens' },
      { key: 'output', label: t.output, value: num(u.output), sub: 'tokens' },
      { key: 'errors', label: t.errors, value: num(u.errors), sub: u.requests ? `${Math.round(((u.errors || 0) / u.requests) * 100)}% 的请求` : '', bad: (u.errors || 0) > 0 },
    ];
  }

  // accountUsage lists accounts by how much they did, with the model they used most.
  function accountUsage(snapshot) {
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const rows = accounts.map((a) => {
      const u = a.use || {};
      const models = Object.entries(u.models || {})
        .sort((x, y) => y[1].requests - x[1].requests)
        .map(([model, m]) => ({ model, requests: m.requests, input: m.input, output: m.output }));
      return {
        key: a.key,
        label: a.label || a.uid,
        region: a.region,
        level: levelOf(a),
        requests: u.requests || 0,
        input: u.input || 0,
        output: u.output || 0,
        errors: u.errors || 0,
        lastAt: u.lastAt || 0,
        models,
        top: models[0]?.model ?? '',
      };
    });
    return rows.sort((a, b) => b.requests - a.requests || String(a.label).localeCompare(String(b.label)));
  }

  function modelUsage(snapshot) {
    const models = snapshot?.usage?.models ?? {};
    const total = Object.values(models).reduce((s, m) => s + (m.requests || 0), 0) || 1;
    return Object.entries(models)
      .map(([model, m]) => ({
        model,
        requests: m.requests || 0,
        input: m.input || 0,
        output: m.output || 0,
        errors: m.errors || 0,
        share: (m.requests || 0) / total,
        accounts: Object.entries(m.accounts ?? {}).map(([account, n]) => ({ account, requests: n })),
      }))
      .sort((a, b) => b.requests - a.requests);
  }

  // routingRows is model → accounts, each account's share of that model.
  function routingRows(snapshot) {
    const list = Array.isArray(snapshot?.routing) ? snapshot.routing : [];
    return list.map((r) => {
      const total = r.accounts.reduce((s, a) => s + a.requests, 0) || 1;
      return {
        model: r.model,
        requests: r.requests,
        input: r.input,
        output: r.output,
        accounts: r.accounts.map((a) => ({ ...a, share: a.requests / total })),
      };
    });
  }

  // dayBars is the trend, scaled to its own maximum.
  function dayBars(snapshot) {
    const days = Array.isArray(snapshot?.days) ? snapshot.days : [];
    const max = days.reduce((m, d) => Math.max(m, d.requests), 0) || 1;
    return days.map((d) => ({ ...d, height: Math.max(2, Math.round((d.requests / max) * 100)) }));
  }

  globalThis.WBPoolView = {
    REGIONS, LABEL, PROVIDER, text, providerName, regionLabel, healthText,
    num, left, when, matches, groups, tiles, levelOf,
    usageTiles, accountUsage, modelUsage, routingRows, dayBars,
  };
})();

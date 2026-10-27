// What the page shows, worked out from the snapshot alone, with no DOM: the
// grouping, the counts, the health and the words can be checked without a
// browser.
(() => {
  const REGIONS = ['cn', 'hmt', 'intl', 'unknown'];
  const LABEL = { cn: '大陆', hmt: '港澳台', intl: '国际', unknown: '未知' };
  const PROVIDER = { workbuddy: 'WorkBuddy', 'workbuddy-ai': 'WorkBuddy AI' };

  const TEXT = {
    zh: {
      title: 'WorkBuddy 账号池',
      since: '快照',
      empty: '没有符合条件的账号。',
      noSnapshot: '还没有导入账号：在上面粘贴导出 JSON，或把文件放进 magpie 的 workbuddy-pool 文件夹。',
      total: '账号',
      alive: '实测可用',
      todo: '需处理',
      lastImport: '最近导入',
      never: '未导入',
      search: '搜索号码 / uid / 来源文件',
      health: { ok: '可用', bad: '失效', missing: '登录态缺失', error: '检测失败', unchecked: '待实测' },
      importTitle: '导入账号',
      foot:
        '账号是 magpie 原生 workbuddy / workbuddy-ai 登录态。「大陆 / 港澳台」是账号来源归属（由号码制式与导出池标签判定），两者都走中国构建；「国际」是另一套构建。判定依据见详细视图。',
    },
    en: {
      title: 'WorkBuddy pool',
      since: 'snapshot',
      empty: 'No account matches.',
      noSnapshot: 'Nothing imported yet: paste an export above, or drop files into magpie’s workbuddy-pool folder.',
      total: 'Accounts',
      alive: 'Alive',
      todo: 'To fix',
      lastImport: 'Last import',
      never: 'never',
      search: 'search number / uid / source file',
      health: { ok: 'alive', bad: 'dead', missing: 'missing', error: 'check failed', unchecked: 'unchecked' },
      importTitle: 'Import',
      foot:
        'Accounts are native magpie workbuddy / workbuddy-ai sign-ins. 大陆 / 港澳台 is where an account came from (numbering plan and pool tag); both use the China build. 国际 is the other build.',
    },
  };

  const text = (lang) => (String(lang || '').toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en);
  const providerName = (id) => PROVIDER[id] || id || '';
  const regionLabel = (r) => LABEL[r] || LABEL.unknown;
  const healthText = (h, lang) => text(lang).health[h] || text(lang).health.unchecked;

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
    return [a.label, a.uid, a.phone, a.sourceFile, a.domain, a.origin, a.key, a.provider]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  }

  // levelOf folds the live verdict and the token's own clock into one answer:
  // a check that has not run yet never outranks a token that has plainly ended.
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
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const alive = accounts.filter((a) => levelOf(a) === 'ok').length;
    const todo = accounts.filter((a) => {
      const l = levelOf(a);
      return l === 'bad' || l === 'missing' || l === 'error';
    }).length;
    const li = snapshot?.lastImport;
    return [
      { key: 'total', label: text(lang).total, value: String(accounts.length), sub: `${snapshot?.counts?.cn ?? 0} 大陆 · ${snapshot?.counts?.hmt ?? 0} 港澳台 · ${snapshot?.counts?.intl ?? 0} 国际` },
      { key: 'alive', label: text(lang).alive, value: String(alive), sub: `${accounts.length - alive} 未实测/其他` },
      { key: 'todo', label: text(lang).todo, value: String(todo), sub: todo ? '见下方红标' : '无需处理', bad: todo > 0 },
      { key: 'last', label: text(lang).lastImport, value: li ? String(li.imported ?? 0) : '0', sub: li ? when(new Date(li.at).toISOString()) : text(lang).never },
    ];
  }

  globalThis.WBPoolView = {
    REGIONS, LABEL, PROVIDER, text, providerName, regionLabel, healthText,
    left, when, matches, groups, tiles, levelOf,
  };
})();

// The page: paints what the plugin wrote into data.js, and takes an import.
//
// No network, no permissions: everything on screen comes from the snapshot. An
// import is handed to magpie through the one thing a page may write — its
// plugin's own options — and the page then waits for the plugin to take it.
(async () => {
  const V = globalThis.WBPoolView;
  const snap = globalThis.WB_POOL || null;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let lang = 'zh';
  try {
    const theme = await magpie.ready;
    lang = theme?.lang || navigator.language || 'zh';
  } catch {
    lang = navigator.language || 'zh';
  }

  let opts = {};
  try {
    opts = (await magpie.options.get()) || {};
  } catch {}

  const state = {
    tab: ['accounts', 'usage', 'routing'].includes(opts.tab) ? opts.tab : 'accounts',
    view: opts.view === 'detail' ? 'detail' : 'compact',
    region: ['all', 'cn', 'hmt', 'intl', 'unknown'].includes(opts.region) ? opts.region : 'all',
    query: '',
    closed: new Set(Array.isArray(opts.closed) ? opts.closed : []),
  };

  const t = () => V.text(lang);
  const el = (tag, cls, textContent) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (textContent !== undefined) n.textContent = textContent;
    return n;
  };

  function words() {
    $('title').textContent = t().title;
    $('search').placeholder = t().search;
    $('importTitle').textContent = t().importTitle;
    $('footNote').textContent = t().foot;
    if (snap) $('since').textContent = `${t().since} ${V.when(snap.generatedAt)}`;
  }

  function seg(groupId, attr, value) {
    const box = $(groupId);
    if (!box) return;
    box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset[attr] === value)));
  }

  function tileRow(nodes) {
    return nodes.map((tile) => {
      const d = el('div', 'tile' + (tile.bad ? ' bad' : ''));
      d.append(el('div', 'k', tile.label), el('div', 'v', tile.value), el('div', 's', tile.sub || ''));
      return d;
    });
  }

  // ---- accounts -----------------------------------------------------------
  function paintTiles() {
    if (!snap) return;
    $('tiles').replaceChildren(...tileRow(V.tiles(snap, lang)));
  }

  function rowOf(a, detailed) {
    const level = V.levelOf(a);
    const li = el('li', 'row' + (detailed ? ' detail' : ''));

    const dot = el('span', `dot ${a.region}`);
    const who = el('div', 'who');

    const label = el('div', 'label');
    label.append(document.createTextNode(a.label || a.uid));
    if (a.enterprise) label.append(el('span', 'badge', '企业'));
    label.append(el('span', `badge st-${level}`, V.healthText(level, lang)));

    const sub = el('div', 'sub');
    const reqs = a.use?.requests ? ` · ${a.use.requests} 次请求` : '';
    sub.textContent = detailed
      ? `${V.providerName(a.provider)} · ${a.domain || '—'} · ${a.phone || ''}${reqs}`
      : `${V.providerName(a.provider)} · ${a.phone || ''}${reqs}`;
    who.append(label, sub);

    const meta = el('div', 'meta' + (a.hoursLeft !== null && a.hoursLeft < 72 ? ' warn' : ''), V.left(a.expiresAt));

    // one row's own actions: test it, switch it off/on, remove it
    const acts = el('div', 'racts');
    const mk = (label, title, fn, cls) => {
      const b = el('button', 'ract' + (cls ? ` ${cls}` : ''), label);
      b.title = title;
      b.type = 'button';
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        fn();
      });
      return b;
    };
    acts.append(
      mk('测', '只检测这个账号（真发模型请求）', () => submitAction('test', [a.uid])),
      mk(a.disabled ? '启' : '停', a.disabled ? '重新启用' : '停用（从喜鹊登录态移除，凭证留底）', () =>
        submitAction(a.disabled ? 'enable' : 'disable', [a.uid]),
      ),
      mk('删', '从这个账号池删除', () => submitAction('delete', [a.uid]), 'danger'),
    );

    li.append(dot, who, meta, acts);

    if (detailed) {
      const kv = el('div', 'kv');
      const notes = a.healthNote || a.lastError;
      const facts = [
        ['uid', a.uid],
        ['key', a.key],
        ['账号名', a.accountId],
        ['区域依据', `${a.origin || '—'} / ${a.domain || '—'}`],
        ['实测模型', a.healthModel ? `${a.healthModel} · ${Math.round((a.healthMs || 0) / 100) / 10}s` : '—'],
        ['检测时间', a.checkedAt ? V.when(new Date(a.checkedAt).toISOString()) : '未检测'],
        ['用量', a.use?.requests ? `${a.use.requests} 请求 · 入 ${V.num(a.use.input)} · 出 ${V.num(a.use.output)}` : '无'],
        ['刷新剩余', a.refreshExpiresAt ? V.left(a.refreshExpiresAt) : '—'],
        ...(notes ? [['备注', notes]] : []),
      ];
      for (const [k, val] of facts) {
        const d = el('div');
        d.append(document.createTextNode(`${k} `), el('b', '', String(val ?? '—')));
        kv.append(d);
      }
      li.append(kv);
    }
    return li;
  }

  function paintGroups() {
    const host = $('groups');
    if (!snap) {
      host.replaceChildren();
      $('empty').hidden = true;
      $('error').hidden = false;
      $('error').textContent = t().noSnapshot;
      return;
    }
    $('error').hidden = true;

    const groups = V.groups(snap, { query: state.query, region: state.region });
    $('empty').hidden = groups.length > 0;

    host.replaceChildren(
      ...groups.map((g) => {
        const box = el('details', 'group');
        box.open = !state.closed.has(g.region);

        const summary = el('summary');
        summary.append(el('span', `dot ${g.region}`), el('span', '', g.label), el('span', 'count', String(g.rows.length)));

        box.addEventListener('toggle', () => {
          if (box.open) state.closed.delete(g.region);
          else state.closed.add(g.region);
          save();
        });

        const ul = el('ul', 'rows');
        ul.replaceChildren(...g.rows.map((a) => rowOf(a, state.view === 'detail')));
        box.append(summary, ul);
        return box;
      }),
    );
  }

  // ---- usage --------------------------------------------------------------
  function paintUsage() {
    if (!snap) return;
    $('usageTiles').replaceChildren(...tileRow(V.usageTiles(snap, lang)));

    // trend
    const bars = V.dayBars(snap);
    $('dayBars').replaceChildren(
      ...bars.map((d) => {
        const col = el('div', 'bar');
        col.title = `${d.date} · ${d.requests} 请求`;
        const fill = el('i');
        fill.style.height = `${d.height}%`;
        col.append(fill, el('span', 'bl', d.date.slice(5)));
        return col;
      }),
    );

    // by account
    const accounts = V.accountUsage(snap);
    $('usageAccounts').replaceChildren(
      ...accounts.map((a) => {
        const li = el('li', 'trow');
        const head = el('div', 'thead');
        head.append(el('span', 'tname', a.label), el('span', 'tnum', `${a.requests} 请求 · 入 ${V.num(a.input)} · 出 ${V.num(a.output)}`));
        li.append(head);

        if (a.requests) {
          const bar = el('span', 'tbar');
          const fill = el('i');
          const max = accounts[0]?.requests || 1;
          fill.style.width = `${Math.max(2, Math.round((a.requests / max) * 100))}%`;
          bar.append(fill);
          li.append(bar);
        }
        const sub = el('div', 'tsub');
        sub.textContent = [
          a.top ? `主力 ${a.top}` : '无请求',
          a.errors ? `${a.errors} 错误` : '',
          a.lastAt ? `最近 ${V.when(new Date(a.lastAt).toISOString())}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        li.append(sub);
        return li;
      }),
    );

    // by model
    const models = V.modelUsage(snap);
    $('usageModels').replaceChildren(
      ...models.map((m) => {
        const li = el('li', 'trow');
        const head = el('div', 'thead');
        head.append(el('span', 'tname', m.model), el('span', 'tnum', `${m.requests} 请求 · ${Math.round(m.share * 100)}%`));
        const bar = el('span', 'tbar');
        const fill = el('i');
        fill.style.width = `${Math.max(2, Math.round(m.share * 100))}%`;
        bar.append(fill);
        li.append(head, bar);
        const who = m.accounts.map((x) => `${x.account}(${x.requests})`).join(' · ');
        li.append(el('div', 'tsub', who));
        return li;
      }),
    );
  }

  // ---- routing ------------------------------------------------------------
  function paintRouting() {
    if (!snap) return;
    const rows = V.routingRows(snap);
    $('routingEmpty').hidden = rows.length > 0;
    $('routingList').replaceChildren(
      ...rows.map((r) => {
        const li = el('li', 'trow');
        const head = el('div', 'thead');
        head.append(el('span', 'tname', r.model), el('span', 'tnum', `${r.requests} 请求`));
        li.append(head);
        for (const a of r.accounts) {
          const line = el('div', 'share');
          line.append(el('span', 'shlab', a.account));
          const bar = el('span', 'shbar');
          const fill = el('i');
          fill.style.width = `${Math.max(2, Math.round(a.share * 100))}%`;
          bar.append(fill);
          line.append(bar, el('span', 'shnum', `${Math.round(a.share * 100)}% · ${a.requests}`));
          li.append(line);
        }
        return li;
      }),
    );
  }

  // ---- import -------------------------------------------------------------
  let picked = [];
  $('file').addEventListener('change', async (e) => {
    picked = [];
    for (const f of [...(e.target.files || [])]) {
      try {
        picked.push({ name: f.name, text: await f.text() });
      } catch {}
    }
    setStatus(picked.length ? `已选择 ${picked.length} 个文件` : '');
  });

  function setStatus(msg, bad) {
    const box = $('status');
    box.hidden = !msg;
    box.textContent = msg || '';
    box.classList.toggle('bad', Boolean(bad));
  }

  async function submitImport() {
    const pasted = $('paste').value.trim();
    const batches = [];
    if (picked.length) for (const f of picked) batches.push({ name: f.name, text: f.text });
    if (pasted) batches.push({ name: 'pasted.json', text: pasted });
    if (!batches.length) {
      setStatus('先粘贴 JSON 或选择文件', true);
      return;
    }

    const text =
      batches.length === 1
        ? batches[0].text
        : `[${batches.map((b) => b.text.replace(/^\s*\[|\]\s*$/g, '')).join(',')}]`;
    const name = batches.map((b) => b.name).join('+');

    try {
      opts = (await magpie.options.set({ ...opts, pendingImport: { name, text, at: Date.now() } })) || opts;
    } catch (e) {
      setStatus(`提交失败：${e.message}`, true);
      return;
    }

    setStatus('已提交，等待喜鹊应用…');
    $('importBtn').disabled = true;
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      let now = null;
      try {
        now = await magpie.options.get();
      } catch {}
      if (now && !now.pendingImport) {
        setStatus('导入完成，正在刷新…');
        location.reload();
        return;
      }
    }
    $('importBtn').disabled = false;
    setStatus('仍在等待：喜鹊下次加载插件时应用', true);
  }

  $('importBtn').addEventListener('click', submitImport);

  // ---- actions ------------------------------------------------------------
  // The page cannot touch the store or the network, so an action is written
  // into the plugin's options and the page waits for the plugin to take it.
  let acting = false;
  async function submitAction(type, uids, extra = {}) {
    if (acting) return;
    acting = true;
    note(`已提交：${ACTION_LABEL[type] ?? type}…`);
    try {
      opts = (await magpie.options.set({ ...opts, pendingAction: { type, uids, at: Date.now(), ...extra } })) || opts;
    } catch (e) {
      note(`提交失败：${e.message}`, true);
      acting = false;
      return;
    }
    // a test of many accounts takes minutes; the page reloads when the plugin
    // has cleared the action, and refreshes itself to show the verdicts
    for (let i = 0; i < 120; i++) {
      await sleep(1500);
      let now = null;
      try {
        now = await magpie.options.get();
      } catch {}
      if (now && !now.pendingAction) {
        note('完成，正在刷新…');
        location.reload();
        return;
      }
    }
    acting = false;
    note('仍在执行：喜鹊下次加载插件时会继续', true);
  }

  const ACTION_LABEL = {
    test: '检测',
    delete: '删除',
    enable: '启用',
    disable: '停用',
  };

  function note(msg, bad) {
    const box = $('actNote');
    box.textContent = msg || '';
    box.classList.toggle('bad', Boolean(bad));
  }

  $('testAll').addEventListener('click', () => submitAction('test', 'all'));
  $('testShown').addEventListener('click', () => {
    const rows = V.groups(snap, { query: state.query, region: state.region }).flatMap((g) => g.rows);
    const uids = rows.map((a) => a.uid).filter(Boolean);
    if (!uids.length) {
      note('当前筛选下没有账号', true);
      return;
    }
    submitAction('test', uids);
  });
  $('cleanDead').addEventListener('click', () => {
    const dead = (snap?.accounts ?? []).filter((a) => V.levelOf(a) === 'bad' || a.disabled).map((a) => a.uid);
    if (!dead.length) {
      note('没有失效账号可以清理');
      return;
    }
    if (!confirm(`清理 ${dead.length} 个失效/已关闭账号？它们会从账号池移除。`)) return;
    submitAction('delete', dead);
  });

  // ---- tabs & controls ----------------------------------------------------
  let saving = null;
  function save() {
    if (saving) return;
    saving = setTimeout(async () => {
      saving = null;
      try {
        opts = (await magpie.options.set({ ...opts, tab: state.tab, view: state.view, region: state.region, closed: [...state.closed] })) || opts;
      } catch {}
    }, 1100);
  }

  function paintTab() {
    seg('tabs', 'tab', state.tab);
    $('pane-accounts').hidden = state.tab !== 'accounts';
    $('pane-usage').hidden = state.tab !== 'usage';
    $('pane-routing').hidden = state.tab !== 'routing';
    if (state.tab === 'accounts') paintGroups();
    if (state.tab === 'usage') paintUsage();
    if (state.tab === 'routing') paintRouting();
  }

  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('button')?.dataset.tab;
    if (!tab || tab === state.tab) return;
    state.tab = tab;
    paintTab();
    save();
  });

  $('views').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.view;
    if (!v || v === state.view) return;
    state.view = v;
    seg('views', 'view', v);
    paintGroups();
    save();
  });

  $('regions').addEventListener('click', (e) => {
    const r = e.target.closest('button')?.dataset.region;
    if (!r || r === state.region) return;
    state.region = r;
    seg('regions', 'region', r);
    paintGroups();
    save();
  });

  let typing = null;
  $('search').addEventListener('input', (e) => {
    const q = e.target.value;
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.query = q;
      paintGroups();
    }, 120);
  });

  magpie.onTheme?.((theme) => {
    if (theme?.lang) lang = theme.lang;
    words();
    paintAll();
  });

  function paintAll() {
    if (snap) {
      paintTiles();
      seg('views', 'view', state.view);
      seg('regions', 'region', state.region);
    }
    paintTab();
  }

  if (opts?.pendingImport) setStatus('上次导入仍在等待喜鹊应用…');

  words();
  paintAll();
})();

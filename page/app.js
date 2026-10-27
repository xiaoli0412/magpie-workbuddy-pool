// The page: paints the snapshot the pool wrote for it, and takes an import.
//
// It has no network and asks magpie for no data (package.json declares no
// permissions). Everything shown comes from data.js. An import is handed to
// magpie through the one thing a page may write — its plugin's own options —
// and this page then waits for the plugin to take it and reloads itself.
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
    view: opts.view === 'detail' ? 'detail' : 'compact',
    region: ['all', 'cn', 'hmt', 'intl', 'unknown'].includes(opts.region) ? opts.region : 'all',
    query: '',
    closed: new Set(Array.isArray(opts.closed) ? opts.closed : []),
  };

  const t = () => V.text(lang);

  function words() {
    $('title').textContent = t().title;
    $('search').placeholder = t().search;
    $('importTitle').textContent = t().importTitle;
    $('footNote').textContent = t().foot;
    if (snap) $('since').textContent = `${t().since} ${V.when(snap.generatedAt)}`;
  }

  function seg(groupId, attr, value) {
    $(groupId).querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset[attr] === value)));
  }

  function paintTiles() {
    if (!snap) return;
    $('tiles').replaceChildren(
      ...V.tiles(snap, lang).map((tile) => {
        const d = document.createElement('div');
        d.className = 'tile' + (tile.bad ? ' bad' : '');
        const k = document.createElement('div');
        k.className = 'k';
        k.textContent = tile.label;
        const v = document.createElement('div');
        v.className = 'v';
        v.textContent = tile.value;
        const s = document.createElement('div');
        s.className = 's';
        s.textContent = tile.sub || '';
        d.append(k, v, s);
        return d;
      }),
    );
  }

  function rowOf(a, detailed) {
    const level = V.levelOf(a);
    const li = document.createElement('li');
    li.className = 'row' + (detailed ? ' detail' : '');

    const dot = document.createElement('span');
    dot.className = `dot ${a.region}`;

    const who = document.createElement('div');
    who.className = 'who';

    const label = document.createElement('div');
    label.className = 'label';
    label.append(document.createTextNode(a.label || a.uid));
    if (a.enterprise) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '企业';
      label.append(b);
    }
    const st = document.createElement('span');
    st.className = `badge st-${level}`;
    st.textContent = V.healthText(level, lang);
    label.append(st);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = detailed
      ? `${V.providerName(a.provider)} · ${a.domain || '—'} · ${a.phone || ''}`
      : `${V.providerName(a.provider)} · ${a.phone || ''}`;
    who.append(label, sub);

    const meta = document.createElement('div');
    meta.className = 'meta' + (a.hoursLeft !== null && a.hoursLeft < 72 ? ' warn' : '');
    meta.textContent = V.left(a.expiresAt);

    li.append(dot, who, meta);

    if (detailed) {
      const kv = document.createElement('div');
      kv.className = 'kv';
      const notes = a.healthNote || a.lastError;
      const facts = [
        ['uid', a.uid],
        ['key', a.key],
        ['domain', a.domain],
        ['来源', a.sourceFile || '—'],
        ['区域依据', `${a.origin || '—'} / ${a.domain || '—'}`],
        ['检测', a.checkedAt ? V.when(new Date(a.checkedAt).toISOString()) : '未检测'],
        ['续期', a.refreshedAt ? V.when(new Date(a.refreshedAt).toISOString()) : '—'],
        ['刷新剩余', a.refreshExpiresAt ? V.left(a.refreshExpiresAt) : '—'],
        ...(notes ? [['备注', notes]] : []),
      ];
      for (const [k, val] of facts) {
        const d = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = String(val ?? '—');
        d.append(document.createTextNode(`${k} `), b);
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
        const box = document.createElement('details');
        box.className = 'group';
        box.open = !state.closed.has(g.region);

        const summary = document.createElement('summary');
        const dot = document.createElement('span');
        dot.className = `dot ${g.region}`;
        const name = document.createElement('span');
        name.textContent = g.label;
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(g.rows.length);
        summary.append(dot, name, count);

        box.addEventListener('toggle', () => {
          if (box.open) state.closed.delete(g.region);
          else state.closed.add(g.region);
          save();
        });

        const ul = document.createElement('ul');
        ul.className = 'rows';
        ul.replaceChildren(...g.rows.map((a) => rowOf(a, state.view === 'detail')));
        box.append(summary, ul);
        return box;
      }),
    );
  }

  let saving = null;
  function save() {
    if (saving) return;
    saving = setTimeout(async () => {
      saving = null;
      try {
        opts = (await magpie.options.set({ ...opts, view: state.view, region: state.region, closed: [...state.closed] })) || opts;
      } catch {}
    }, 1100);
  }

  function paint() {
    seg('views', 'view', state.view);
    seg('regions', 'region', state.region);
    paintTiles();
    paintGroups();
  }

  // ---- import -------------------------------------------------------------

  let picked = [];
  $('file').addEventListener('change', async (e) => {
    picked = [];
    const files = [...(e.target.files || [])];
    for (const f of files) {
      try {
        picked.push({ name: f.name, text: await f.text() });
      } catch {}
    }
    setStatus(picked.length ? `已选择 ${picked.length} 个文件` : '');
  });

  function setStatus(msg, bad) {
    const el = $('status');
    el.hidden = !msg;
    el.textContent = msg || '';
    el.classList.toggle('bad', Boolean(bad));
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

    // A page may write only one thing, its plugin's options; the pool reads the
    // import from there on its next load. Files are joined into one payload so
    // one submission is one import.
    const text = batches.length === 1 ? batches[0].text : `[${batches.map((b) => b.text.replace(/^\s*\[|\]\s*$/g, '')).join(',')}]`;
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
    setStatus('仍在等待：喜鹊下次加载插件时应用（点上方刷新可查看结果）', true);
  }

  $('importBtn').addEventListener('click', submitImport);

  $('views').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.view;
    if (!v || v === state.view) return;
    state.view = v;
    paint();
    save();
  });

  $('regions').addEventListener('click', (e) => {
    const r = e.target.closest('button')?.dataset.region;
    if (!r || r === state.region) return;
    state.region = r;
    paint();
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
    paint();
  });

  // a pending import left by an earlier visit means the plugin has not run yet
  if (opts?.pendingImport) setStatus('上次导入仍在等待喜鹊应用…');

  words();
  paint();
})();

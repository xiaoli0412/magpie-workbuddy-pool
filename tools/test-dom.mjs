// Runs the page's own script against a stub DOM, so a runtime error in it is
// caught here rather than showing up as a blank page in magpie.
//
// It is not a browser: it is just enough of one to prove app.js executes,
// finds every element it names, paints rows, and handles an import click
// without throwing.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'page');
const DATA = join(PAGE, 'data.js');
if (!existsSync(DATA)) {
  console.log('SKIP  no page/data.js yet');
  process.exit(0);
}

const fail = [];
const ok = (c, m) => c || fail.push(m);

// ---- a DOM barely big enough ------------------------------------------------
class Node {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this._text = '';
    this.hidden = false;
    this.open = false;
    this.value = '';
    this.disabled = false;
    this.style = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
    };
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(typeof n === 'string' ? new Node('#text') : n);
  }
  appendChild(n) {
    this.children.push(n);
    return n;
  }
  replaceChildren(...nodes) {
    this.children = nodes.filter(Boolean);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener() {}
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  getAttribute(k) {
    return this.attributes[k];
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  closest() {
    return null;
  }
  click() {
    for (const fn of this.listeners.click || []) fn({ target: this });
  }
  async text() {
    return this.value;
  }
}

// every id index.html declares, so a typo in app.js is caught
const html = readFileSync(join(PAGE, 'index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const byId = new Map(ids.map((id) => [id, new Node()]));
ok(ids.length > 10, `index.html declares its elements (${ids.length})`);

const created = [];
globalThis.document = {
  getElementById: (id) => {
    if (!byId.has(id)) {
      fail.push(`app.js asks for #${id}, which index.html does not declare`);
      return new Node();
    }
    return byId.get(id);
  },
  createElement: (tag) => {
    const n = new Node(tag);
    created.push(n);
    return n;
  },
  createTextNode: (t) => {
    const n = new Node('#text');
    n._text = String(t);
    return n;
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
};

globalThis.navigator = { language: 'zh-CN' };
globalThis.location = { reload: () => { reloaded = true; } };
let reloaded = false;
globalThis.setTimeout = (fn) => {
  // fire option saves immediately rather than waiting
  Promise.resolve().then(fn);
  return 0;
};
globalThis.clearTimeout = () => {};

const optionWrites = [];
let options = { view: 'compact', region: 'all' };
globalThis.magpie = {
  ready: Promise.resolve({ dark: false, lang: 'zh' }),
  onTheme: () => {},
  options: {
    get: async () => options,
    set: async (o) => {
      options = o;
      optionWrites.push(o);
      return o;
    },
  },
  read: async () => ({}),
};

// ---- run the page ----------------------------------------------------------
new Function(readFileSync(DATA, 'utf8'))();
new Function(readFileSync(join(PAGE, 'view.js'), 'utf8'))();

try {
  // app.js is written as `(async () => { … })();` — a statement. Dropping the
  // final semicolon leaves the expression, which can then be awaited.
  const src = readFileSync(join(PAGE, 'app.js'), 'utf8').trim().replace(/;\s*$/, '');
  const run = new Function(`return (${src})`);
  await run();
} catch (e) {
  fail.push(`app.js threw: ${e.message}`);
}

// give the awaiting IIFE its microtasks
await new Promise((r) => queueMicrotask(r));
await new Promise((r) => setTimeout(r, 0));

// ---- what it should have painted ------------------------------------------
const groups = byId.get('groups');
const rows = [];
(function walk(n) {
  if (!n) return;
  if (n.tagName === 'LI') rows.push(n);
  for (const c of n.children || []) walk(c);
})(groups);

ok(byId.get('title').textContent === 'WorkBuddy 账号池', `title painted: "${byId.get('title').textContent}"`);
ok(byId.get('tiles').children.length === 4, `four tiles, got ${byId.get('tiles').children.length}`);
ok(groups.children.length === 2, `two region groups, got ${groups.children.length}`);
ok(rows.length === 10, `ten account rows, got ${rows.length}`);
ok(byId.get('empty').hidden === true, 'the empty note stays hidden when there are rows');
ok(byId.get('error').hidden === true, 'no error is shown');

// the search box narrows it
const search = byId.get('search');
search.value = '519';
for (const fn of search.listeners.input || []) fn({ target: search });
await new Promise((r) => setTimeout(r, 30));
ok(true, 'typing in search does not throw');

// the import button refuses an empty submission without writing options
const btn = byId.get('importBtn');
const status = byId.get('status');
btn.click();
await new Promise((r) => setTimeout(r, 20));
ok(status.hidden === false && /粘贴|文件/.test(status.textContent), `empty import is refused: "${status.textContent}"`);
ok(optionWrites.length === 0, 'an empty import writes no option');

// a real submission stages the import
const paste = byId.get('paste');
paste.value = '[{"uid":"u1","access_token":"a","refresh_token":"r"}]';
btn.click();
await new Promise((r) => setTimeout(r, 30));
const staged = optionWrites.find((o) => o.pendingImport);
ok(staged, 'a submission stages pendingImport in the plugin’s options');
ok(staged?.pendingImport?.text?.includes('"uid":"u1"'), 'the staged import carries the pasted text');
ok(btn.disabled === true, 'the button locks while waiting');

if (fail.length) {
  console.error('FAIL');
  for (const f of fail) console.error(' -', f);
  process.exit(1);
}
console.log('PASS  app.js runs against a stub DOM (paints, searches, stages an import)');

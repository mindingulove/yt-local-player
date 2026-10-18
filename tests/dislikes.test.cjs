const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const path = require('node:path');
const root = path.join(__dirname, '..');

function background(fetch) {
  let now = 0;
  const context = vm.createContext({
    fetch, AbortController, setTimeout, clearTimeout, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    browser: { runtime: { onMessage: { addListener() {} } } },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8') + '\nglobalThis.getDislikes = getDislikes;', context);
  return { get: context.getDislikes, advance: (ms) => { now += ms; } };
}
const id = 'abcdefghijk';
const response = (dislikes = 1234) => ({ ok: true, json: async () => ({ id, dislikes }) });

test('RYD lookup validates IDs, omits credentials, deduplicates, caches and expires', async () => {
  let requests = 0, resolve;
  const app = background((url, options) => {
    requests++;
    assert.equal(url, 'https://returnyoutubedislikeapi.com/votes?videoId=' + id);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return new Promise((r) => { resolve = r; });
  });
  assert.ok((await app.get('../bad')).error);
  assert.equal(requests, 0);
  const a = app.get(id), b = app.get(id);
  assert.equal(requests, 1);
  resolve(response());
  assert.equal((await a).dislikes, 1234);
  assert.equal((await b).dislikes, 1234);
  assert.equal((await app.get(id)).dislikes, 1234);
  assert.equal(requests, 1);
  app.advance(600001);
  const c = app.get(id);
  assert.equal(requests, 2);
  resolve(response(0));
  assert.equal((await c).dislikes, 0);
});

test('RYD backs off across videos on 429 and retries only after Retry-After', async () => {
  let requests = 0;
  const app = background(async () => {
    requests++;
    return requests === 1
      ? { ok: false, status: 429, headers: { get: () => '120' } }
      : response();
  });
  assert.match((await app.get(id)).error, /rate limited/);
  assert.match((await app.get('12345678901')).error, /rate limited/);
  app.advance(119999);
  assert.ok((await app.get(id)).error);
  assert.equal(requests, 1);
  app.advance(2);
  assert.equal((await app.get(id)).dislikes, 1234);
  assert.equal(requests, 2);
});

test('RYD handles missing, malformed and failed counts without inventing zero', async () => {
  for (const result of [
    { ok: false, status: 404 },
    { ok: true, json: async () => ({ id, dislikes: -1 }) },
    { ok: true, json: async () => ({ id, dislikes: '42' }) },
    { ok: true, json: async () => ({ id: 'wrong-video', dislikes: 42 }) },
    { ok: true, json: async () => ({ id, dislikes: 42, deleted: true }) },
    new Error('offline'),
  ]) {
    let requests = 0;
    const app = background(async () => { requests++; if (result instanceof Error) throw result; return result; });
    assert.ok((await app.get(id)).error);
    assert.ok((await app.get(id)).error);
    assert.equal(requests, 1);
  }
});

function content(sendMessage, timers = { setTimeout, clearTimeout }) {
  let code = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  code = code.slice(0, code.indexOf('  // Only one copy of this script'));
  code += `\nglobalThis.dislikes = {
    load: loadDislikes, render: renderDislikes,
    set: (next, id) => { clearDislikes(); overlay = next; currentId = id; },
    enable: (value) => { settings.returnDislike = value; },
  }; })();`;
  const element = () => ({
    children: [], ownText: '',
    get textContent() { return this.ownText + this.children.map(c => c.textContent || '').join(''); },
    set textContent(value) { this.ownText = value; this.children = []; },
    append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } },
    querySelector() { return this.children.find(c => c.className === 'ylp-native-dislikes') || null; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); },
    setAttribute(key, value) { this[key] = value; },
  });
  const button = element();
  const location = { pathname: '/watch', search: '?v=' + id };
  const context = vm.createContext({
    browser: { runtime: { sendMessage } }, location, URLSearchParams, ...timers,
    document: {
      createElement: element, querySelector: () => button,
      querySelectorAll: () => button.children.filter(c => c.className === 'ylp-native-dislikes'),
    },
  });
  vm.runInContext(code, context);
  return { ...context.dislikes, button, location, count: () => button.querySelector() };
}

test('RYD annotates only the native dislike button; handles zero, toggle and unavailable', async () => {
  let requests = 0;
  const app = content(async () => { requests++; return { dislikes: 0 }; });
  app.set({}, id);
  app.enable(false);
  await app.load();
  assert.equal(requests, 0);
  assert.equal(app.count(), null);
  app.enable(true);
  await app.load();
  assert.match(app.count().textContent, /≈ 0/);
  assert.match(app.count()['aria-label'], /Estimated dislikes: 0/);
  await app.load();
  assert.equal(requests, 1);
  app.enable(false);
  await app.load();
  assert.equal(app.count(), null);
  const failed = content(async () => { throw new Error('offline'); });
  failed.set({}, id);
  await failed.load();
  assert.equal(failed.count().textContent, '—');
});

test('RYD leaves existing native counts untouched and restores after YouTube rebuilds the button', async () => {
  const app = content(async () => ({ dislikes: 3400 }));
  app.button.ownText = '3.4K';
  app.set({}, id);
  await app.load();
  assert.equal(app.count(), null, 'do not duplicate an already working count');
  assert.equal(app.button.textContent, '3.4K');
  app.button.ownText = '';
  app.render();
  assert.match(app.count().textContent, /3.4/);
  app.count().remove();
  app.render();
  assert.match(app.count().textContent, /3.4/);
  app.button.ownText = '3.4K';
  app.render();
  assert.equal(app.count(), null);
});

test('late RYD responses cannot update a new video, mini-player page, or disabled count', async () => {
  let resolve;
  const app = content(() => new Promise((r) => { resolve = r; }));
  app.set({}, id);
  const pending = app.load();
  const next = {};
  app.set(next, '12345678901');
  app.location.search = '?v=12345678901';
  resolve({ dislikes: 10 });
  await pending;
  assert.equal(next.dislikeVotes, undefined);
  const current = app.load();
  app.enable(false);
  resolve({ dislikes: 20 });
  await current;
  assert.equal(app.count(), null);
  app.enable(true);
  app.location.pathname = '/';
  app.render();
  assert.equal(app.count(), null);
});


test('unanswered background messages stop showing loading after the content timeout', async () => {
  let expire;
  const app = content(() => new Promise(() => {}), {
    setTimeout: (callback, ms) => { assert.equal(ms, 12000); expire = callback; return 1; },
    clearTimeout() {},
  });
  const target = {};
  app.set(target, id);
  const pending = app.load();
  assert.equal(app.count().textContent, '…');
  expire();
  await pending;
  assert.equal(target.dislikeLoading, false);
  assert.equal(app.count().textContent, '—');
});

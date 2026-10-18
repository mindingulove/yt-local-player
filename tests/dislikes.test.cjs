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

function content(sendMessage) {
  let code = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  code = code.slice(0, code.indexOf('  // Only one copy of this script'));
  code += `\nglobalThis.dislikes = {
    load: loadDislikes,
    set: (next, id) => { overlay = next; currentId = id; },
    enable: (value) => { settings.returnDislike = value; },
  }; })();`;
  const element = () => ({
    children: [], append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this[key] = value; },
  });
  const context = vm.createContext({
    browser: { runtime: { sendMessage } }, document: { createElement: element },
  });
  vm.runInContext(code, context);
  return { ...context.dislikes, target: () => ({ dislikeSlot: element() }) };
}

test('dislike chip handles zero, attribution, toggle, unavailable and toolbar rebuild', async () => {
  let requests = 0;
  const app = content(async () => { requests++; return { dislikes: 0 }; });
  const target = app.target();
  app.set(target, id);
  app.enable(false);
  await app.load();
  assert.equal(requests, 0);
  assert.equal(target.dislikeSlot.hidden, true);
  app.enable(true);
  await app.load();
  const link = target.dislikeSlot.children[0];
  assert.match(link.children[0], /≈0/);
  assert.equal(link.href, 'https://returnyoutubedislike.com/');
  assert.match(link['aria-label'], /Estimated dislikes: 0/);
  target.dislikeSlot = app.target().dislikeSlot;
  await app.load();
  assert.equal(requests, 1);
  assert.match(target.dislikeSlot.children[0].children[0], /≈0/);
  app.enable(false);
  await app.load();
  assert.equal(target.dislikeSlot.children.length, 0);
  const failed = content(async () => { throw new Error('offline'); });
  const unavailable = failed.target();
  failed.set(unavailable, id);
  await failed.load();
  assert.match(unavailable.dislikeSlot.children[0].children[0], /—/);
});

test('late RYD responses cannot update a new overlay or show a disabled count', async () => {
  let resolve;
  const app = content(() => new Promise((r) => { resolve = r; }));
  const old = app.target();
  app.set(old, id);
  const pending = app.load();
  const next = app.target();
  app.set(next, '12345678901');
  resolve({ dislikes: 10 });
  await pending;
  assert.equal(next.dislikeVotes, undefined);
  const current = app.load();
  app.enable(false);
  resolve({ dislikes: 20 });
  await current;
  assert.equal(next.dislikeSlot.hidden, true);
  assert.equal(next.dislikeSlot.children.length, 0);
});

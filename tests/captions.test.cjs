const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('empty web caption files fall back to the iOS client caption URL', async () => {
  let code = readFileSync(join(__dirname, '../extension/content.js'), 'utf8');
  code = code.slice(0, code.indexOf('  // Only one copy of this script'));
  code += '\n globalThis.run = (data, track) => { info = data; currentId = "vid"; return captionText(track); }; })();';
  const bodies = { 'https://web.invalid/cc': '', 'https://ios.invalid/cc': 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n' };
  const fetched = [];
  const context = vm.createContext({
    URL, browser: {},
    fetch: async (url) => (fetched.push(url), { ok: true, text: async () => bodies[url] }),
  });
  context.YLP = { getAppCaptions: async (id) => (assert.equal(id, 'vid'), [{ lang: 'en', auto: false, url: 'https://ios.invalid/cc' }]) };
  vm.runInContext(code, context);
  const vtt = await context.run({}, { lang: 'en', auto: false, url: 'https://web.invalid/cc' });
  assert.match(vtt, /-->/);
  assert.deepEqual(fetched, ['https://web.invalid/cc', 'https://ios.invalid/cc']);
});

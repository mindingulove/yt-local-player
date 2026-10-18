const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const root = require('node:path').join(__dirname, '..');

test('player API identifies active/upcoming broadcasts and allows archives', async () => {
  for (const response of [
    { videoDetails: { isLive: true } },
    { microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } } },
    { videoDetails: { isUpcoming: true } },
    { playabilityStatus: { status: 'LIVE_STREAM_OFFLINE' } },
    { videoDetails: { isLiveContent: true }, microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, endTimestamp: '2026-10-12' } } } },
  ]) {
    let requests = 0;
    const context = vm.createContext({
      document: { scripts: [{ textContent: '"VISITOR_DATA":"test"' }] },
      navigator: { language: 'en-US', userAgent: 'test' },
      fetch: async () => {
        requests++;
        return { ok: true, json: async () => response };
      },
    });
    vm.runInContext(fs.readFileSync(root + '/extension/lib/innertube.js', 'utf8'), context);
    const info = await context.YLP.getPlayer('test');
    const archived = !!response.videoDetails?.isLiveContent;
    assert.equal(info.isLive || info.isUpcoming, !archived);
    assert.equal(requests, archived ? 3 : 1);
  }
});

function lifecycle(getPlayer, source = 'browser') {
  // Expose lifecycle functions without registering browser listeners. Reaching
  // buildOverlay marks the first player mutation; live pages must never do so.
  let code = fs.readFileSync(root + '/extension/content.js', 'utf8');
  code = code.slice(0, code.indexOf('  // Only one copy of this script'));
  code += `\nsettings.source = ${JSON.stringify(source)};
    buildOverlay = () => { throw new Error('takeover'); };
    globalThis.lifecycle = { setup, teardown, current: () => currentId };
  })();`;
  const classes = { remove() {} };
  const player = { classList: classes };
  const context = vm.createContext({
    YLP: { getPlayer },
    browser: {},
    document: { documentElement: { dataset: {}, classList: classes }, querySelector: () => player, querySelectorAll: () => [] },
    performance: { now: () => 0 },
    clearTimeout, clearInterval, setTimeout,
  });
  vm.runInContext(code, context);
  return context.lifecycle;
}

test('live and upcoming streams bypass takeover in both sources; next VOD takes over', async () => {
  for (const source of ['browser', 'helper']) {
    for (const flag of ['isLive', 'isUpcoming']) {
      const app = lifecycle(async (id) => id === 'live' ? { [flag]: true } : {}, source);
      await app.setup('live');
      assert.equal(app.current(), 'live');
      app.teardown();
      await assert.rejects(app.setup('vod'), /takeover/);
    }
  }
});

test('navigation cancels a pending takeover, including returning to the same ID', async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const app = lifecycle(() => pending);
  const old = app.setup('same');
  app.teardown();
  const latest = app.setup('same');
  resolve({});
  await old;
  await assert.rejects(latest, /takeover/);
});

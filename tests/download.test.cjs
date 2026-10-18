const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { test } = require('node:test');
const root = path.join(__dirname, '..');

function app(getPlayer) {
  let downloads = 0;
  const label = { textContent: 'Save' };
  const classes = new Set();
  const button = {
    querySelector: () => label,
    classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
  };
  const target = { saveBtn: button, saveLabel: {}, audioTrackId: null };
  let code = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  code = code.slice(0, code.indexOf('  // Only one copy of this script'));
  code += `\nselectedQuality = () => 'auto'; globalThis.download = {
    setup: (data, target) => { info = data; overlay = target; currentId = 'abcdefghijk'; settings.saveEnabled = true; },
    render: renderSaveButton, save,
    disable: () => { settings.saveEnabled = false; },
    navigate: () => { saveAbort?.abort(); overlay = {}; },
    currentInfo: () => info,
  }; })();`;
  const context = vm.createContext({
    AbortController, DOMException, Blob, browser: {},
    URL: { createObjectURL: () => 'blob:download', revokeObjectURL() {} },
    setTimeout: () => 1,
    document: { createElement: () => ({ append() {}, click() { downloads++; } }) },
    YLP: { getPlayer, downloadFormat: async (f, progress) => { progress(+f.contentLength); return new Uint8Array(1); }, mux: () => [new Uint8Array(1)] },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/lib/audio.js'), 'utf8'), context);
  vm.runInContext(code, context);
  return { ...context.download, target, button, label, downloads: () => downloads };
}
const hlsOnly = () => ({ ok: true, hls: 'https://media.invalid/master', title: 'Test', videoFormats: [], audioFormats: [], audioTracks: [] });
const mp4 = () => ({ ok: true, videoFormats: [{ height: 720, contentLength: '100' }], audioFormats: [{ contentLength: '20' }], audioTracks: [] });

test('enabled Save remains visible for HLS-only playback and requests MP4 streams on click', async () => {
  let requests = 0;
  const player = hlsOnly();
  const ui = app(async (id, options) => {
    requests++;
    assert.equal(options.requireMp4, true);
    assert.equal(id, 'abcdefghijk');
    return mp4();
  });
  ui.setup(player, ui.target);
  ui.render();
  assert.equal(ui.button.hidden, false);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.label.textContent, 'Save');
  await ui.save();
  assert.equal(requests, 1);
  assert.equal(ui.downloads(), 1);
  assert.equal(ui.currentInfo(), player, 'download lookup must not replace playback metadata');
  assert.equal(ui.target.saveLabel.textContent, 'Saved ✓');
  ui.disable(); ui.render();
  assert.equal(ui.button.hidden, true);
});

test('Save reports streaming-only format failures visibly instead of disappearing or saving empty files', async () => {
  const ui = app(async () => hlsOnly());
  ui.setup(hlsOnly(), ui.target);
  await ui.save();
  assert.equal(ui.downloads(), 0);
  assert.equal(ui.button.hidden, false);
  assert.match(ui.target.saveLabel.textContent, /streaming-only formats/);
});

test('navigation cancels an outstanding download lookup and cannot save a stale video', async () => {
  let resolve;
  const ui = app(() => new Promise(r => { resolve = r; }));
  ui.setup(hlsOnly(), ui.target);
  const pending = ui.save();
  assert.equal(ui.label.textContent, 'Cancel');
  ui.navigate();
  resolve(mp4());
  await pending;
  assert.equal(ui.downloads(), 0);
  assert.equal(ui.target.saveLabel.textContent, 'Cancelled');
});

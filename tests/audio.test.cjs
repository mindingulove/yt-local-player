const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const audioCode = readFileSync(join(__dirname, '../extension/lib/audio.js'), 'utf8');
const ctx = vm.createContext({ URL });
vm.runInContext(audioCode, ctx);
const audio = ctx.YLP;
const tracks = [
  { id: 'ja.10', lang: 'ja', name: 'Japanese' },
  { id: 'en-US.4', lang: 'en-US', name: 'English original', isDefault: true },
];
const manifest = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=300,CODECS="mp4a.40.2,avc1.4D401F"
https://media.invalid/ja/xtags/lang%3Dja%3Aacont%3Ddubbed/720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=100
https://media.invalid/en/xtags/lang%253Den-US/360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=250
https://media.invalid/en/xtags/lang%3Den-US/720.m3u8
`;

test('default audio wins over track order and bitrate; manual choice stays per video', () => {
  const info = { audioTracks: tracks, audioFormats: [
    { bitrate: 256000, audioTrack: { id: 'ja.10' } },
    { bitrate: 128000, audioTrack: { id: 'en-US.4' } },
  ] };
  assert.equal(audio.selectedAudioTrack(info).id, 'en-US.4');
  assert.equal(audio.audioFormatsForTrack(info)[0].bitrate, 128000);
  assert.equal(audio.audioFormatsForTrack(info, 'ja.10')[0].bitrate, 256000);
  assert.equal(audio.selectedAudioTrack(info).id, 'en-US.4');
  assert.equal(audio.selectedAudioTrack(info, 'missing').id, 'en-US.4');
});

test('Auto retains adaptive qualities for one language without mixing dubs', () => {
  const english = audio.filterHlsAudio(manifest, tracks[1], 'https://media.invalid/master');
  assert.equal((english.match(/#EXT-X-STREAM-INF/g) || []).length, 2);
  assert.ok(english.includes('INDEPENDENT-SEGMENTS'));
  assert.ok(!english.includes('/ja/'));
  const japanese = audio.filterHlsAudio(manifest, tracks[0], 'https://media.invalid/master');
  assert.equal((japanese.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
  assert.ok(!japanese.includes('/en/'));
  assert.throws(() => audio.filterHlsAudio(manifest, { lang: 'fr', name: 'French' }, 'https://media.invalid/master'), /No HLS/);
});

test('default can use untagged variants; media playlists remain intact', () => {
  const untagged = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n360.m3u8\n';
  assert.ok(audio.filterHlsAudio(untagged, tracks[1], 'https://media.invalid/base/master').includes('https://media.invalid/base/360.m3u8'));
  const media = '#EXTM3U\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n';
  assert.equal(audio.filterHlsAudio(media, tracks[1], 'https://media.invalid/base'), media);
});

test('playlist loader filters only master manifests and keeps signed child URLs unchanged', () => {
  class Loader {
    load(context, config, callbacks) { callbacks.onSuccess({ data: config.data, url: context.url }, {}, context); }
  }
  const Hls = { DefaultConfig: { loader: Loader } };
  const Filtered = audio.audioPlaylistLoader(Hls, tracks[1]);
  let result;
  const callbacks = { onSuccess: (r) => { result = r.data; }, onError: () => assert.fail('unexpected loader error') };
  new Filtered().load({ type: 'manifest', url: 'https://media.invalid/master' }, { data: manifest }, callbacks);
  assert.ok(!result.includes('/ja/'));
  new Filtered().load({ type: 'level', url: 'https://media.invalid/child?signed=1' }, { data: manifest }, callbacks);
  assert.equal(result, manifest);
});

test('Safari uses the filtered HLS loader for multilingual Auto and retains position when switching', async () => {
  const instances = [];
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    static DefaultConfig = { loader: class {} };
    constructor(config) { this.config = config; instances.push(this); }
    on() {} loadSource(url) { this.url = url; } attachMedia() {} destroy() {}
  }
  let code = readFileSync(join(__dirname, '../extension/content.js'), 'utf8');
  code = code.slice(0, code.indexOf('  // Only one copy of this script'));
  code += `
    showVideo = restoreCaptionMode = renderSaveButton = () => {};
    resumeAt = (at, paused) => globalThis.resumed = {at, paused};
    globalThis.runQuality = async (data, trackId) => {
      info = data;
      overlay = {audioTrackId: trackId, video: {currentTime: 42, paused: true, addEventListener() {}, canPlayType: () => 'probably'}};
      await applyQuality('auto');
    };
  })();`;
  const context = vm.createContext({ URL, Hls, browser: {} });
  vm.runInContext(audioCode, context);
  vm.runInContext(code, context);
  await context.runQuality({ hls: 'https://media.invalid/master', audioTracks: tracks }, null);
  assert.equal(instances.length, 1);
  assert.ok(instances[0].config.pLoader);
  assert.equal(context.resumed.at, 42);
  assert.equal(context.resumed.paused, true);
});

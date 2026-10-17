const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('decodes HLS path and query signatures with dynamic code generation disabled', () => {
  execFileSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { evaluatePlayer, decipherStreams } from './scripts/decipher-entry.mjs';
    assert.deepEqual(await evaluatePlayer({output: 'class Token { value() { return "decoded"; } }; return {n: new Token().value()};'}), {n: 'decoded'});
    const seen = [];
    const decoder = { decipher: async (url, signatureCipher) => {
      seen.push([url, signatureCipher]);
      if (signatureCipher) return 'https://media.invalid/video?signature=decoded';
      return url.replace('raw-token', 'decoded-token');
    }};
    const result = await decipherStreams({streamingData: {
      hlsManifestUrl: 'https://media.invalid/n/raw-token/index.m3u8',
      adaptiveFormats: [{itag: 137, signatureCipher: 'encrypted'}],
    }}, async () => decoder);
    assert.equal(result.streamingData.hlsManifestUrl, 'https://media.invalid/n/decoded-token/index.m3u8');
    assert.equal(result.streamingData.adaptiveFormats[0].url, 'https://media.invalid/video?signature=decoded');
    assert.equal(result.streamingData.adaptiveFormats[0].itag, 137);
    const query = await decipherStreams({streamingData: {hlsManifestUrl: 'https://media.invalid/playlist?n=raw-token'}}, async () => decoder);
    assert.equal(query.streamingData.hlsManifestUrl, 'https://media.invalid/playlist?n=decoded-token');
    const plain = {streamingData: {hlsManifestUrl: 'https://media.invalid/plain.m3u8'}};
    assert.equal(await decipherStreams(plain, () => { throw new Error('Unneeded decoder request'); }), plain);
    await assert.rejects(decipherStreams({streamingData: {hlsManifestUrl: 'https://media.invalid/n/raw-token/a'}}, async () => ({decipher: async () => 'https://media.invalid/?n=enhanced_except_failure'})), /signature/);
  `], { cwd: join(__dirname, '..'), stdio: 'pipe' });
});

test('fixed-quality preference falls back to Auto for HLS-only responses', () => {
  let code = readFileSync(join(__dirname, '../extension/content.js'), 'utf8');
  code = code.slice(0, code.indexOf('  // Only one copy of this script'));
  code += '\n globalThis.choose = (data, preference) => { info = data; settings.quality = preference; return selectedQuality(); }; })();';
  const ctx = vm.createContext({ YLP: { playableVideoFormats: (info) => info.videoFormats }, browser: {} });
  vm.runInContext(code, ctx);
  assert.equal(ctx.choose({ hls: 'manifest', videoFormats: [] }, 1080), 'auto');
  assert.equal(ctx.choose({ hls: 'manifest', videoFormats: [{ height: 720 }] }, 1080), 720);
});

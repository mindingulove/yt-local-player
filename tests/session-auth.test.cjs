const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createContext, runInContext } = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { test } = require('node:test');

const code = readFileSync(join(__dirname, '../extension/lib/innertube.js'), 'utf8');
const playable = (id) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: id },
  streamingData: { hlsManifestUrl: 'https://example.invalid/manifest.m3u8' },
});
const blocked = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };

function client(respond, options = {}) {
  const config = {
    VISITOR_DATA: 'visitor',
    INNERTUBE_CLIENT_VERSION: 'page-version',
    INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: 'page-version', hl: 'en', gl: 'BR' } },
    ...options.config,
  };
  const document = {
    cookie: options.cookies || '',
    scripts: [{ textContent: `ytcfg.set(${JSON.stringify(config)});` }],
  };
  if (options.player) document.scripts.push({ textContent: `var ytInitialPlayerResponse = ${JSON.stringify(options.player)};` });
  const requests = [];
  const ctx = createContext({
    document, crypto: webcrypto, TextEncoder,
    location: { origin: options.origin || 'https://www.youtube.com' },
    navigator: { language: 'en-GB', userAgent: 'Safari' },
    fetch: async (url, init) => {
      const request = { url, ...init, body: JSON.parse(init.body) };
      requests.push(request);
      return { ok: true, json: async () => respond(request, requests.length) };
    },
  });
  runInContext(code, ctx);
  return { getPlayer: ctx.YLP.getPlayer, requests, document };
}

test('web request carries browser cookies, matching session, account and valid cookie hashes', async () => {
  const app = client(() => playable('video'), {
    cookies: 'SAPISID=test-session; __Secure-1PAPISID=first-party; __Secure-3PAPISID=third-party',
    config: { SESSION_INDEX: 2, LOGGED_IN: true, DELEGATED_SESSION_ID: 'channel-id' },
  });
  assert.equal((await app.getPlayer('video')).client, 'WEB');
  const req = app.requests[0];
  assert.equal(req.credentials, 'include');
  assert.equal(req.redirect, 'error');
  assert.equal(req.headers['X-Goog-AuthUser'], '2');
  assert.equal(req.headers['X-Goog-PageId'], 'channel-id');
  assert.equal(req.headers['X-Youtube-Bootstrap-Logged-In'], 'true');
  assert.equal(req.headers['X-Origin'], 'https://www.youtube.com');
  assert.equal(req.body.context.client.visitorData, 'visitor');
  assert.equal(req.body.context.client.gl, 'BR');
  const tokens = req.headers.Authorization.split(' ');
  for (const [i, scheme, sid] of [[0, 'SAPISIDHASH', 'test-session'], [2, 'SAPISID1PHASH', 'first-party'], [4, 'SAPISID3PHASH', 'third-party']]) {
    assert.equal(tokens[i], scheme);
    const [timestamp, hash] = tokens[i + 1].split('_');
    assert.equal(hash, createHash('sha1').update(`${timestamp} ${sid} https://www.youtube.com`).digest('hex'));
  }
  assert.ok(!JSON.stringify(req).includes('test-session'));
});

test('retry rereads rotated cookies and supports 3P cookie without SAPISID', async () => {
  const app = client(() => playable('video'), { cookies: '__Secure-3PAPISID=old' });
  await app.getPlayer('video');
  app.document.cookie = '__Secure-3PAPISID=new';
  await app.getPlayer('video');
  assert.match(app.requests[1].headers.Authorization, /^SAPISIDHASH /);
  assert.notEqual(app.requests[0].headers.Authorization, app.requests[1].headers.Authorization);
});

test('mobile cookies and authorization use the same YouTube origin', async () => {
  const app = client(() => playable('video'), { origin: 'https://m.youtube.com', cookies: 'SAPISID=mobile' });
  await app.getPlayer('video');
  assert.ok(app.requests[0].url.startsWith('https://m.youtube.com/'));
  assert.equal(app.requests[0].headers['X-Origin'], 'https://m.youtube.com');
});

test('logged-out request uses browser cookies without fabricating authorization', async () => {
  const app = client(() => playable('video'));
  await app.getPlayer('video');
  assert.equal(app.requests[0].credentials, 'include');
  assert.equal(app.requests[0].headers.Authorization, undefined);
});

test('app fallback receives neither login cookies nor web authorization', async () => {
  const app = client((req) => req.body.context.client.clientName === 'WEB' ? blocked : playable('video'), { cookies: 'SAPISID=secret' });
  assert.equal((await app.getPlayer('video')).client, 'VISIONOS');
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].credentials, 'omit');
  assert.equal(app.requests[1].headers.Authorization, undefined);
});

test('reuses current page streams but never streams for a previous SPA video', async () => {
  const app = client(() => playable('next'), { player: playable('current') });
  assert.equal((await app.getPlayer('current')).client, 'WEB_PAGE');
  assert.equal(app.requests.length, 0);
  assert.equal((await app.getPlayer('next')).client, 'WEB');
  assert.equal(app.requests[0].body.videoId, 'next');
});

test('web cipher-only response does not prevent trying an app client', async () => {
  const app = client((req) => req.body.context.client.clientName === 'WEB' ? {
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [{ signatureCipher: 'encrypted', mimeType: 'video/mp4' }] },
  } : playable('video'));
  assert.equal((await app.getPlayer('video')).client, 'VISIONOS');
});

test('preserves login challenge when all clients reject playback', async () => {
  const app = client(() => blocked);
  const info = await app.getPlayer('video');
  assert.equal(info.loginRequired, true);
  assert.equal(info.reason, blocked.playabilityStatus.reason);
  assert.equal(app.requests.length, 3);
});

test('page config with braces and escaped quotes is parsed as data', async () => {
  const app = client(() => playable('video'), { config: { unused: '}; malicious("quoted")', SESSION_INDEX: 3 } });
  await app.getPlayer('video');
  assert.equal(app.requests[0].headers['X-Goog-AuthUser'], '3');
});

test('failed page and web streams can advance to another client without reusing them', async () => {
  const app = client(() => playable('video'), { player: playable('video') });
  assert.equal((await app.getPlayer('video')).client, 'WEB_PAGE');
  assert.equal((await app.getPlayer('video', { skipClients: ['WEB_PAGE'] })).client, 'WEB');
  assert.equal((await app.getPlayer('video', { skipClients: ['WEB_PAGE', 'WEB'] })).client, 'VISIONOS');
  assert.equal((await app.getPlayer('video', { skipClients: ['WEB_PAGE', 'WEB', 'VISIONOS'] })).client, 'IOS');
  assert.equal(app.requests.length, 3);
});

test('download lookup skips HLS-only results without changing normal playback selection', async () => {
  const mp4 = {
    ...playable('video'), streamingData: { adaptiveFormats: [
      { url: 'https://media.invalid/video', mimeType: 'video/mp4; codecs="avc1"', indexRange: { start: 0, end: 1 }, contentLength: '100', height: 720 },
      { url: 'https://media.invalid/audio', mimeType: 'audio/mp4', indexRange: { start: 0, end: 1 }, contentLength: '20' },
    ] },
  };
  const app = client((req) => req.body.context.client.clientName === 'WEB' ? playable('video') : mp4, { player: playable('video') });
  assert.equal((await app.getPlayer('video')).client, 'WEB_PAGE');
  assert.equal(app.requests.length, 0);
  const download = await app.getPlayer('video', { requireMp4: true });
  assert.equal(download.client, 'VISIONOS');
  assert.equal(download.videoFormats.length, 1);
  assert.equal(download.audioFormats.length, 1);
});

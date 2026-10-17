// Bundle only the player URL decoder, not a second InnerTube/session client.
import { Player, Platform } from 'youtubei.js/web';
import Sval from 'sval';

// An interpreter works under YouTube's CSP without eval/new Function.
export async function evaluatePlayer(data) {
  const vm = new Sval({ ecmaVer: 'latest', sandBox: true });
  vm.run(`exports.result = (function () { ${data.output}\n})();`);
  return vm.exports.result;
}
Platform.shim.eval = evaluatePlayer;

let pending;
function getDecoder() {
  if (!pending) {
    const sources = Array.from(document.scripts, (script) => `${script.src || ''}\n${script.textContent}`);
    const id = sources.join('\n').match(/\/s\/player\/([a-zA-Z0-9_-]+)\//)?.[1];
    pending = Player.create(undefined, (url, options) => fetch(url, { ...options, credentials: 'include' }), undefined, id)
      .catch((error) => { pending = null; throw error; });
  }
  return pending;
}

export async function decipherStreams(response, decoderFactory = getDecoder) {
  const sd = response.streamingData;
  if (!sd) return response;
  const formats = [...(sd.adaptiveFormats || []), ...(sd.formats || [])];
  const needs = (url) => url && /(?:[?&]n=|\/n\/)/.test(url);
  if (!needs(sd.hlsManifestUrl) && !formats.some((f) => f.signatureCipher || f.cipher || needs(f.url))) return response;
  const decoder = await decoderFactory();
  const cache = new Map();
  const decode = async (url, signatureCipher, cipher) => {
    if (url && /\/n\/([^/]+)/.test(url)) {
      const token = url.match(/\/n\/([^/]+)/)[1];
      const result = await decoder.decipher(`https://www.youtube.com/?n=${encodeURIComponent(decodeURIComponent(token))}`, undefined, undefined, cache);
      const transformed = new URL(result).searchParams.get('n');
      if (!transformed || transformed.startsWith('enhanced_except_')) throw new Error('YouTube stream signature could not be decoded');
      return url.replace(`/n/${token}`, `/n/${encodeURIComponent(transformed)}`);
    }
    return decoder.decipher(url, signatureCipher, cipher, cache);
  };
  const decodeFormat = async (format) => ({
    ...format,
    url: format.url || format.signatureCipher || format.cipher ? await decode(format.url, format.signatureCipher, format.cipher) : undefined,
  });
  return {
    ...response,
    streamingData: {
      ...sd,
      hlsManifestUrl: sd.hlsManifestUrl ? await decode(sd.hlsManifestUrl) : undefined,
      adaptiveFormats: await Promise.all((sd.adaptiveFormats || []).map(decodeFormat)),
      formats: await Promise.all((sd.formats || []).map(decodeFormat)),
    },
  };
}

globalThis.YLP = Object.assign(globalThis.YLP || {}, { decipherStreams });

# Vendored libraries

- `hls.min.js`: [hls.js](https://github.com/video-dev/hls.js) 1.7.3 (`dist/hls.min.js` from npm),
  Apache License 2.0. Bundled only into the Chrome and Firefox builds, which lack native HLS.
- `extension/lib/decipher.js`: built from `scripts/decipher-entry.mjs`, YouTube.js 18.1.0
  and Sval 0.6.12. Rebuild with `npm ci --ignore-scripts && npm run build:decipher`.
  All bundled licences are emitted into `extension/lib/decipher.LICENSE.txt`.
- `protobuf-es.LICENSE` and `protobuf-upstream.LICENSE`: upstream licence texts for the
  Protobuf-ES dependency included in the decoder bundle.

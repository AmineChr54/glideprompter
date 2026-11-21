// Follow mode voice pack: the speech runtime + model, downloaded on demand into the user data folder.
// The file list, sizes and SHA-256 hashes are fixed here, and the download URL pins an exact commit,
// so a changed upload is refused instead of loaded.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PACK = {
  id: 'en-1',
  label: 'English voice pack',
  repo: 'aminechr54/glideprompter-voice-en',
  revision: '765a994ac4bcf999d0ede5141c856e78717990b8',
  model: { kind: 'nemoCtc', model: 'model/model.int8.onnx', tokens: 'model/tokens.txt', vad: 'model/silero_vad.onnx' },
  // From tools/follow/build-pack.js (.dev/pack/en-1/manifest.json)
  files: [
    { path: 'runtime/sherpa-onnx.node', size: 748544, sha256: '863e730ddf19107ec588f742cc5d5af7f24ee5515b9d4f734e77e669bfc20dae' },
    { path: 'runtime/sherpa-onnx-c-api.dll', size: 4775424, sha256: 'ae8f86144101373a72cbe6b6c6cbd8b91bb95e315797d1c7e829c57ba76fd190' },
    { path: 'runtime/sherpa-onnx-cxx-api.dll', size: 271360, sha256: '81dfd8bd88efb80cc65e728923534cbad9773bc4fd2e282370c5a6b1aca1e256' },
    { path: 'runtime/onnxruntime.dll', size: 17799168, sha256: '7f66f939a881baf4f46a2216496798edf4a1429878b646d12674aa62f27d8a25' },
    { path: 'runtime/onnxruntime_providers_shared.dll', size: 104960, sha256: '551d0e1fe4c227d8542314ba718d52f4379e0c7bfe729a37c59833a884e27b4d' },
    { path: 'model/model.int8.onnx', size: 132048466, sha256: '2225124a139df2e6485ec7ec70faabd906923776d6564c0b264113315b9d1816' },
    { path: 'model/tokens.txt', size: 11896, sha256: '618dc110fc2213886b52e063ff42329bbdf37a266ca7705184090fa5f39f3131' },
    { path: 'model/silero_vad.onnx', size: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
  ],
};

const sum = (a) => a.reduce((s, f) => s + f.size, 0);

function create(app) {
  const dir = path.join(app.getPath('userData'), 'voice-pack', PACK.id);
  // Developer setup: `npm start` from a checkout with the runtime in node_modules and the model in .dev/models.
  const dev = !app.isPackaged && !process.env.TP_FOLLOW_NO_DEV && (() => {      // TP_FOLLOW_NO_DEV=1 tests the real download
    const root = path.join(__dirname, '..');
    const runtime = path.join(root, 'node_modules', 'sherpa-onnx-win-x64');
    const md = path.join(root, '.dev', 'models');
    const mdir = path.join(md, 'glideprompter-fastconformer-ctc-en-80ms');   // tools/follow/export-multi.py
    if (!fs.existsSync(path.join(runtime, 'sherpa-onnx.node')) || !fs.existsSync(path.join(mdir, 'model.int8.onnx'))) return null;
    return { runtime, model: { kind: 'nemoCtc', model: path.join(mdir, 'model.int8.onnx'), tokens: path.join(mdir, 'tokens.txt') }, vad: path.join(md, 'silero_vad.onnx') };
  })();

  const installed = () => PACK.files.length > 0 && PACK.files.every(f => {
    try { return fs.statSync(path.join(dir, f.path)).size === f.size; } catch { return false; }
  }) && fs.existsSync(path.join(dir, '.verified'));

  function paths() {
    if (dev && !installed()) return dev;
    if (!installed()) return null;
    const m = PACK.model, p = (x) => path.join(dir, x);
    return { runtime: p('runtime'), model: { kind: m.kind, model: p(m.model), tokens: p(m.tokens) }, vad: p(m.vad) };
  }

  function status() {
    return { id: PACK.id, label: PACK.label, size: sum(PACK.files), installed: installed(), dev: !!dev && !installed(),
      ready: !!paths(), available: PACK.files.length > 0 && !/REPLACE/.test(PACK.revision), downloading: !!job };
  }

  // ---------------- download ----------------
  let job = null;
  function get(url, onData, redirects = 0) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': 'GlidePrompter' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 6) {
          res.resume();
          resolve(get(new URL(res.headers.location, url).toString(), onData, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${path.basename(url)}`)); return; }
        res.on('data', onData); res.on('end', resolve); res.on('error', reject);
      });
      req.on('error', reject);
      if (job) job.req = req;
    });
  }
  async function download(onProgress) {
    if (job) return job.promise;
    if (!status().available) throw new Error('The voice pack is not published yet.');
    job = { cancelled: false };
    job.promise = (async () => {
      fs.mkdirSync(dir, { recursive: true });
      try { fs.unlinkSync(path.join(dir, '.verified')); } catch {}
      const total = sum(PACK.files);
      let done = 0;
      for (const f of PACK.files) {
        const dest = path.join(dir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && fs.statSync(dest).size === f.size && await hashFile(dest) === f.sha256) { done += f.size; onProgress(done, total); continue; }
        const part = dest + '.part', out = fs.createWriteStream(part), hash = crypto.createHash('sha256');
        const url = `https://huggingface.co/${PACK.repo}/resolve/${PACK.revision}/${f.path}`;
        try {
          await get(url, (chunk) => {
            if (job.cancelled) { job.req && job.req.destroy(new Error('cancelled')); return; }
            out.write(chunk); hash.update(chunk); done += chunk.length; onProgress(done, total);
          });
        } finally { await new Promise(r => out.end(r)); }
        if (job.cancelled) throw new Error('cancelled');
        if (hash.digest('hex') !== f.sha256) { fs.unlinkSync(part); throw new Error(`${f.path} failed the checksum. Please try again.`); }
        fs.renameSync(part, dest);
      }
      fs.writeFileSync(path.join(dir, '.verified'), PACK.revision);
    })();
    try { await job.promise; } finally { job = null; }
  }
  function cancel() { if (job) { job.cancelled = true; job.req && job.req.destroy(new Error('cancelled')); } }
  function remove() { fs.rmSync(dir, { recursive: true, force: true }); }

  return { paths, status, download, cancel, remove, dir };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

module.exports = { create, PACK, hashFile };

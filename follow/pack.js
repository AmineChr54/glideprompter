// Follow mode voice pack: the speech runtime + model, downloaded on demand into the user data folder.
// The file list, sizes and SHA-256 hashes are fixed here, and the download URL pins an exact commit,
// so a changed upload is refused instead of loaded.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// One model for every system, plus a speech runtime per platform. Windows keeps the original
// `runtime/` folder, so packs installed by v1.2.0 stay valid. The file lists come from
// tools/follow/build-pack.js (pack-manifest.json); the revision is the Hugging Face commit of that upload.
const MANIFEST = require('./pack-manifest.json');
const PLATFORM = `${process.platform}-${process.arch}`;
const RUNTIME = MANIFEST.runtimes[PLATFORM] || null;

const PACK = {
  id: 'en-1',
  label: 'English voice pack',
  repo: 'aminechr54/glideprompter-voice-en',
  revision: '997146bf13fce87997a29d120080e4b03ce742b6',
  model: { kind: 'nemoCtc', model: 'model/model.int8.onnx', tokens: 'model/tokens.txt', vad: 'model/silero_vad.onnx' },
  platform: PLATFORM,
  runtime: RUNTIME,                                     // { dir, npm, files } or null on an unsupported system
  files: RUNTIME ? [...RUNTIME.files, ...MANIFEST.model] : [],
};

const sum = (a) => a.reduce((s, f) => s + f.size, 0);

function create(app) {
  const dir = path.join(app.getPath('userData'), 'voice-pack', PACK.id);
  // Developer setup: `npm start` from a checkout with the runtime in node_modules and the model in .dev/models.
  const dev = !app.isPackaged && !process.env.TP_FOLLOW_NO_DEV && (() => {      // TP_FOLLOW_NO_DEV=1 tests the real download
    const root = path.join(__dirname, '..');
    if (!RUNTIME) return null;
    const runtime = path.join(root, 'node_modules', RUNTIME.npm);
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
    return { runtime: p(RUNTIME.dir), model: { kind: m.kind, model: p(m.model), tokens: p(m.tokens) }, vad: p(m.vad) };
  }

  function status() {
    return { id: PACK.id, label: PACK.label, size: sum(PACK.files), installed: installed(), dev: !!dev && !installed(),
      ready: !!paths(), available: PACK.files.length > 0 && !/REPLACE/.test(PACK.revision), supported: !!RUNTIME,
      platform: PLATFORM, downloading: !!job };
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

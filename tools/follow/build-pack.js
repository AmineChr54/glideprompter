// Builds the Follow mode voice pack folder for upload to Hugging Face, and writes the file list
// (sizes + SHA-256) to follow/pack-manifest.json, which the app checks every download against.
//
//   node tools/follow/build-pack.js            -> .dev/pack/en-1/ + follow/pack-manifest.json
//   hf upload aminechr54/glideprompter-voice-en .dev/pack/en-1 . --repo-type model
//   then put the new commit hash into PACK.revision in follow/pack.js.
//
// Sources: the sherpa-onnx runtimes (npm packages sherpa-onnx-<platform>, same version as the
// devDependency sherpa-onnx-node; missing ones are fetched with `npm pack` into .dev/runtimes),
// NVIDIA's CC-BY-4.0 streaming FastConformer exported at 80 ms (export-multi.py), Silero VAD.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hashFile } = require('../../follow/pack.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, '.dev', 'pack', 'en-1');
const CACHE = path.join(ROOT, '.dev', 'runtimes');
const MD = path.join(ROOT, '.dev', 'models');
const MODEL = path.join(MD, 'glideprompter-fastconformer-ctc-en-80ms');   // made by tools/follow/export-multi.py
const VERSION = require(path.join(ROOT, 'node_modules', 'sherpa-onnx-node', 'package.json')).version;

// platform key (process.platform-process.arch) -> folder in the pack, npm package, files to ship
const RUNTIMES = {
  'win32-x64':    { dir: 'runtime',              npm: 'sherpa-onnx-win-x64',
                    files: ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'] },
  'linux-x64':    { dir: 'runtime-linux-x64',    npm: 'sherpa-onnx-linux-x64',
                    files: ['sherpa-onnx.node', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so', 'libonnxruntime.so'] },
  'darwin-arm64': { dir: 'runtime-darwin-arm64', npm: 'sherpa-onnx-darwin-arm64',
                    files: ['sherpa-onnx.node', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib', 'libonnxruntime.dylib'] },
  'darwin-x64':   { dir: 'runtime-darwin-x64',   npm: 'sherpa-onnx-darwin-x64',
                    files: ['sherpa-onnx.node', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib', 'libonnxruntime.dylib'] },
};
const MODEL_FILES = [
  [path.join(MODEL, 'model.int8.onnx'), 'model/model.int8.onnx'],
  [path.join(MODEL, 'tokens.txt'), 'model/tokens.txt'],
  [path.join(MD, 'silero_vad.onnx'), 'model/silero_vad.onnx'],
];

// The npm package's folder: node_modules if it is the installed one, else .dev/runtimes/<npm>/package
function runtimeSource(npm) {
  const nm = path.join(ROOT, 'node_modules', npm);
  if (fs.existsSync(path.join(nm, 'package.json')) && require(path.join(nm, 'package.json')).version === VERSION) return nm;
  const dir = path.join(CACHE, npm, 'package');
  if (fs.existsSync(path.join(dir, 'package.json')) && require(path.join(dir, 'package.json')).version === VERSION) return dir;
  fs.mkdirSync(path.join(CACHE, npm), { recursive: true });
  const tgz = execFileSync('npm', ['pack', `${npm}@${VERSION}`, '--silent'], { cwd: path.join(CACHE, npm), shell: true }).toString().trim().split('\n').pop();
  execFileSync('tar', ['xzf', tgz], { cwd: path.join(CACHE, npm) });
  return dir;
}

const README = `---
license: other
language: en
tags: [speech-recognition, streaming, teleprompter]
---
# GlidePrompter voice pack (English)

Downloaded on demand by [GlidePrompter](https://github.com/AmineChr54/glideprompter) for **Follow mode**:
the teleprompter scrolls with the speaker's voice. Everything runs locally, offline.
The app downloads the model plus the one runtime folder for its own system.

| Path | What | Licence |
|---|---|---|
| \`runtime/\` | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) ${VERSION} Node addon, Windows x64 | Apache-2.0 |
| \`runtime-linux-x64/\` | sherpa-onnx ${VERSION} Node addon, Linux x64 | Apache-2.0 |
| \`runtime-darwin-arm64/\`, \`runtime-darwin-x64/\` | sherpa-onnx ${VERSION} Node addon, macOS (Apple silicon, Intel) | Apache-2.0 |
| \`*onnxruntime*\` in each runtime folder | [ONNX Runtime](https://github.com/microsoft/onnxruntime) | MIT |
| \`model/model.int8.onnx\`, \`tokens.txt\` | [nvidia/stt_en_fastconformer_hybrid_large_streaming_multi](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi) by NVIDIA, set to 80 ms look-ahead (att_context_size [70,1]), CTC branch, exported to ONNX and int8-quantised with sherpa-onnx's export recipe ([export-multi.py](https://github.com/AmineChr54/glideprompter/blob/main/tools/follow/export-multi.py)). Changes: format conversion and quantisation only. | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), © NVIDIA |
| \`model/silero_vad.onnx\` | [Silero VAD](https://github.com/snakers4/silero-vad) | MIT |

The app pins this repository to an exact commit and checks every file's SHA-256 before using it.
`;

fs.rmSync(OUT, { recursive: true, force: true });
(async () => {
  const entry = async (src, rel) => {
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return { path: rel, size: fs.statSync(dest).size, sha256: await hashFile(dest) };
  };
  const manifest = { id: 'en-1', sherpaOnnx: VERSION, runtimes: {}, model: [] };
  for (const [key, rt] of Object.entries(RUNTIMES)) {
    const src = runtimeSource(rt.npm), files = [];
    for (const f of rt.files) files.push(await entry(path.join(src, f), `${rt.dir}/${f}`));
    manifest.runtimes[key] = { dir: rt.dir, npm: rt.npm, files };
  }
  for (const [src, rel] of MODEL_FILES) manifest.model.push(await entry(src, rel));
  fs.writeFileSync(path.join(OUT, 'README.md'), README);
  // licence texts travel with the binaries and the model (they are not in the checked file list)
  fs.mkdirSync(path.join(OUT, 'licenses'), { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, 'licenses'))) fs.copyFileSync(path.join(__dirname, 'licenses', f), path.join(OUT, 'licenses', f));
  const json = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(OUT, 'manifest.json'), json);
  fs.writeFileSync(path.join(ROOT, 'follow', 'pack-manifest.json'), json);
  const mb = (a) => (a.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(1);
  console.log(`voice pack: ${OUT}`);
  for (const [k, r] of Object.entries(manifest.runtimes)) console.log(`  ${k.padEnd(13)} ${mb([...r.files, ...manifest.model])} MB download`);
  console.log('wrote follow/pack-manifest.json. Upload, then set PACK.revision in follow/pack.js.');
})();

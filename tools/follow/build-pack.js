// Builds the Follow mode voice pack folder for upload to Hugging Face, and prints the file list
// (sizes + SHA-256) to paste into follow/pack.js.
//
//   node tools/follow/build-pack.js            -> .dev/pack/en-1/
//   hf upload <repo> .dev/pack/en-1 . --repo-type model
//   then put the commit hash into PACK.revision and the printed files into PACK.files.
//
// Sources: the sherpa-onnx Windows runtime from node_modules (devDependency sherpa-onnx-node),
// NVIDIA's CC-BY-4.0 streaming FastConformer exported at 80 ms (export-multi.py), Silero VAD.
const fs = require('fs');
const path = require('path');
const { hashFile } = require('../../follow/pack.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, '.dev', 'pack', 'en-1');
const RT = path.join(ROOT, 'node_modules', 'sherpa-onnx-win-x64');
const MD = path.join(ROOT, '.dev', 'models');
const MODEL = path.join(MD, 'glideprompter-fastconformer-ctc-en-80ms');   // made by tools/follow/export-multi.py

const FILES = [
  [path.join(RT, 'sherpa-onnx.node'), 'runtime/sherpa-onnx.node'],
  [path.join(RT, 'sherpa-onnx-c-api.dll'), 'runtime/sherpa-onnx-c-api.dll'],
  [path.join(RT, 'sherpa-onnx-cxx-api.dll'), 'runtime/sherpa-onnx-cxx-api.dll'],
  [path.join(RT, 'onnxruntime.dll'), 'runtime/onnxruntime.dll'],
  [path.join(RT, 'onnxruntime_providers_shared.dll'), 'runtime/onnxruntime_providers_shared.dll'],
  [path.join(MODEL, 'model.int8.onnx'), 'model/model.int8.onnx'],
  [path.join(MODEL, 'tokens.txt'), 'model/tokens.txt'],
  [path.join(MD, 'silero_vad.onnx'), 'model/silero_vad.onnx'],
];

const README = `---
license: other
language: en
tags: [speech-recognition, streaming, teleprompter]
---
# GlidePrompter voice pack (English)

Downloaded on demand by [GlidePrompter](https://github.com/AmineChr54/glideprompter) for **Follow mode**:
the teleprompter scrolls with the speaker's voice. Everything runs locally, offline.

| Path | What | Licence |
|---|---|---|
| \`runtime/sherpa-onnx*\` | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) ${require(path.join(RT, 'package.json')).version} Node addon, Windows x64 | Apache-2.0 |
| \`runtime/onnxruntime*.dll\` | [ONNX Runtime](https://github.com/microsoft/onnxruntime) | MIT |
| \`model/model.int8.onnx\`, \`tokens.txt\` | [nvidia/stt_en_fastconformer_hybrid_large_streaming_multi](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi) by NVIDIA, set to 80 ms look-ahead (att_context_size [70,1]), CTC branch, exported to ONNX and int8-quantised with sherpa-onnx's export recipe ([export-multi.py](https://github.com/AmineChr54/glideprompter/blob/main/tools/follow/export-multi.py)). Changes: format conversion and quantisation only. | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), © NVIDIA |
| \`model/silero_vad.onnx\` | [Silero VAD](https://github.com/snakers4/silero-vad) | MIT |

The app pins this repository to an exact commit and checks every file's SHA-256 before using it.
`;

fs.rmSync(OUT, { recursive: true, force: true });
(async () => {
  const files = [];
  for (const [src, rel] of FILES) {
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    files.push({ path: rel, size: fs.statSync(dest).size, sha256: await hashFile(dest) });
  }
  fs.writeFileSync(path.join(OUT, 'README.md'), README);
  // licence texts travel with the binaries and the model (they are not in the checked file list)
  fs.mkdirSync(path.join(OUT, 'licenses'), { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, 'licenses'))) fs.copyFileSync(path.join(__dirname, 'licenses', f), path.join(OUT, 'licenses', f));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ id: 'en-1', files }, null, 2));
  const total = files.reduce((s, f) => s + f.size, 0);
  console.log(`voice pack: ${OUT}  (${(total / 1048576).toFixed(1)} MB, ${files.length} files)\n`);
  console.log('  files: [\n' + files.map(f => `    { path: '${f.path}', size: ${f.size}, sha256: '${f.sha256}' },`).join('\n') + '\n  ],');
})();

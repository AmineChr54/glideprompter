#!/usr/bin/env python3
"""Exports NVIDIA's CC-BY-4.0 streaming FastConformer (multi look-ahead) to sherpa-onnx, at 80 ms look-ahead.

Same steps as sherpa-onnx's scripts/nemo/fast-conformer-hybrid-transducer-ctc/export-onnx-ctc.py
(Apache-2.0, Xiaomi Corp.), but with the Hugging Face checkpoint
nvidia/stt_en_fastconformer_hybrid_large_streaming_multi (CC-BY-4.0) set to att_context_size [70, 1].

Usage (in a venv with nemo_toolkit[asr], onnx, onnxruntime):
  python tools/follow/export-multi.py --out .dev/models/glideprompter-fastconformer-ctc-en-80ms
"""
import argparse
import os
from typing import Dict

import nemo.collections.asr as nemo_asr
import onnx
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic

HF_MODEL = "nvidia/stt_en_fastconformer_hybrid_large_streaming_multi"


def add_meta_data(filename: str, meta_data: Dict[str, str]):
    model = onnx.load(filename)
    while len(model.metadata_props):
        model.metadata_props.pop()
    for key, value in meta_data.items():
        meta = model.metadata_props.add()
        meta.key = key
        meta.value = str(value)
    onnx.save(model, filename)


@torch.no_grad()
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--att-right", type=int, default=1, help="right context: 0=0ms, 1=80ms, 6=480ms, 13=1040ms")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    os.chdir(args.out)

    asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name=HF_MODEL)
    asr_model.encoder.set_default_att_context_size([70, args.att_right])
    asr_model.encoder.setup_streaming_params()

    with open("./tokens.txt", "w", encoding="utf-8", newline="\n") as f:
        for i, s in enumerate(asr_model.joint.vocabulary):
            f.write(f"{s} {i}\n")
        f.write(f"<blk> {i+1}\n")

    asr_model.change_decoding_strategy(decoder_type="ctc")
    asr_model.eval()

    cfg = asr_model.encoder.streaming_cfg
    chunk_size = cfg.chunk_size[1] if isinstance(cfg.chunk_size, list) else cfg.chunk_size
    pre = cfg.pre_encode_cache_size[1] if isinstance(cfg.pre_encode_cache_size, list) else cfg.pre_encode_cache_size
    print("att_context_size", asr_model.encoder.att_context_size, "chunk_size", chunk_size, "pre_encode_cache_size", pre)

    asr_model.set_export_config({"decoder_type": "ctc", "cache_support": True})
    asr_model.export("model.onnx")

    normalize_type = asr_model.cfg.preprocessor.normalize
    if normalize_type == "NA":
        normalize_type = ""
    meta_data = {
        "vocab_size": asr_model.decoder.vocab_size,
        "window_size": chunk_size + pre,
        "chunk_shift": chunk_size,
        "normalize_type": normalize_type,
        "cache_last_channel_dim1": len(asr_model.encoder.layers),
        "cache_last_channel_dim2": cfg.last_channel_cache_size,
        "cache_last_channel_dim3": asr_model.encoder.d_model,
        "cache_last_time_dim1": len(asr_model.encoder.layers),
        "cache_last_time_dim2": asr_model.encoder.d_model,
        "cache_last_time_dim3": asr_model.encoder.conv_context_size[0],
        "subsampling_factor": 8,
        "model_type": "EncDecHybridRNNTCTCBPEModel",
        "version": "1",
        "model_author": "NeMo",
        "url": f"https://huggingface.co/{HF_MODEL}",
        "license": "CC-BY-4.0 (NVIDIA)",
        "comment": f"CTC branch only, att_context_size [70,{args.att_right}]. Exported for GlidePrompter.",
    }
    add_meta_data("model.onnx", meta_data)
    quantize_dynamic(model_input="./model.onnx", model_output="./model.int8.onnx", weight_type=QuantType.QUInt8)
    print(meta_data)


if __name__ == "__main__":
    main()

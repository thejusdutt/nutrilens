#!/usr/bin/env bash
# Fetch all runtime model assets and source datasets.
# Models land in app/public/models/<name>/ mirroring the HF repo layout that
# transformers.js expects when env.localModelPath points at app/public/models.
set -euo pipefail
cd "$(dirname "$0")/.."

HF=https://huggingface.co
get () { # get <dest> <url>
  local dest="$1" url="$2"
  if [ -s "$dest" ]; then echo "skip $dest"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  echo "GET $url"
  curl -fsSL --retry 3 -o "$dest.part" "$url" && mv "$dest.part" "$dest"
}

# --- Swin-Food101 classifier (primary, 92.1% top-1 on Food-101) ---
SWIN=$HF/onnx-community/swin-finetuned-food101-ONNX/resolve/main
get app/public/models/swin-food101/onnx/model_int8.onnx   "$SWIN/onnx/model_int8.onnx"
get app/public/models/swin-food101/onnx/model_q4f16.onnx  "$SWIN/onnx/model_q4f16.onnx"
get app/public/models/swin-food101/config.json            "$SWIN/config.json"
get app/public/models/swin-food101/preprocessor_config.json "$SWIN/preprocessor_config.json"

# --- MobileCLIP-S2 (zero-shot open-vocabulary head) ---
# fp16 vision tower: int8 CLIP vision towers are destroyed by quantization
# (measured: cosine sims collapse to noise); fp16 matches fp32 quality.
# S2 over S0: +25-60pt zero-shot top-1 on out-of-Food-101 foods (see eval).
MC=$HF/Xenova/mobileclip_s2/resolve/main
get app/public/models/mobileclip-s2/onnx/vision_model_fp16.onnx "$MC/onnx/vision_model_fp16.onnx"
get app/public/models/mobileclip-s2/config.json                 "$MC/config.json"
get app/public/models/mobileclip-s2/preprocessor_config.json    "$MC/preprocessor_config.json"
# Text tower + tokenizer are BUILD-TIME ONLY (embedding precomputation in Node).
# fp32 text: the fp16 text export trips an ORT graph-fusion bug, and build-time
# size is irrelevant.
get tools/data/mobileclip-s2/onnx/text_model.onnx  "$MC/onnx/text_model.onnx"
get tools/data/mobileclip-s2/tokenizer.json        "$MC/tokenizer.json"
get tools/data/mobileclip-s2/tokenizer_config.json "$MC/tokenizer_config.json"
get tools/data/mobileclip-s2/config.json           "$MC/config.json"

# --- SlimSAM (segmentation for portion estimation) ---
SAM=$HF/Xenova/slimsam-77-uniform/resolve/main
get app/public/models/slimsam/onnx/vision_encoder_quantized.onnx "$SAM/onnx/vision_encoder_quantized.onnx"
get app/public/models/slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx "$SAM/onnx/prompt_encoder_mask_decoder_quantized.onnx"
get app/public/models/slimsam/config.json               "$SAM/config.json"
get app/public/models/slimsam/preprocessor_config.json  "$SAM/preprocessor_config.json"

# --- USDA FNDDS 2021-2023 (nutrition source data, build-time) ---
get tools/data/fndds.zip "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10-31.zip"

echo "ALL ASSETS FETCHED"

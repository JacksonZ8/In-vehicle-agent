#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VOICE_MODELS_DIR="$ROOT_DIR/.local-services/voice-models"
MODEL_NAME="sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
MODEL_DIR="$VOICE_MODELS_DIR/$MODEL_NAME"
ARCHIVE="$VOICE_MODELS_DIR/$MODEL_NAME.tar.bz2"
PARTIAL_ARCHIVE="$ARCHIVE.part"
SOURCE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$MODEL_NAME.tar.bz2"
EXPECTED_SHA256="68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6"

required_model_files_exist() {
  [ -f "$MODEL_DIR/encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx" ] \
    && [ -f "$MODEL_DIR/decoder-epoch-13-avg-2-chunk-8-left-64.onnx" ] \
    && [ -f "$MODEL_DIR/joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx" ] \
    && [ -f "$MODEL_DIR/tokens.txt" ]
}

mkdir -p "$VOICE_MODELS_DIR"
if required_model_files_exist; then
  echo "Local voice model is already installed: $MODEL_DIR"
  exit 0
fi
if [ -e "$MODEL_DIR" ]; then
  echo "Refusing to overwrite incomplete model directory: $MODEL_DIR" >&2
  exit 1
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "Downloading the pinned local-only KWS model..."
  curl --fail --location --show-error --output "$PARTIAL_ARCHIVE" "$SOURCE_URL"
  mv "$PARTIAL_ARCHIVE" "$ARCHIVE"
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Model archive SHA-256 mismatch; refusing to extract." >&2
  exit 1
fi
if ! tar -tjf "$ARCHIVE" | awk '
  BEGIN { bad = 0 }
  /^\// || /(^|\/)\.\.($|\/)/ { bad = 1 }
  END { exit bad }
'; then
  echo "Unsafe path found in model archive; refusing to extract." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "$VOICE_MODELS_DIR/.extract.XXXXXX")"
trap 'rm -rf -- "$TEMP_DIR" "$PARTIAL_ARCHIVE"' EXIT
tar -xjf "$ARCHIVE" -C "$TEMP_DIR"
if [ ! -d "$TEMP_DIR/$MODEL_NAME" ]; then
  echo "Expected model directory is missing from the archive." >&2
  exit 1
fi
mv "$TEMP_DIR/$MODEL_NAME" "$MODEL_DIR"

echo "Installed local voice model: $MODEL_DIR"
echo "SHA-256: $EXPECTED_SHA256"
echo "License boundary: local demo only; model redistribution terms remain unresolved."

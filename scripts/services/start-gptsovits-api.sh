#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GPT_SOVITS_DIR="$ROOT_DIR/external/GPT-SoVITS"
CONDA_ENV="${NIO_GPT_SOVITS_CONDA_ENV:-GPTSoVits}"
HOST="${NIO_GPT_SOVITS_HOST:-127.0.0.1}"
PORT="${NIO_GPT_SOVITS_PORT:-9880}"
CONFIG="${NIO_GPT_SOVITS_CONFIG:-GPT_SoVITS/configs/tts_infer_sandrone_local.yaml}"
CACHE_DIR="$ROOT_DIR/.local-services/cache"

if [ ! -d "$GPT_SOVITS_DIR" ]; then
  echo "GPT-SoVITS repo not found: $GPT_SOVITS_DIR" >&2
  exit 1
fi

mkdir -p "$CACHE_DIR/numba" "$CACHE_DIR/matplotlib" "$CACHE_DIR/xdg"
export NUMBA_CACHE_DIR="${NUMBA_CACHE_DIR:-$CACHE_DIR/numba}"
export MPLCONFIGDIR="${MPLCONFIGDIR:-$CACHE_DIR/matplotlib}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$CACHE_DIR/xdg}"

cd "$GPT_SOVITS_DIR"

exec conda run -n "$CONDA_ENV" python api_v2.py -a "$HOST" -p "$PORT" -c "$CONFIG"

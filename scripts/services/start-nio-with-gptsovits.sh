#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---- HC-P0-08: load TTS profile from shared JS loader ----
load_tts_profile() {
  local profile_env
  profile_env=$("$ROOT_DIR/scripts/services/resolve-tts-profile-env.mjs" --strict-profile --include-endpoint --log-prefix=start-nio) || {
    return 1
  }
  eval "$profile_env"
  export NIO_TTS_TIMEOUT_MS="${NIO_TTS_TIMEOUT_MS:-90000}"
  return 0
}

# HC-P0-08: fail fast if TTS profile is referenced but not loadable
if [ "${NIO_GPT_SOVITS_SKIP_PROFILE:-0}" != "1" ]; then
  load_tts_profile || exit 1
fi

export NIO_VEHICLE_SLU_PROFILE="${NIO_VEHICLE_SLU_PROFILE:-local-compact-v10}"
export NIO_OLLAMA_KEEP_ALIVE="${NIO_OLLAMA_KEEP_ALIVE:-24h}"
export NIO_OLLAMA_WARMUP_ON_START="${NIO_OLLAMA_WARMUP_ON_START:-true}"
export NIO_OLLAMA_WARMUP_TIMEOUT_MS="${NIO_OLLAMA_WARMUP_TIMEOUT_MS:-120000}"
export NIO_LLM_PROMPT_STYLE="${NIO_LLM_PROMPT_STYLE:-verbose}"
export NIO_LLM_PLANNING_SUMMARY_MODE="${NIO_LLM_PLANNING_SUMMARY_MODE:-llm}"

cd "$ROOT_DIR"
exec node src/server/local-agent-server.mjs "${NIO_AGENT_PORT:-4173}"

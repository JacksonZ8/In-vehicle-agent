#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.local-services"
LOG_DIR="${NIO_LOCAL_SERVICES_LOG_DIR:-/private/tmp/nio-local-services-$(id -u)-logs}"
WRAPPER_DIR="/private/tmp/nio-local-services-$(id -u)"

SERVICE_SELECTOR="${1:-all}"
case "$SERVICE_SELECTOR" in
  agent|tts|all) ;;
  *)
    echo "Usage: $0 [agent|tts|all]" >&2
    echo "  agent  — restart the local agent server (port 4173) only" >&2
    echo "  tts    — restart the GPT-SoVITS TTS API (port 9880) only" >&2
    echo "  all    — restart both services (default)" >&2
    exit 2
    ;;
esac

LOCAL_AGENT_PORT="${NIO_AGENT_PORT:-4173}"
GPT_SOVITS_DIR="$ROOT_DIR/external/GPT-SoVITS"
GPT_SOVITS_CONDA_ENV="${NIO_GPT_SOVITS_CONDA_ENV:-GPTSoVits}"
GPT_SOVITS_HOST="${NIO_GPT_SOVITS_HOST:-127.0.0.1}"
GPT_SOVITS_PORT="${NIO_GPT_SOVITS_PORT:-9880}"
GPT_SOVITS_CONFIG="${NIO_GPT_SOVITS_CONFIG:-GPT_SoVITS/configs/tts_infer_sandrone_local.yaml}"
GPT_SOVITS_CACHE_DIR="$STATE_DIR/cache"
START_MODE="${NIO_LOCAL_SERVICES_START_MODE:-auto}"

export NIO_OLLAMA_KEEP_ALIVE="${NIO_OLLAMA_KEEP_ALIVE:-24h}"
export NIO_OLLAMA_WARMUP_ON_START="${NIO_OLLAMA_WARMUP_ON_START:-true}"
export NIO_OLLAMA_WARMUP_TIMEOUT_MS="${NIO_OLLAMA_WARMUP_TIMEOUT_MS:-120000}"
export NIO_LLM_PLANNING_SUMMARY_MODE="${NIO_LLM_PLANNING_SUMMARY_MODE:-llm}"
export NIO_VEHICLE_SLU_PROFILE="${NIO_VEHICLE_SLU_PROFILE:-local-compact-v10}"
export NIO_GPT_SOVITS_WARMUP_ON_START="${NIO_GPT_SOVITS_WARMUP_ON_START:-true}"
export NIO_GPT_SOVITS_WARMUP_TIMEOUT_MS="${NIO_GPT_SOVITS_WARMUP_TIMEOUT_MS:-180000}"
export NIO_AGENT_LOAD_LOGIN_ENV="${NIO_AGENT_LOAD_LOGIN_ENV:-true}"
# Keep optional streaming diagnostics off unless the invoking shell explicitly enables them.
# The launchctl wrapper has a separate environment, so this value must be written into it.
export NIO_TTS_STREAMING_DIAGNOSTICS="${NIO_TTS_STREAMING_DIAGNOSTICS:-false}"

LOCAL_AGENT_PID_FILE="$STATE_DIR/local-agent.pid"
GPT_SOVITS_PID_FILE="$STATE_DIR/gptsovits-api.pid"
LOCAL_AGENT_LOG="$LOG_DIR/local-agent.log"
GPT_SOVITS_LOG="$LOG_DIR/gptsovits-api.log"
GPT_SOVITS_STDOUT_LOG="$LOG_DIR/gptsovits-api.stdout.log"
GPT_SOVITS_STDERR_LOG="$LOG_DIR/gptsovits-api.stderr.log"
GPT_SOVITS_EXIT_LOG="$LOG_DIR/gptsovits-api.exit.log"
LOCAL_AGENT_LABEL="local.nio.agent-server"
GPT_SOVITS_LABEL="local.nio.gptsovits-api"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

# ---- HC-P0-08: resolve system PATH (no hardcoded user directories) ----
resolve_system_path() {
  if [ -n "${NIO_SYSTEM_PATH:-}" ]; then
    echo "$NIO_SYSTEM_PATH"
    return 0
  fi

  local detected=""
  # Auto-detect conda from common install locations
  for conda_root in "$HOME/miniconda3" "$HOME/anaconda3" "$HOME/miniforge3" "$HOME/miniforge"; do
    if [ -d "$conda_root/bin" ]; then
      detected="${detected}${conda_root}/bin:"
      break
    fi
  done

  # Append common toolchain paths
  detected="${detected}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  echo "$detected"
}

# ---- HC-P0-08: load TTS profile from shared JS loader ----
load_tts_profile() {
  local profile_env
  profile_env=$("$ROOT_DIR/scripts/services/resolve-tts-profile-env.mjs" --strict-profile --log-prefix=restart) || {
    return 1
  }
  eval "$profile_env"
  return 0
}

shell_double_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "$value"
}

is_macos_launchctl_available() {
  [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1
}

print_recent_log() {
  local service_name="$1"
  local log_file="$2"

  echo "[$service_name] Log: $log_file" >&2
  if [ -f "$log_file" ]; then
    echo "[$service_name] Last 80 log lines:" >&2
    tail -n 80 "$log_file" >&2
  else
    echo "[$service_name] Log file does not exist yet." >&2
  fi
}

listener_pid_for_port() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed -n '1p' || true
}

write_listener_pid_file() {
  local service_name="$1"
  local pid_file="$2"
  local port="$3"
  local log_file="$4"
  local pid

  pid="$(listener_pid_for_port "$port" | tr -d '[:space:]')"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "[$service_name] Could not find a listening PID on port $port." >&2
    print_recent_log "$service_name" "$log_file"
    return 1
  fi

  echo "$pid" >"$pid_file"
  echo "[$service_name] Listening PID $pid written to $pid_file"
}

wait_for_http_200() {
  local service_name="$1"
  local url="$2"
  local timeout_seconds="$3"
  local log_file="$4"
  local deadline=$((SECONDS + timeout_seconds))
  local status

  echo "[$service_name] Waiting for HTTP 200 from $url (${timeout_seconds}s timeout)..."
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
    if [ "$status" = "200" ]; then
      echo "[$service_name] Healthy: $url"
      return 0
    fi
    sleep 1
  done

  echo "[$service_name] Health check failed: $url did not return HTTP 200 within ${timeout_seconds}s." >&2
  print_recent_log "$service_name" "$log_file"
  return 1
}

start_persistent_service() {
  local service_name="$1"
  local label="$2"
  local wrapper_path="$3"
  local log_file="$4"

  echo "[$service_name] Log: $log_file"
  if [ "$START_MODE" != "nohup" ] && is_macos_launchctl_available; then
    echo "[$service_name] Starting with launchctl label $label..."
    launchctl submit -l "$label" -- /bin/bash "$wrapper_path"
  else
    echo "[$service_name] Starting with nohup fallback."
    nohup /bin/bash "$wrapper_path" </dev/null >/dev/null 2>&1 &
    echo "[$service_name] nohup wrapper PID $!"
    disown "$!" 2>/dev/null || true
  fi
}

# ---- HC-P0-08: wrapper uses resolve_system_path instead of a hardcoded per-user miniconda3/bin path ----
write_local_agent_wrapper() {
  local wrapper_path="$1"
  local system_path
  system_path="$(resolve_system_path)"

  # TTS profile values (env vars already set by load_tts_profile; provide safe defaults)
  local tts_endpoint="${NIO_GPT_SOVITS_ENDPOINT:-http://127.0.0.1:${GPT_SOVITS_PORT}/tts}"
  local tts_ref_audio="${NIO_GPT_SOVITS_REF_AUDIO_PATH:-}"
  local tts_prompt_text="${NIO_GPT_SOVITS_PROMPT_TEXT:-}"
  local tts_prompt_lang="${NIO_GPT_SOVITS_PROMPT_LANG:-zh}"
  local tts_text_lang="${NIO_GPT_SOVITS_TEXT_LANG:-zh}"
  local tts_media_type="${NIO_GPT_SOVITS_MEDIA_TYPE:-wav}"

  cat >"$wrapper_path" <<EOFW
#!/usr/bin/env bash
set -euo pipefail

export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8
if locale -a 2>/dev/null | grep -qi '^en_US.UTF-8$'; then
  export LC_ALL=en_US.UTF-8
fi
export PATH=$(shell_double_quote "$system_path"):\${PATH:-}

PROJECT_ROOT=$(shell_double_quote "$ROOT_DIR")
LOG_FILE=$(shell_double_quote "$LOCAL_AGENT_LOG")
PORT=$(shell_double_quote "$LOCAL_AGENT_PORT")

mkdir -p "\$(dirname "\$LOG_FILE")"
exec >>"\$LOG_FILE" 2>&1

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

cd "\$PROJECT_ROOT"
export NIO_TTS_TIMEOUT_MS=$(shell_double_quote "${NIO_TTS_TIMEOUT_MS:-90000}")
export NIO_GPT_SOVITS_WARMUP_TIMEOUT_MS=$(shell_double_quote "${NIO_GPT_SOVITS_WARMUP_TIMEOUT_MS:-180000}")
export NIO_OLLAMA_KEEP_ALIVE=$(shell_double_quote "${NIO_OLLAMA_KEEP_ALIVE:-24h}")
export NIO_OLLAMA_WARMUP_ON_START=$(shell_double_quote "${NIO_OLLAMA_WARMUP_ON_START:-true}")
export NIO_OLLAMA_WARMUP_TIMEOUT_MS=$(shell_double_quote "${NIO_OLLAMA_WARMUP_TIMEOUT_MS:-120000}")
export NIO_LLM_PROMPT_STYLE=$(shell_double_quote "${NIO_LLM_PROMPT_STYLE:-verbose}")
export NIO_LLM_PLANNING_SUMMARY_MODE=$(shell_double_quote "${NIO_LLM_PLANNING_SUMMARY_MODE:-llm}")
export NIO_VEHICLE_SLU_PROFILE=$(shell_double_quote "${NIO_VEHICLE_SLU_PROFILE:-local-compact-v10}")
export NIO_LLM_PROVIDER=$(shell_double_quote "${NIO_LLM_PROVIDER:-ollama}")
export NIO_DASHSCOPE_BASE_URL=$(shell_double_quote "${NIO_DASHSCOPE_BASE_URL:-https://dashscope.aliyuncs.com/compatible-mode/v1}")
export NIO_DASHSCOPE_MODEL=$(shell_double_quote "${NIO_DASHSCOPE_MODEL:-qwen-plus}")
export NIO_AGENT_LOAD_LOGIN_ENV=$(shell_double_quote "${NIO_AGENT_LOAD_LOGIN_ENV:-true}")
export NIO_TTS_STREAMING_DIAGNOSTICS=$(shell_double_quote "${NIO_TTS_STREAMING_DIAGNOSTICS:-false}")
export NIO_GPT_SOVITS_ENDPOINT=$(shell_double_quote "$tts_endpoint")
export NIO_GPT_SOVITS_REF_AUDIO_PATH=$(shell_double_quote "$tts_ref_audio")
export NIO_GPT_SOVITS_PROMPT_TEXT=$(shell_double_quote "$tts_prompt_text")
export NIO_GPT_SOVITS_PROMPT_LANG=$(shell_double_quote "$tts_prompt_lang")
export NIO_GPT_SOVITS_TEXT_LANG=$(shell_double_quote "$tts_text_lang")
export NIO_GPT_SOVITS_MEDIA_TYPE=$(shell_double_quote "$tts_media_type")

echo "[\$(timestamp)] Starting node local-agent-server.mjs \$PORT"
if [ "\$NIO_AGENT_LOAD_LOGIN_ENV" = "true" ]; then
  exec /bin/zsh -lic 'exec "\$@"' nio-agent node src/server/local-agent-server.mjs "\$PORT"
fi
exec node src/server/local-agent-server.mjs "\$PORT"
EOFW

  chmod 700 "$wrapper_path"
}

# ---- HC-P0-08: wrapper uses resolve_system_path instead of a hardcoded per-user miniconda3/bin path ----
write_gptsovits_wrapper() {
  local wrapper_path="$1"
  local system_path
  system_path="$(resolve_system_path)"

  cat >"$wrapper_path" <<EOFW
#!/usr/bin/env bash
set -euo pipefail

export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8
if locale -a 2>/dev/null | grep -qi '^en_US.UTF-8$'; then
  export LC_ALL=en_US.UTF-8
fi
export PATH=$(shell_double_quote "$system_path"):\${PATH:-}

GPT_SOVITS_DIR=$(shell_double_quote "$GPT_SOVITS_DIR")
LOG_FILE=$(shell_double_quote "$GPT_SOVITS_LOG")
CONDA_ENV=$(shell_double_quote "$GPT_SOVITS_CONDA_ENV")
HOST=$(shell_double_quote "$GPT_SOVITS_HOST")
PORT=$(shell_double_quote "$GPT_SOVITS_PORT")
CONFIG=$(shell_double_quote "$GPT_SOVITS_CONFIG")
  CACHE_DIR=$(shell_double_quote "$GPT_SOVITS_CACHE_DIR")
STDOUT_LOG=$(shell_double_quote "$GPT_SOVITS_STDOUT_LOG")
STDERR_LOG=$(shell_double_quote "$GPT_SOVITS_STDERR_LOG")
EXIT_LOG=$(shell_double_quote "$GPT_SOVITS_EXIT_LOG")

mkdir -p "\$(dirname "\$LOG_FILE")" "\$CACHE_DIR/numba" "\$CACHE_DIR/matplotlib" "\$CACHE_DIR/xdg"
exec >>"\$LOG_FILE" 2>&1
export NUMBA_CACHE_DIR="\${NUMBA_CACHE_DIR:-\$CACHE_DIR/numba}"
export MPLCONFIGDIR="\${MPLCONFIGDIR:-\$CACHE_DIR/matplotlib}"
export XDG_CACHE_HOME="\${XDG_CACHE_HOME:-\$CACHE_DIR/xdg}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

cd "\$GPT_SOVITS_DIR"
if [ -n "\${CONDA_EXE:-}" ] && [ -x "\$CONDA_EXE" ]; then
  conda_bin="\$CONDA_EXE"
elif command -v conda >/dev/null 2>&1; then
  conda_bin="\$(command -v conda)"
else
  echo "[\$(timestamp)] conda not found. PATH=\$PATH"
  exit 127
fi

echo "[\$(timestamp)] Starting \$conda_bin run -n \$CONDA_ENV python api_v2.py -a \$HOST -p \$PORT -c \$CONFIG"
echo "[\$(timestamp)] TTS stdout: \$STDOUT_LOG; stderr: \$STDERR_LOG; exit records: \$EXIT_LOG"
set +e
"\$conda_bin" run -n "\$CONDA_ENV" python api_v2.py -a "\$HOST" -p "\$PORT" -c "\$CONFIG" >>"\$STDOUT_LOG" 2>>"\$STDERR_LOG"
exit_code=\$?
set -e
echo "[\$(timestamp)] GPT-SoVITS process exited with code \$exit_code" | tee -a "\$EXIT_LOG"
exit "\$exit_code"
EOFW

  chmod 700 "$wrapper_path"
}

start_local_agent() {
  local wrapper_path="$WRAPPER_DIR/start-local-agent.sh"

  # HC-P0-08: agent text/control path must not fail just because optional TTS profile is broken.
  if [ "${NIO_GPT_SOVITS_SKIP_PROFILE:-0}" != "1" ]; then
    load_tts_profile || echo "[local-agent] WARNING: TTS profile could not be loaded; /api/tts will fall back to browser while text/control paths continue." >&2
  fi

  echo "[local-agent] Starting on port $LOCAL_AGENT_PORT..."
  write_local_agent_wrapper "$wrapper_path"
  start_persistent_service "local-agent" "$LOCAL_AGENT_LABEL" "$wrapper_path" "$LOCAL_AGENT_LOG"
  wait_for_http_200 "local-agent" "http://127.0.0.1:${LOCAL_AGENT_PORT}/" 20 "$LOCAL_AGENT_LOG"
  write_listener_pid_file "local-agent" "$LOCAL_AGENT_PID_FILE" "$LOCAL_AGENT_PORT" "$LOCAL_AGENT_LOG"
}

start_gptsovits_api() {
  local wrapper_path="$WRAPPER_DIR/start-gptsovits-api.sh"

  if [ ! -d "$GPT_SOVITS_DIR" ]; then
    echo "[gptsovits-api] GPT-SoVITS repo not found: $GPT_SOVITS_DIR" >&2
    exit 1
  fi

  echo "[gptsovits-api] Starting on ${GPT_SOVITS_HOST}:${GPT_SOVITS_PORT}..."
  write_gptsovits_wrapper "$wrapper_path"
  start_persistent_service "gptsovits-api" "$GPT_SOVITS_LABEL" "$wrapper_path" "$GPT_SOVITS_LOG"
  if ! wait_for_http_200 "gptsovits-api" "http://127.0.0.1:${GPT_SOVITS_PORT}/docs" 120 "$GPT_SOVITS_LOG"; then
    rm -f "$GPT_SOVITS_PID_FILE"
    echo "[gptsovits-api] Removed stale PID file after failed health check: $GPT_SOVITS_PID_FILE" >&2
    return 1
  fi
  write_listener_pid_file "gptsovits-api" "$GPT_SOVITS_PID_FILE" "$GPT_SOVITS_PORT" "$GPT_SOVITS_LOG"
  if [ "$SERVICE_SELECTOR" = "all" ]; then
    echo "[gptsovits-api] Startup warmup delegated to the Agent Server runtime coordinator."
  else
    run_gptsovits_startup_warmup
  fi
}

run_gptsovits_startup_warmup() {
  if [ "$NIO_GPT_SOVITS_WARMUP_ON_START" != "true" ]; then
    echo "[gptsovits-api] Startup warmup disabled (NIO_GPT_SOVITS_WARMUP_ON_START=$NIO_GPT_SOVITS_WARMUP_ON_START)."
    return 0
  fi

  # Load the same profile used by the HMI proxy. A profile error must not turn
  # a healthy 9880 process into a failed restart.
  if ! load_tts_profile; then
    echo "[gptsovits-api] Startup warmup skipped: TTS profile could not be loaded." >&2
    return 0
  fi

  echo "[gptsovits-api] Running discarded local startup warmup (mode 3; no HMI playback or user cache)..."
  NIO_GPT_SOVITS_WARMUP_TIMEOUT_MS="$NIO_GPT_SOVITS_WARMUP_TIMEOUT_MS" \
    node "$ROOT_DIR/scripts/services/warm-gptsovits-tts.mjs" || \
    echo "[gptsovits-api] Startup warmup process failed unexpectedly; continuing with healthy TTS API." >&2
}

mkdir -p "$STATE_DIR" "$LOG_DIR" "$WRAPPER_DIR"

# HC-P0-07: pass service selector to stop script
echo "Stopping selected local service(s): $SERVICE_SELECTOR..."
"$ROOT_DIR/scripts/services/stop-local-services.sh" "$SERVICE_SELECTOR"

# HC-P0-07: conditionally start only selected service(s)
if [ "$SERVICE_SELECTOR" = "tts" ] || [ "$SERVICE_SELECTOR" = "all" ]; then
  start_gptsovits_api
fi

if [ "$SERVICE_SELECTOR" = "agent" ] || [ "$SERVICE_SELECTOR" = "all" ]; then
  start_local_agent
fi

echo "Local services restart complete (selector: $SERVICE_SELECTOR)."
echo "PID files: $STATE_DIR"
echo "Logs: $LOG_DIR"

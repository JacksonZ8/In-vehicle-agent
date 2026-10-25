#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT_DIR/.local-services"

SERVICE_SELECTOR="${1:-all}"
case "$SERVICE_SELECTOR" in
  agent|tts|all) ;;
  *)
    echo "Usage: $0 [agent|tts|all]" >&2
    echo "  agent  — stop the local agent server (port 4173) only" >&2
    echo "  tts    — stop the GPT-SoVITS TTS API (port 9880) only" >&2
    echo "  all    — stop both services (default)" >&2
    exit 2
    ;;
esac

LOCAL_AGENT_PORT="${NIO_AGENT_PORT:-4173}"
GPT_SOVITS_PORT="${NIO_GPT_SOVITS_PORT:-9880}"

LOCAL_AGENT_PID_FILE="$STATE_DIR/local-agent.pid"
GPT_SOVITS_PID_FILE="$STATE_DIR/gptsovits-api.pid"
LOCAL_AGENT_LABEL="local.nio.agent-server"
GPT_SOVITS_LABEL="local.nio.gptsovits-api"

is_macos_launchctl_available() {
  [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1
}

remove_launchctl_job() {
  local service_name="$1"
  local label="$2"

  if is_macos_launchctl_available; then
    echo "[$service_name] Removing launchctl label if present: $label"
    launchctl remove "$label" 2>/dev/null || true
  fi
}

pid_exists() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

command_for_pid() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null || true
}

matches_local_agent() {
  local command="$1"
  [[ "$command" == *"node"* && "$command" == *"local-agent-server.mjs"* ]]
}

matches_gptsovits() {
  local command="$1"
  [[ "$command" == *"api_v2.py"* ]]
}

read_pid_file() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 0
  sed -n '1p' "$pid_file" 2>/dev/null | tr -d '[:space:]'
}

pids_listening_on_port() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

pids_matching_command() {
  local pattern="$1"
  pgrep -f "$pattern" 2>/dev/null || true
}

collect_service_pids() {
  local service_name="$1"
  local pid_file="$2"
  local port="$3"
  local command_pattern="$4"
  local matcher="$5"
  local pid
  local command
  local raw_pids=()
  local verified_pids=()
  local seen_pids=" "

  pid="$(read_pid_file "$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    raw_pids+=("$pid")
  fi

  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] && raw_pids+=("$pid")
  done < <(pids_listening_on_port "$port")

  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] && raw_pids+=("$pid")
  done < <(pids_matching_command "$command_pattern")

  if [ "${#raw_pids[@]}" -gt 0 ]; then
    for pid in "${raw_pids[@]}"; do
      if [[ "$seen_pids" == *" $pid "* ]]; then
        continue
      fi
      seen_pids="$seen_pids$pid "

      if ! pid_exists "$pid"; then
        continue
      fi

      command="$(command_for_pid "$pid")"
      if "$matcher" "$command"; then
        verified_pids+=("$pid")
      else
        echo "[$service_name] Skip PID $pid because command does not match expected service:" >&2
        echo "[$service_name]   $command" >&2
      fi
    done
  fi

  if [ "${#verified_pids[@]}" -gt 0 ]; then
    printf '%s\n' "${verified_pids[@]}"
  fi
}

stop_pids() {
  local service_name="$1"
  local pid_file="$2"
  shift 2
  local pids=("$@")
  local pid
  local alive=()

  if [ "${#pids[@]}" -eq 0 ]; then
    echo "[$service_name] Not running."
    rm -f "$pid_file"
    return 0
  fi

  echo "[$service_name] Stopping PID(s): ${pids[*]}"
  for pid in "${pids[@]}"; do
    if pid_exists "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  for _ in {1..30}; do
    alive=()
    for pid in "${pids[@]}"; do
      if pid_exists "$pid"; then
        alive+=("$pid")
      fi
    done

    [ "${#alive[@]}" -eq 0 ] && break
    sleep 0.2
  done

  if [ "${#alive[@]}" -gt 0 ]; then
    echo "[$service_name] Still running after TERM, sending KILL: ${alive[*]}"
    for pid in "${alive[@]}"; do
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi

  rm -f "$pid_file"
  echo "[$service_name] Stopped."
}

stop_service() {
  local service_name="$1"
  local pid_file="$2"
  local label="$3"
  local port="$4"
  local command_pattern="$5"
  local matcher="$6"
  local pids=()
  local pid

  remove_launchctl_job "$service_name" "$label"
  echo "[$service_name] Checking PID file and port $port..."

  while IFS= read -r pid; do
    [ -n "$pid" ] && pids+=("$pid")
  done < <(collect_service_pids "$service_name" "$pid_file" "$port" "$command_pattern" "$matcher")

  if [ "${#pids[@]}" -gt 0 ]; then
    stop_pids "$service_name" "$pid_file" "${pids[@]}"
  else
    stop_pids "$service_name" "$pid_file"
  fi
}

mkdir -p "$STATE_DIR"

if [ "$SERVICE_SELECTOR" = "agent" ] || [ "$SERVICE_SELECTOR" = "all" ]; then
  stop_service \
    "local-agent" \
    "$LOCAL_AGENT_PID_FILE" \
    "$LOCAL_AGENT_LABEL" \
    "$LOCAL_AGENT_PORT" \
    "node .*local-agent-server\\.mjs.*${LOCAL_AGENT_PORT}" \
    matches_local_agent
fi

if [ "$SERVICE_SELECTOR" = "tts" ] || [ "$SERVICE_SELECTOR" = "all" ]; then
  stop_service \
    "gptsovits-api" \
    "$GPT_SOVITS_PID_FILE" \
    "$GPT_SOVITS_LABEL" \
    "$GPT_SOVITS_PORT" \
    "api_v2\\.py.*-p ${GPT_SOVITS_PORT}" \
    matches_gptsovits
fi

echo "Local services stop check complete."

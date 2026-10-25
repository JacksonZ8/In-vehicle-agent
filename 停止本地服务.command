#!/bin/bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OLLAMA_URL="http://127.0.0.1:11434/api/tags"

pause_on_error() {
  local exit_code=$?
  echo
  echo "停止服务时出现错误（退出码：${exit_code}）。请查看上方提示。"
  echo "按回车键关闭此窗口……"
  read -r _
  exit "$exit_code"
}
trap pause_on_error ERR

is_healthy() {
  local url="$1"
  [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)" = "200" ]
}

stop_ollama() {
  local pid command normalized_command deadline

  if ! is_healthy "$OLLAMA_URL"; then
    echo "[Ollama] 11434 未运行"
    return 0
  fi

  pid="$(lsof -tiTCP:11434 -sTCP:LISTEN 2>/dev/null | sed -n '1p' || true)"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "[Ollama] 无法定位 11434 监听进程，已跳过"
    return 1
  fi

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  normalized_command="$(printf '%s' "$command" | tr '[:upper:]' '[:lower:]')"
  case "$normalized_command" in
    *ollama*) ;;
    *)
      echo "[Ollama] 11434 当前由非 Ollama 进程监听，已拒绝停止：${command}" >&2
      return 1
      ;;
  esac

  echo "[Ollama] 正在停止 11434（PID ${pid}）……"
  kill "$pid"
  deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! is_healthy "$OLLAMA_URL"; then
      echo "[Ollama] 已停止"
      return 0
    fi
    sleep 0.5
  done

  echo "[Ollama] 11434 在 10 秒内未停止，请手动检查 PID ${pid}" >&2
  return 1
}

clear 2>/dev/null || true
echo "蔚来车载智能交互：停止本地服务"
echo "项目目录：$ROOT_DIR"
echo

"$ROOT_DIR/scripts/services/stop-local-services.sh" all
stop_ollama

echo
echo "已完成：4173 Agent Server、9880 GPT-SoVITS、11434 Ollama 均已请求停止。"

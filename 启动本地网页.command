#!/bin/bash
set -Eeuo pipefail

if [ "${NIO_DESKTOP_LOGIN_ENV_LOADED:-false}" != "true" ]; then
  export NIO_DESKTOP_LOGIN_ENV_LOADED=true
  exec /bin/zsh -lic 'exec "$@"' nio-desktop-launcher /bin/bash "$0" "$@"
fi

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OLLAMA_LOG="/private/tmp/nio-ollama-$(id -u).log"
STARTUP_DEADLINE_SECONDS="${NIO_DEMO_STARTUP_DEADLINE_SECONDS:-30}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export NIO_AGENT_LOAD_LOGIN_ENV="true"
export NIO_LLM_PROVIDER="dashscope"
export NIO_DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export NIO_DASHSCOPE_MODEL="qwen-plus"

pause_on_error() {
  local exit_code=$?
  echo
  echo "启动失败（退出码：${exit_code}）。请查看上方提示。"
  echo "按回车键关闭此窗口……"
  read -r _
  exit "$exit_code"
}
trap pause_on_error ERR

is_healthy() {
  local url="$1"
  [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)" = "200" ]
}

wait_until_healthy() {
  local name="$1"
  local url="$2"
  local timeout_seconds="$3"
  local deadline=$((SECONDS + timeout_seconds))

  echo "[$name] 等待服务就绪：$url"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if is_healthy "$url"; then
      echo "[$name] 已就绪"
      return 0
    fi
    sleep 1
  done

  echo "[$name] 在 ${timeout_seconds} 秒内未能就绪。" >&2
  return 1
}

start_ollama_if_needed() {
  local url="http://127.0.0.1:11434/api/tags"
  local ollama_bin

  if is_healthy "$url"; then
    echo "[Ollama] 11434 已运行，保持现状"
    return 0
  fi

  ollama_bin="$(command -v ollama || true)"
  if [ -z "$ollama_bin" ] && [ -x "/Applications/Ollama.app/Contents/Resources/ollama" ]; then
    ollama_bin="/Applications/Ollama.app/Contents/Resources/ollama"
  fi
  if [ -z "$ollama_bin" ]; then
    echo "[Ollama] 未找到 ollama 命令或 Ollama.app。" >&2
    return 1
  fi

  echo "[Ollama] 启动 11434（日志：${OLLAMA_LOG}）"
  nohup "$ollama_bin" serve </dev/null >"${OLLAMA_LOG}" 2>&1 &
  wait_until_healthy "Ollama" "$url" 30
}

start_project_service_if_needed() {
  local name="$1"
  local selector="$2"
  local url="$3"

  if is_healthy "$url"; then
    echo "[$name] 已运行，保持现状"
    return 0
  fi

  echo "[$name] 正在启动……"
  "$ROOT_DIR/scripts/services/restart-local-services.sh" "$selector"
  is_healthy "$url"
}

agent_model_config_is_ready() {
  local profile
  profile="$(curl -sS --max-time 2 http://127.0.0.1:4173/api/model-provider-profile 2>/dev/null || true)"
  [ -n "$profile" ] && [[ "$profile" != *'"reasonCode":"provider-config-invalid"'* ]]
}

start_agent_if_needed() {
  local url="http://127.0.0.1:4173/"

  if is_healthy "$url" && agent_model_config_is_ready; then
    echo "[本地网页 / Agent Server] 已运行且模型配置完整，保持现状"
    return 0
  fi

  if is_healthy "$url"; then
    echo "[本地网页 / Agent Server] 进程存活但模型配置已降级，正在重启自愈……"
  else
    echo "[本地网页 / Agent Server] 正在启动……"
  fi
  "$ROOT_DIR/scripts/services/restart-local-services.sh" agent
  is_healthy "$url" && agent_model_config_is_ready
}

clear
echo "蔚来车载智能交互：启动本地服务"
echo "项目目录：$ROOT_DIR"
if [ -n "${DASHSCOPE_API_KEY:-}" ]; then
  echo "[DashScope] 配置已加载；启动检查不会发起云端模型请求"
else
  echo "[DashScope] 未配置；模型步骤将使用已声明的本地回退或确定性链路"
fi
echo

if [ -f "$ROOT_DIR/assets/models/nio-es7/nio-es7-animated.glb" ] \
  && [ -f "$ROOT_DIR/assets/models/nio-es7/nio-es7-component-manifest.json" ]; then
  echo "[ES7 资产] GLB 与组件 manifest 已就绪"
else
  echo "[ES7 资产] 缺失，HMI 将以视觉降级模式继续" >&2
fi

echo "[启动] 并行检查 Agent Server、Ollama 与 GPT-SoVITS"
start_ollama_if_needed &
OLLAMA_START_JOB=$!
start_project_service_if_needed "GPT-SoVITS" "tts" "http://127.0.0.1:9880/docs" &
TTS_START_JOB=$!
start_agent_if_needed &
AGENT_START_JOB=$!

# Agent Server 可能需要先停掉一个“HTTP 可用但模型配置已降级”的旧进程。
# 等待这个作业，避免主流程误把旧进程当成已完成的新启动。
if ! wait "$AGENT_START_JOB"; then
  echo "[本地网页 / Agent Server] 模型配置未完全收敛，将以明示降级模式继续" >&2
fi

disown "$OLLAMA_START_JOB" "$TTS_START_JOB" 2>/dev/null || true

LAUNCH_STARTED_AT=$SECONDS
AGENT_URL="http://127.0.0.1:4173/"
while [ $((SECONDS - LAUNCH_STARTED_AT)) -lt "$STARTUP_DEADLINE_SECONDS" ]; do
  if is_healthy "$AGENT_URL"; then
    break
  fi
  sleep 1
done

if ! is_healthy "$AGENT_URL"; then
  echo "[Demo Readiness] blocked · Agent Server 在 ${STARTUP_DEADLINE_SECONDS}s 内未就绪" >&2
  false
fi

READINESS_BODY="$(curl -sS --max-time 2 http://127.0.0.1:4173/api/demo-readiness 2>/dev/null || true)"
if [ -n "$READINESS_BODY" ] && [ "${READINESS_BODY#*\"status\":\"}" != "$READINESS_BODY" ]; then
  READINESS_STATUS="${READINESS_BODY#*\"status\":\"}"
  READINESS_STATUS="${READINESS_STATUS%%\"*}"
  READINESS_ELAPSED="${READINESS_BODY#*\"elapsedMs\":}"
  READINESS_ELAPSED="${READINESS_ELAPSED%%,*}"
  echo "[Demo Readiness] ${READINESS_STATUS} · ${READINESS_ELAPSED}ms / ${STARTUP_DEADLINE_SECONDS}000ms"
else
  echo "[Demo Readiness] degraded · 状态接口暂不可读，HMI 将继续自行刷新" >&2
fi

if is_healthy "http://127.0.0.1:11434/api/tags"; then
  echo "[Ollama] ready"
else
  echo "[Ollama] degraded · 本地模型尚未就绪" >&2
fi
if is_healthy "http://127.0.0.1:9880/docs"; then
  echo "[GPT-SoVITS] ready"
else
  echo "[GPT-SoVITS] degraded · 将由浏览器语音兜底" >&2
fi

echo
echo "Agent Server 已可交互，正在打开本地网页；可选服务会在后台继续收敛。"
open "http://127.0.0.1:4173/"
echo "完成。现在可以关闭此窗口。"

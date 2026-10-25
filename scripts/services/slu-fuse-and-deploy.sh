#!/usr/bin/env bash
# SLU 模型部署链路：LoRA adapter → mlx_lm fuse → llama.cpp 转 GGUF → Modelfile → ollama create
#
# 本脚本在主仓库（scripts/services/）与训练工程（scripts/）各存一份，内容相同。
# 训练工程根目录解析顺序：
#   1. 环境变量 SLU_TRAIN_ROOT
#   2. 从当前目录向上查找同时含 adapters/ 与 config/ 的目录（在训练工程内跑时命中）
#   3. $HOME/Desktop/vehicle-slu-finetune（在主仓库内跑时回落）
#
# Modelfile 是**生成产物、不入库**；模板（$ROOT/Modelfile.template）才是真源，
# 因此 FROM 行不会与实际产物路径漂移。
#
# 用法：
#   bash scripts/services/slu-fuse-and-deploy.sh
#   KEEP_FUSED=1 bash scripts/services/slu-fuse-and-deploy.sh          # 保留融合中间产物
#   ADAPTER=".../2026-10-05-independent-round4-q4-low-lr-2000/adapter" \
#   FUSED="$HOME/Desktop/vehicle-slu-finetune/models/cockpit-slu-v11-round4-fused" \
#   NAME="cockpit-slu-v11-round4" LLAMA_CPP_DIR=/path/to/llama.cpp \
#     bash scripts/services/slu-fuse-and-deploy.sh
#
# 可覆盖变量：SLU_TRAIN_ROOT / PY / BASE / ADAPTER / FUSED / NAME / QUANT /
#             LLAMA_CPP_DIR / CONVERT_PY / OLLAMA_BIN / MODELFILE_TEMPLATE / KEEP_FUSED / FORCE
#
# Ollama ≥0.34 导入 safetensors 只走 MLX 引擎，不支持 Qwen2，也不再接受 -q q4_K_M；因此先用
# llama.cpp 的 convert_hf_to_gguf.py（只需克隆源码，不必编译）把融合模型转成 GGUF（QUANT 默认 q8_0），
# 再按 GGUF 导入。CONVERT_PY 需能 import torch/transformers；Qwen2 无 tokenizer.model，
# 若该解释器缺 sentencepiece，可在 PYTHONPATH 放一个只含 SentencePieceProcessor 占位类的模块。
#
# ⚠️ cockpit-slu:latest 是 baseline（semanticAccuracy 40.0%）的载体，
#    覆盖它会让新旧对比失去基准 —— NAME 已存在时默认拒绝，需 FORCE=1 才覆盖。
#
# 磁盘策略：不导出 f16 GGUF（约 6GB），直接转换为 QUANT 指定的 GGUF（q8_0 约 3.3GB）；
#           导入完成后提示删除 fused（约 5.8GB）与 GGUF 中间产物。
set -euo pipefail

resolve_train_root() {
  if [ -n "${SLU_TRAIN_ROOT:-}" ]; then printf '%s\n' "$SLU_TRAIN_ROOT"; return 0; fi
  local d="$PWD"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -d "$d/adapters" ] && [ -d "$d/config" ]; then printf '%s\n' "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  printf '%s\n' "$HOME/Desktop/vehicle-slu-finetune"
}

resolve_python() {
  if [ -n "${PY:-}" ]; then printf '%s\n' "$PY"; return 0; fi
  local candidate
  for candidate in \
    "$HOME/.workbuddy/binaries/python/envs/pdfenv/bin/python" \
    "$(command -v python3 2>/dev/null || true)" \
    /usr/bin/python3
  do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    # 必须真的能 import mlx_lm，否则只是碰巧存在的解释器
    if env -u PYTHONPATH "$candidate" -c 'import mlx_lm' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"; return 0
    fi
  done
  return 1
}

ROOT="$(resolve_train_root)"
BASE="${BASE:-$ROOT/models/Qwen2.5-3B-Instruct}"
ADAPTER="${ADAPTER:-$ROOT/adapters/cockpit-slu-lora}"
FUSED="${FUSED:-$ROOT/models/cockpit-slu-fused}"
NAME="${NAME:-cockpit-slu}"
QUANT="${QUANT:-q8_0}"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-}"
CONVERT_PY="${CONVERT_PY:-$HOME/.workbuddy/binaries/python/envs/default/bin/python3}"
GGUF="${FUSED}.${QUANT}.gguf"
TEMPLATE="${MODELFILE_TEMPLATE:-$ROOT/Modelfile.template}"

if [ ! -d "$ROOT" ]; then
  echo "!! 训练工程根目录不存在: $ROOT" >&2
  echo "   用 SLU_TRAIN_ROOT=/path/to/vehicle-slu-finetune 指定" >&2
  exit 2
fi

if [ ! -f "$ADAPTER/adapters.safetensors" ]; then
  echo "!! 找不到 $ADAPTER/adapters.safetensors，先跑训练" >&2
  exit 2
fi

if [ -z "$LLAMA_CPP_DIR" ] || [ ! -f "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" ]; then
  echo "!! 需要 llama.cpp 源码目录（含 convert_hf_to_gguf.py 与 gguf-py）：LLAMA_CPP_DIR=/path/to/llama.cpp" >&2
  exit 2
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "!! 找不到 Modelfile 模板: $TEMPLATE" >&2
  echo "   模板真源在训练工程根目录（Modelfile.template），不随权重一起搬运" >&2
  exit 2
fi

OLLAMA_BIN="${OLLAMA_BIN:-$(command -v ollama || echo /usr/local/bin/ollama)}"
if [ ! -x "$OLLAMA_BIN" ]; then
  echo "!! 找不到 ollama 可执行文件（可用 OLLAMA_BIN=/path/to/ollama 指定）" >&2
  exit 2
fi

# 防误覆盖
if [ -z "${FORCE:-}" ]; then
  if "$OLLAMA_BIN" list 2>/dev/null | /usr/bin/awk 'NR>1{split($1,a,":"); print a[1]}' | /usr/bin/grep -qx "$NAME"; then
    echo "!! Ollama 里已存在模型 '$NAME'，拒绝覆盖（避免毁掉 baseline 基准）。" >&2
    echo "   换个名字：NAME=cockpit-slu-v11 bash $0" >&2
    echo "   确实要覆盖：FORCE=1 bash $0" >&2
    exit 3
  fi
fi

if ! PY_RESOLVED="$(resolve_python)"; then
  echo "!! 找不到可用的 Python（要求能 import mlx_lm）。用 PY=/path/to/python 指定。" >&2
  exit 2
fi
PY="$PY_RESOLVED"

# sed 替换前挡掉会破坏表达式的字符
case "$GGUF" in
  *'&'*|*'|'*)
    echo "!! GGUF 路径含 '&' 或 '|'，无法安全注入 Modelfile 模板: $GGUF" >&2
    exit 2
    ;;
esac

echo "训练工程 : $ROOT"
echo "Python   : $PY"
echo "adapter  : $ADAPTER"
echo "fused    : $FUSED"
echo "模型名   : $NAME   量化: $QUANT"
echo

cd "$ROOT"

echo "==> 1/4 合并 adapter 到基座"
# 摘掉 PYTHONPATH：否则 sitecustomize 的文件审批钩子会拖死 mlx/transformers 的导入
env -u PYTHONPATH "$PY" -m mlx_lm fuse \
  --model "$BASE" \
  --adapter-path "$ADAPTER" \
  --save-path "$FUSED"

echo "==> 2/4 转换为 GGUF（${QUANT}）"
env PYTHONPATH="$LLAMA_CPP_DIR/gguf-py${PYTHONPATH:+:$PYTHONPATH}" HF_HUB_OFFLINE=1 "$CONVERT_PY" \
  "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" "$FUSED" --outtype "$QUANT" --outfile "$GGUF"

echo "==> 3/4 由模板生成 Modelfile"
sed "s|__FUSED__|$GGUF|g" "$TEMPLATE" > "$ROOT/Modelfile"
echo "    $TEMPLATE -> $ROOT/Modelfile"

echo "==> 4/4 导入 Ollama"
# 后台任务的 shell 不加载 profile，PATH 里可能没有 ollama，故上面已解析成绝对路径
"$OLLAMA_BIN" create "$NAME" -f "$ROOT/Modelfile"
"$OLLAMA_BIN" list | grep "$NAME" || true

if [ -z "${KEEP_FUSED:-}" ]; then
  echo
  echo "fused 与 GGUF 中间产物占 $(du -sh "$FUSED" | cut -f1) + $(du -sh "$GGUF" | cut -f1)，Ollama 导入完成后可安全删除："
  echo "  rm -rf \"$FUSED\" \"$GGUF\""
fi

echo "done -> ollama run $NAME"

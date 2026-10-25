# 云端模型 Provider 运维指南

本指南只描述手动配置、就绪检查和回滚。Provider 配置在 4173 Agent Server 进程启动时确定；页面不能选择 Provider、模型、Base URL、超时或密钥。

## 密钥边界

`DASHSCOPE_API_KEY` 的真实值只能注入 4173 服务进程环境。不要把真实 Key 写入 `.env.example`、其他项目文件或启动命令参数；本项目也不加载 `.env` 文件。

在不打印值的前提下，可以在将要启动 4173 的同一进程环境中检查 Key 是否存在且非空：

```sh
if [ -n "${DASHSCOPE_API_KEY+x}" ] && [ -n "$DASHSCOPE_API_KEY" ]; then
  printf 'DASHSCOPE_API_KEY is configured\n'
else
  printf 'DASHSCOPE_API_KEY is missing\n'
fi
```

永远不要把 Key 放入命令行参数、浏览器控制台、截图、测试/性能报告、Git 或服务日志，也不要记录 Authorization header、完整进程环境或上游原始响应。

## 切换到 DashScope

1. 通过已批准的密钥注入机制，让真实 `DASHSCOPE_API_KEY` 只存在即将启动的 4173 服务进程环境中，并按上述方式只检查“已配置/缺失”，不打印值。
2. 为同一服务进程设置以下非密配置：

   ```sh
   export NIO_LLM_PROVIDER=dashscope
   export NIO_DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
   export NIO_DASHSCOPE_MODEL=qwen-plus-2025-12-01
   export NIO_CLOUD_LLM_PHASE_TIMEOUT_MS=12000
   export NIO_CLOUD_LLM_TRANSPORT_TIMEOUT_MS=15000
   ```

   这是已批准的百炼华北 2（北京）Base URL 和固定模型。
3. 切换 Provider 需要重启 4173。重启前必须向用户请求并获得对 4173 的明确授权；不得因为 9880 或 11434 的状态而合并推定授权。
4. 4173 重启后检查 `GET http://127.0.0.1:4173/api/model-provider-profile`。只有响应同时满足 `provider="dashscope"` 且 `readiness.status="ready"` 时才是配置就绪；该端点不应包含 Key、Base URL 凭据或原始上游信息。Readiness 只验证本地配置结构，不代表 Key 已通过一次付费请求验证。
5. 只有在用户另行明确授权使用凭据和有限外部调用后，才能通过运行中的 HMI 或 API 发起一次受控 smoke 请求；未授权时不得访问付费上游。

## 回滚到 Ollama

1. 将同一服务运行 profile 设回 `NIO_LLM_PROVIDER=ollama`。DashScope 失败不会在单次 Run 内自动回退到 Ollama；这是一次显式运维切换。
2. 再次向用户请求并获得重启 4173 的明确授权，然后由获授权的操作者重启服务。
3. 重启后检查公开 profile 为 `provider="ollama"`。这不改变业务代码，也不是运行中的自动故障转移。

## 本地服务依赖

DashScope 只替换 `llmModel` 路径。`semanticModel` 仍可能依赖本地 Ollama（默认为 11434），因此 `NIO_LLM_PROVIDER=dashscope` 并不等于当前 Demo 已消除所有 11434 依赖。GPT-SoVITS 9880 与 4173/11434 分别授权，不应为了 Provider 切换自动控制它们。

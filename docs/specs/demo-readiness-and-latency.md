# Demo Readiness 与响应可预测性规范

**Status:** approved-design
**Date:** 2026-08-28
**Scope:** 当前 Mac 上的 NIO 车载智能交互演示启动、服务降级、模型级别展示与响应测量

## 1. 目标

项目进入可展示版本收敛阶段后，启动稳定性和响应速度统一以“可预测的演示链路”为目标：

> 用户点击启动后 30 秒内，HMI 必须进入真实可交互状态，并清楚说明当前是完整能力还是降级能力。

状态分为三档：

- `full`：HMI、ES7 车模、主要模型链路、本地 NOMI 唤醒、RAG 和 GPT-SoVITS 均可用。
- `degraded`：HMI 和至少一条可用文本或车控响应路径可用；缺失服务有明确回退。
- `blocked`：4173/HMI 不可交互，或没有任何可用响应路径。

30 秒是进入 `full` 或 `degraded` 的硬截止时间，不要求可选依赖都在截止时间内完成。进入
`degraded` 时不得伪装为 `full`，也不得继续隐藏等待。

## 2. 不变边界

- Safety Gateway、VehicleState、Provider-confirmed animation 和 Vehicle Adapter 真值边界不因速度优化改变。
- 启动预检只检查本地进程、端口、配置、文件和本地预热；不得在预检阶段发起付费云模型请求。
- 不显示 API Key、Authorization header、完整 Prompt、原始上游响应或完整私密错误。
- 不用伪进度、HTTP 首响应或估算时长冒充模型生成或真实语音播放。
- 车模或 TTS 失败可以使能力降级，但不得阻塞 HMI；4173 或所有响应路径不可用时必须阻塞并明确说明。
- Readiness 只描述当前运行状态，不改变已经完成的 Run 结果或历史 telemetry。

## 3. Readiness Contract

服务端提供只读 `GET /api/demo-readiness`，作为启动器和 HMI 的共同状态投影。它不创建新的
Provider 配置、不接收凭据、不保存 Key，也不对云端模型发探测请求。

```json
{
  "schemaVersion": "nio-demo-readiness@1.0.0",
  "status": "full | degraded | blocked",
  "deadlineMs": 30000,
  "elapsedMs": 18400,
  "capturedAt": "2026-08-28T00:00:00.000Z",
  "stages": [
    {
      "id": "vehicle_slu",
      "label": "语义解析",
      "status": "ready | warming | degraded | disabled | blocked",
      "configuredLevel": "primary | fallback | local-model | deterministic | browser-fallback | unavailable",
      "activeLevel": null,
      "provider": "ollama",
      "model": "cockpit-slu-v11-round4:latest",
      "fallback": null,
      "durationMs": 1800,
      "reasonCode": null,
      "lastCheckedAt": "2026-08-28T00:00:00.000Z"
    }
  ]
}
```

`configuredLevel` 表示配置上允许的级别；`activeLevel` 表示本次请求实际使用的级别。尚未
发生请求时 `activeLevel` 必须为 `null`，不可把配置状态冒充调用成功。

Readiness 由现有 Provider Profile、Runtime Warmup、服务健康检查和车模加载状态聚合而来，
不得在启动脚本、HMI 或 CSS 中复制另一套 Provider/模型映射。

任务级公开 readiness 表示“是否至少存在一条已批准且当前可用的模型路径”，而不是仅反映
主用 Provider：主用连接就绪时为 `ready`；主用不可用但已配置、已批准的 fallback 连接就绪时
仍为 `ready`。仅声明 `fallbackConfigured` 不足以判定就绪，未批准的 Provider/模型组合也不得
改变公开状态；两条路径均不可用时沿用主用路径的阻塞原因。公开投影不得泄露凭据或私有配置。
公开任务 Profile 同时投影粗粒度 `primaryReadiness`，供界面区分“主用已就绪”和“仅 fallback
已就绪”；它只包含 `ready` / `blocked` 与公开原因码，不包含 Key 或连接细节。

## 4. 监测步骤与服务级别

Readiness 至少覆盖以下步骤：

| ID | 步骤 | 主用 | 回退或降级 |
| --- | --- | --- | --- |
| `hmi_shell` | 4173 与页面可交互 | 本地 Agent Server | `blocked` |
| `vehicle_asset` | ES7 GLB 与 manifest | ES7 运行时资产 | HMI 保持可用，视觉降级 |
| `vehicle_slu` | 语义解析 | 本地 compact profile `local-compact-v10`（Ollama，non-thinking） | 无 fallback；失败即 `respond` + `executionDisabled=true` |
| `orchestrator_plan` | 任务规划 | 当前任务 Provider Profile | 配置声明的 fallback |
| `cabin_response` | 座舱回答 | DashScope | Ollama |
| `knowledge_answer` | 知识回答 | DashScope | 配置声明的质量回退 |
| `manual_rag` | 手册检索 | 本地向量检索 | 关键词检索 |
| `local_voice_wake` | 本地唤醒 | sherpa-onnx KWS | 按键说话或文字输入 |
| `tts` | 语音输出 | GPT-SoVITS | 浏览器语音 |
| `usable_response_path` | 可用响应路径 | 至少一条真实文本/车控链路 | 无路径时 `blocked` |

`vehicle_slu` 在所有启动入口（`npm start`、重启脚本、macOS 启动器）默认使用 `local-compact-v10`，每个普通 turn 只发一次请求，不做 schema repair 或跨 Provider fallback。DashScope 云端 Vehicle-SLU 只能通过显式 `NIO_VEHICLE_SLU_PROFILE=cloud-dashscope` 选择，仍为单请求；未获云端授权时云端请求上限默认为 `0`。

车控与安全步骤必须额外显示 `deterministic`，明确表示不由模型授予执行权限。模型服务等级
统一使用：`主用模型`、`本地模型回退`、`确定性 Runtime`、`关键词检索回退`、`浏览器语音兜底`
和 `未就绪`。

## 5. 状态转换

单个步骤按以下方向收敛：

```text
checking → ready
checking → warming
checking → degraded
checking → blocked
warming  → ready
warming  → degraded
```

启动截止时间到达后，整体状态固定为当前的 `full` 或 `degraded`；若 HMI 或响应路径不可用，
固定为 `blocked`。后续服务恢复可以刷新 readiness，但不得回写已完成 Run 的 provider、
degraded 或结果状态。

## 6. 启动与预热顺序

启动器仅负责本地服务生命周期、健康轮询和打开 HMI；状态事实由 Agent Server 聚合。

```text
T0 点击启动
 ├─ 启动/检查 4173
 ├─ 并行检查 11434 Ollama、9880 GPT-SoVITS
 ├─ 检查 ES7 GLB 与 manifest
 └─ 读取 Provider Profile（只读，不调用云模型）

随后并行进行本地 RAG、Ollama、TTS 预热
↓
4173 页面可交互后立即进入 HMI
↓
T+30s 固定为 full / degraded / blocked
```

预热失败只影响对应步骤。启动器必须打印脱敏后的阶段名称、状态和耗时，不得打印完整环境
或凭据。服务恢复不得触发未经用户操作的常驻服务重启或云端调用。

## 7. HMI 展示

顶部现有“模型链路”旁增加默认折叠入口，例如：

```text
模型链路：可演示（降级）   查看准备状态 ▾
```

关闭状态只显示总体摘要，不改变当前主视觉布局；展开后显示三组信息：

1. **总体状态**：启动耗时、30 秒截止、完整/降级/阻塞、可用响应路径。
2. **模型与服务链路**：每步骤的 provider/model、主用与回退、当前实际级别、状态、耗时和原因。
3. **本地依赖**：4173、ES7 资产、Ollama、NOMI 本地唤醒、Manual RAG、GPT-SoVITS 的状态。

面板必须使用结构化状态、键盘可展开、带 `aria-expanded`，并避免把浮层打开造成主页面布局跳动。
启动阶段显示 readiness；Run 完成后将相关行的 `activeLevel` 更新为该 Run telemetry 中的真实
provider。不能用“已配置”替代“本次已调用”。

## 8. 响应速度与稳定性指标

启动必须记录：

- `launchToHmiInteractiveMs`
- `startupStatus`
- 各步骤 `stageReadyMs`
- `degradedReason` 和 `blockedReason`

Run 必须继续使用现有时间点和 telemetry，至少记录：

- `submissionToFirstFeedbackMs`
- `submissionToResultVisibleMs`
- `submissionToFirstAudioPlaybackMs`
- 各模型/确定性阶段耗时
- 实际 `activeLevel`
- 降级、超时和结果类别

样本少于 20 时只报告 `min/median/max`，不虚构 P95。速度优化必须先有可比较基线，再改变
预热、超时、首反馈、模型并发或 TTS 分块策略。

## 9. 实施批次与验收

### 批次 1：状态契约与只读测量

- 定义并实现 `/api/demo-readiness` 的公开 schema。
- 复用已有 Provider Profile、Runtime Warmup、服务健康和车模状态。
- 不改变 Runtime 路由、Safety 或模型策略。

### 批次 2：启动并行化与 30 秒截止

- 启动器并行检查本地服务和必要资产。
- 并行执行本地 RAG、Ollama、TTS 预热。
- 截止时间后固定状态并立即允许 HMI 交互。
- 提供独立的 `停止本地服务.command` 双击入口，关闭项目管理的 4173/9880 服务并安全停止 11434 Ollama 监听进程；关闭浏览器不触发停服。

### 批次 3：折叠状态面板

- 默认折叠且不改变现有布局。
- 展开显示服务级别、实际级别、状态、耗时和原因。
- 将 Run telemetry 的实际 provider 投影回对应步骤。

### 批次 4：基线驱动的速度优化

- 在当前 Mac 上重复启动与核心场景，记录 min/median/max。
- 分别验证完整服务、GPT-SoVITS 不可用、Ollama 不可用、DashScope 未配置和 ES7 资产失败。
- 每种服务级别至少完成一次请求，核对 `activeLevel` 与 Run telemetry 一致。

验收必须满足：

- 正常和降级场景均在 30 秒内进入 `full` 或 `degraded`。
- 4173 不可用或无响应路径时进入 `blocked`，不伪装成可演示。
- 降级场景不绕过 Safety、VehicleState、Provider-confirmed animation 或真实语音测量边界。
- 面板显示与服务端 readiness、Run telemetry 一致。

## 10. 非目标与后续边界

- 本规范不接入真实 Vehicle Service Adapter、真实 POI/路线或新的云端模型。
- 本规范不在预检阶段验证云模型付费调用，也不自动轮换或迁移 API Key。
- 本规范不把 GPT-SoVITS 变成字节流播放；真实 TTFA 仍以浏览器播放事件为准。
- 当前 ES7 衍生资产的生产/商业授权审查仍是独立事项。

# Runtime Architecture Specification

Status: current
Authority: Runtime routing, ownership, shared contracts and non-bypassable runtime boundaries.

## 1. Purpose and scope

本文档是当前 Runtime 的权威规范。浏览器页面只是本地 HMI、调试与集成验收壳；业务判断、
Safety 裁决、Provider 事实和执行闭环不得依赖页面实现。

当前本地开发部署事实：浏览器页面进程承载 Runtime composition——`RuntimeKernel`、Safety、
VehicleStateProvider 与 Vehicle Tools 都运行在页面进程中（composition root 为 `src/app/app.js`），
本地 Agent Server 提供模型、RAG 与外部数据等服务端接口。这只是部署位置，不改变所有权：
presentation 代码（HMI、presentation bridge、CSS/动画）不得决定 Safety、Provider 事实或执行。

本规范不重新定义具体 Safety 阈值、状态时效或 ConfirmationChallenge，详见
[Safety and Vehicle State Specification](safety-and-vehicle-state.md)；车辆写执行的 `commandId`、
Adapter acceptance、Provider confirmation 和 HMI 动画规则详见
[Vehicle Execution Specification](vehicle-execution.md)。

## 2. Current runtime composition

当前 composition root 创建一个 `RuntimeKernel`、一个 `RoutePolicy`、共享的 Run Event Ledger
与 Session Memory，并注册四个 use case：

```text
Input
  -> RuntimeKernel
  -> exactly one local Vehicle-SLU request
  -> validated VehicleSluEnvelope
  -> RoutePolicy
  -> exactly one of: chat | vehicle-knowledge | vehicle-control | task
  -> RunEvent / RuntimeResult
  -> Runtime presentation bridge / HMI
```

每个普通用户 turn 恰好一次 Vehicle-SLU 本地语义请求：不做 schema repair 重试，也不做跨
Provider fallback。经验证的 `nio-vehicle-slu-contract@2.0.0` envelope 是唯一语义权威；
`RoutePolicy` 只消费该结构化 contract，不得从原始文本、关键词、正则、RAG 或第二分类器恢复
车辆语义。同一禁令适用于所有下游：route policy、vehicle-control、vehicle-knowledge 与天气
地点均不得做原始文本或正则语义恢复。

唯一显式例外是确认续接 turn（同一 `ConfirmationChallenge` 的第二次运行）：它不调用
Vehicle-SLU，只复用 vehicle-control use case 私有保存的 challenge 绑定，并且必须重新读取
Provider snapshot、重新运行 Safety，详见
[Safety and Vehicle State Specification](safety-and-vehicle-state.md) 第 10 节。

`RoutePolicy` 的 `RouteDecision` 是每个 Run 的唯一入口裁决：

| disposition | route / mode | result |
| --- | --- | --- |
| `execute` | `chat / direct` | 普通对话 use case |
| `execute` | `vehicle-knowledge / direct` | ES8 车辆知识 use case |
| `execute` | `vehicle-control / direct` | 车辆控制 use case |
| `execute` | `task / direct-capability` | 直接天气只读能力 |
| `execute` | `task / orchestrated` | 复杂任务 use case |
| `clarify`、`respond` 或 `cancel` | no route / no mode | terminal；不选择 use case |

一个 Run 只能选择表中一个分支。`clarify`、`respond` 和 `cancel` 均为终态，
不调用 use case。只有结构化 contract 证明可执行 capability 缺少 required slot 时才
使用 `clarify`；语义超时、endpoint 不可用、JSON 或 contract 无效时必须返回
`respond` 且 `executionDisabled=true`，并保持零 RAG、Safety、Tool、Adapter、Provider 或外部服务调用。
这里的“零 RAG”指不消费 RAG 结果、不形成 evidence；下述并行启动后被丢弃的私有 manual
prefetch 不违反该规则。

为降低延迟，Runtime 可以在 RoutePolicy 裁决的同时启动一个私有、只读、可取消的 manual
retrieval candidate（prefetch）。只有路由结果为 `vehicle-knowledge / direct` 时它才可被该
use case 采用；其他任何 disposition 或 route 下都必须取消并丢弃。prefetch 永远不会成为
evidence、公开结果或写权限来源，也不得改变 RouteDecision。

天气属于 `task / direct-capability`：直接使用 `ExternalDataAdapter`，**不经过
Orchestrator 或 BackgroundTaskCoordinator**。只有具有充分、明确的复合任务证据时，
`task / orchestrated` 才使用 Orchestrator 与 `BackgroundTaskCoordinator`。

`RuntimeKernel` 建立 run/request ID、事件序列、终态 ledger 与公开 `RuntimeResult`，并把
RouteDecision 和 use-case 事实投影为同一条事件流；它不在路由之外另写策略，也不把展示文字
反推为执行事实。

已删除：`AgentRuntime`、`B2AgentCoordinator`、默认 full-B2 编排及其兼容 fallback／永久
feature flag。它们不是当前路径，也不得在新代码或现行文档中作为可重新开启的默认运行模式。

## 3. AI Agent and deterministic ownership

本项目只将以下使用 LLM 处理信息的角色称为 **AI Agent**：

- `Cabin Assistant` 始终拥有前台沟通：呈现澄清、边界或最终事实化回复，并在复合请求
  后台协调期间保持可中断的前台交互。
- `Orchestrator`：仅在复杂 `task / orchestrated` 路径中消费 frame-derived structured authority
  进行受约束计划；它不得重新解释原始用户文本，也不得增加 contract 未授权的 capability。

以下对象不是 Agent：Safety、Manual Retriever/RAG、VehicleStateProvider、Vehicle Tools、
Vehicle Execution Coordinator、ExternalDataAdapter 和各类 Adapter。它们分别是确定性裁决、
证据、状态事实、执行组件或接口；被 Agent 调用不会改变其类型或授权边界。
RAG 只能提供检索证据，不能授予语义 scope 或车辆写权限。
车辆知识由中性的 application contract/use case 承载：Manual Retriever 提供证据，Cabin
负责最终回答；只有复杂、多目标任务才由 Orchestrator 生成受约束计划。运行时不得恢复第三个
Vehicle Knowledge Agent 身份。

`VehicleStateProvider` 是车辆状态的唯一读取事实源。Sensor/Provider 链路是唯一可把车辆
状态写成 Runtime/Safety 可读事实的方式：模拟传感器只产生开发 reading，经 Provider ingestion
后才形成 snapshot。Safety 消费同一 Provider snapshot；模型、RAG、Tool acceptance、HMI
动画、用户文本及未入库 sensor reading 都不能替代它。当前 Sensor、Provider、Tools 均为明确
标识的模拟/开发边界，不代表真实车辆状态或执行。

## 4. Route flows

### 4.1 Chat

```text
RoutePolicy -> chat/direct -> chat use case -> response -> presentation
```

普通对话可使用会话提示和一次回答模型调用。它不生成 Vehicle ToolCall、Safety 结论或车辆状态。

### 4.2 Vehicle knowledge

```text
RoutePolicy -> vehicle-knowledge/direct -> Manual Retriever
  -> optional Provider refresh/read + Safety eligibility -> Cabin Assistant -> response
```

显式、可信的 ES8 知识请求直达该 use case；静态问题只使用手册证据。第 2 节的私有 manual
prefetch 只能在本路由被采用为检索候选，仍须经过正常 eligibility 才能成为证据。只有当前资格解释才读取
Provider 并请求 Safety 的只读资格判断。全链零 Vehicle ToolCall、零车辆写入。复杂知识请求可由
Orchestrator 规划，但最终回答仍归 Cabin；现行职责以本 spec 的角色图与所有权边界为准。
旧 B3 Vehicle Knowledge Agent 方案只属于本地迁移历史，不代表当前角色图。

### 4.3 Vehicle control

```text
Vehicle-SLU contract -> capability/slot validation -> refresh shared Provider snapshot
  -> Safety -> Tool/Adapter -> Provider confirmation -> response / HMI
```

车辆写权限的不可绕过边界为
`contract → capability/slot → Safety → Tool/Adapter → Provider`。

Safety-before-write、confirmation、`commandId` 与 Provider-confirmed animation 均由车辆执行
规范约束。Safety 拒绝、待确认、Provider 不可用或输入不完整都不得进入 Adapter 写入。

### 4.4 Task

`task / direct-capability` 当前只用于天气只读查询：`ExternalDataAdapter` 返回可引用的外部
事实或能力边界；它不调用 Orchestrator，也不写车辆。天气地点只来自 SLU contract
`weather.query` frame 的 `location` slot（含“这里/目的地”等指代）；slot 缺失时使用文档化的默认地点或澄清，
不得从原始文本解析地点。天气工具可依据原话组织回答的时间窗口与侧重点（如多日比较、穿衣建议），
这只影响回答组织，不影响路由、地点或任何授权。

Vehicle-SLU 可识别 `navigation`（含 `energy.findSwapStation`）、`media` 与 `phone`，但这些 capability 当前没有注册
生产 owner，因此仅保留在 envelope 和审计中并返回能力边界，不得执行。当前已注册路径是
general chat、vehicle knowledge/state 只读、weather 只读，以及 7 个车辆写 intent（与
`src/runtime/agent-schemas.js` 的 `VEHICLE_CONTROL_INTENTS` 一致）：`body.window.setPosition`、
`body.tailgate.open`、`seat.driver.setBackrestAngle`、`seat.comfort.setLevel`、
`cabin.comfort.applySettings`、`vehicle.component.setState`、`cabin.climate.setPreset`。

`task / orchestrated` 才创建 `BackgroundTaskCoordinator`。它在后台维护受验证计划的
`TaskSnapshot`、进度、取消与已提交效果；Cabin 保持前台沟通，基于事实展示进度、完成、失败
或取消。复杂任务中的车辆步骤仍复用同一个 vehicle-control use case，不能取得第二套
Safety、confirmation、Provider 或 Tool 权限。

## 5. Shared contracts and cancellation

- `RouteDecision`：RoutePolicy 生成的不可变路由、模式、理由、置信度及 Run 关联；终态决策
  没有 route/mode。
- `RunEvent`：Runtime 的可审计时序事实；Run Event Ledger 只保留当前 Run 与上一个已完成
  Run。回放仅消费事件，绝不重新执行。
- `TaskSnapshot`：复杂后台任务的 `queued/running/waiting/completed/failed/cancelled` 状态、
  当前阶段、已完成/活动/待处理步骤、`committedEffects`、取消状态和最新事实引用。
- `ExecutionFacts`：从实际 evidence、Safety、ToolResult、Provider snapshot 和已验证步骤投影
  的只读事实。计划意图、Adapter acceptance、动画和文案不是完成事实。
- `committedEffects`：已跨越外部效果边界的事实。取消若发生在效果提交之后，任务仍报告
  `cancelled`，但必须保留该效果；不得把它抹去或伪装成未发生。

Vehicle-SLU 的可选 `conversationGoal.dialogueAction=cancel_pending`（compact `c`）由本轮模型明确给出；只允许 vehicle/explain 且无帧，RoutePolicy 返回 terminal cancel 并清除当前 pending，不从原文关键词恢复取消语义。省略该字段保持原有非取消语义；取消与新肯定任务共存时模型输出独立新动作，由正常 pending replacement 处理。

取消会终止未提交的步骤与后续工作。确认场景以 challenge Run 与 confirmed Run 的真实关联为准；
HMI 公开关联两个 Run ID，且已消费的 challenge 不能重放以产生第二次写入。

## 6. Presentation and voice boundary

`runtime-presentation-bridge` 只消费当前 identity、replay 和 Provider/command 关联校验均通过的
Run Event 或 RuntimeResult。HMI 只能投影 pending 与 Provider-confirmed 执行事实；迟到的旧
terminal 可保留其自身命令事实，但不能污染替换后的交互 Run。

Runtime 在 route 后产生 `voiceBridgeEligibility`。这只授权普通对话的中性等待语音：不授权
Tool、Safety、外部数据或车辆操作。Presentation bridge 只转发完整且 Run/交互身份匹配的
Runtime 授权；其 `startVoiceBridge` 调用是 best-effort，失败不能中止 Run、改变 Safety 或影响
最终文本/TTS。桥接层不得重新计算或扩大这项授权。

开发者车辆状态面板不进入 Runtime route。它只在非 Run 执行期把本地模拟状态写入 Demo Sensor，
经 Provider snapshot 投影到 HMI/ES7，并记录本地开发审计；不得生成 Run Event、调用 Agent/LLM、
Safety 或 Tool。Run 执行中、存在待确认动作或 pending vehicle execution 时面板必须锁定。正常
Agent/Tool 链产生的新 Provider snapshot 仍可反向更新面板显示。

## 7. Non-bypassable invariants

1. 每个普通 turn 先产生一个经验证的 Vehicle-SLU envelope，然后每个 Run 只走一个 route；
   clarify/respond/cancel 不执行 use case。确认续接 turn 是唯一不调用 Vehicle-SLU 的例外。
2. 所有车辆写入在 Adapter 前经过 Safety；模型、RAG、HMI、外部数据与文案均不能授权写入。
3. Provider 是唯一车辆状态真相；只有关联 `commandId` 的 Provider confirmation 才能确认动画。
4. direct weather 不进入 Orchestrator；复杂协调不成为 chat、knowledge 或 control 的默认开销。
5. Agent 只能处理信息与受约束计划，不能重分类或覆盖确定性证据、Safety、Provider 或执行边界。
6. Run/Event/Task/ExecutionFacts 必须保留真实 source、provider、degraded、simulation 与关联 ID；
   开发夹具与 Adapter acceptance 不得描述为生产事实。

## 8. Runtime delivery validation

公开运行交付不包含本地 verifier 或 benchmark harness。交付检查只确认启动入口、ES module
语法、运行时静态引用以及必需资产/数据完整；模型资格、真实浏览器验收和云端调用预算属于本地
开发证据，不是安装或功能使用的前置文件。

所有启动入口（`npm start`、重启脚本、macOS 启动器）的默认 `vehicle_slu` Provider 都是本地
compact profile `local-compact-v10`（Ollama，non-thinking，无 fallback）。DashScope 云端
Vehicle-SLU 只能通过显式 `NIO_VEHICLE_SLU_PROFILE=cloud-dashscope` 选择，且仍为每个普通 turn
单请求。

benchmark fault-injection 只属于本地开发：故障档案模块是无副作用的纯模块，可被静态导入，
但只有同时显式启用 `NIO_DEV_BENCHMARK_FAULTS=true` 并选择具体 fault profile 时才生效；未启用时
任何故障字段都被拒绝而不是被忽略。

本地 Vehicle-SLU 请求数与云端模型请求数必须分开计数。在线验收 harness 不得启动、停止或重启服务。未获云端授权时请求上限默认为 `0`。

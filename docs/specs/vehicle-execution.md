# Vehicle Execution Specification

Status: current  
Authority: vehicle-write identity, lifecycle, observation correlation, Provider confirmation, Runtime result boundary, and HMI execution presentation.

## 1. Scope

本规范管理 `src/runtime/agent-schemas.js` 中 `VEHICLE_CONTROL_INTENTS` 注册的 7 个车内组件写操作：

| Tool | Component | Requested / confirmed fields |
|---|---|---|
| `body.window.setPosition` | `window` | `windowPositionPercentByZone` |
| `body.tailgate.open` | `tailgate` | `tailgateOpen` |
| `seat.driver.setBackrestAngle` | `seat` | `driverBackrestAngle` |
| `seat.comfort.setLevel` | `seat` | `seatComfortByZone` |
| `cabin.comfort.applySettings` | `cabin` | `windowPositionPercentByZone`, `cabinTemperature`, `climatePower`, `climateMode`, `fanLevel`（按请求实际包含的字段） |
| `vehicle.component.setState` | `vehicle-component` | `componentActionStateById` |
| `cabin.climate.setPreset` | `climate` | `cabinTemperature`, `climatePower`, `climateMode`, `fanLevel`, `airflow`, `passengerMode`（按请求实际包含的字段） |

导航和补能是 ExternalDataAdapter 的只读边界，不进入本状态机。RAG 只提供知识证据；
Safety 决定动作能否进入执行链；两者都不能声称车辆已执行。

## 2. Canonical flow

```text
ParsedCommand
  -> SafetyGateway
  -> ToolCall(stable commandId)
  -> VehicleExecutionCoordinator
  -> VehicleTools(request acceptance)
  -> DemoSensorSimulator / future production sensor adapter
  -> DevVehicleStateProvider.ingestObservation()
  -> Provider snapshot correlation
  -> RuntimeResult
  -> HMI pending / confirmed
```

`src/app/app.js` 是当前浏览器 composition root；在本地开发部署中，这些 Runtime 组件运行在浏览器页面进程内。它创建一份共享的 Provider、VehicleTools、
Simulator、Coordinator、Safety 和 `RuntimeKernel`；车辆写入只由注册到 RuntimeKernel 的
`vehicle-control` use case 执行。`src/app/runtime-presentation-bridge.js` 只消费 Runtime 的
Run Event/Result，再将已关联 `commandId` 与 Provider snapshot 的执行事实交给 HMI。

不得为了“统一构造”再创建第二个 Runtime、Provider、Coordinator 或旧的 AgentRuntime；浏览器
presentation bridge 不拥有 Safety、Provider 或车辆写授权。

## 3. Identity

每个车控 ToolCall 在创建时必须带稳定 `commandId`：

```text
<requestId>:<sequence>:<tool>
```

同一 request 内 sequence 从 1 开始。执行阶段不得再生成 ID，也不得使用
`requestId:tool` fallback。幂等、重复命令、传感器 observation、Provider snapshot 和
HMI pending 均以同一 commandId 关联。

## 4. State machine

状态集合：

```text
submitted
accepted
executing
observed-succeeded
failed
timeout
duplicate-command
```

合法迁移：

```text
submitted -> accepted
submitted -> failed
submitted -> timeout
submitted -> duplicate-command
accepted -> executing
executing -> observed-succeeded
executing -> failed
executing -> timeout
```

终态不可再次迁移。每次迁移追加不可变 executionTrace。失败、超时和重复命令必须带
结构化 executionError；成功必须带 `confirmedSnapshotId`。

## 5. ToolResult boundary

车控 ToolResult 只表达命令执行事实：

- requestId、commandId、tool；
- ok、executionState、executionTrace；
- requestedState（仅在合同允许时）；
- confirmedSnapshotId（仅确认成功）；
- executionError、hmiSummary、visualScenario、source、simulated。

车控 ToolResult 禁止携带 `statePatch`、`observedState`、`statePatchSource`、
`vehicleStateSnapshot` 或 `values`。Runtime 必须使用 `createVehicleToolResult()` 的
规范化返回值，不能把 Coordinator 原始额外字段透传。

ExternalDataAdapter 仍可使用自己的兼容 `statePatch`；它与车控 ToolResult 是两个边界。

## 6. Vehicle State Provider

Vehicle State Provider 是车辆状态唯一读取事实源。ToolCall、requestedState、
VehicleTools、Simulator、Runtime、HMI 和外部数据均不得维护第二份车辆真值。

当前 Provider：

- `getSnapshot()`：只读，不接受 patch；
- `ingestDemoSensorState()`：写入速度、挡位、净空、防夹、雨量、电量等非命令环境状态；
- `ingestObservation()`：只接收与 commandId、component 和 executing trace 关联的组件观测。

Snapshot 包含规范化 `values` 与 `capturedAtByField`。部分 ingestion 只刷新实际观测字段
的时间，不得给未更新的安全事实重新盖新时间戳。

## 7. Observation and confirmation

DemoSensorSimulator 是确定性的模拟物理输入源；它持久化自身模拟物理状态，但不是 Runtime、
Safety 或 HMI 的权威状态仓库。所有消费者仍只能读取 Provider 发布的 snapshot。它支持每组件的：

- success；
- no-update；
- conflict；
- timeout。

输入 validation、scheduler callback 或 Provider 异常属于错误路径并映射为结构化 failed；
它们不是 Simulator 的公开 mode。

Coordinator 只有在以下条件全部成立时才能返回 `observed-succeeded`：

1. observation commandId、component、时间窗口和字段覆盖合法；
2. Provider 接受 observation；
3. ingestion 返回的 snapshot 与当前单次读取 snapshot 身份和值一致；
4. 两份 snapshot 的相关组件字段都与 observation/requestedState 一致。

success 与 conflict observation 都会更新 Simulator 的模拟物理状态，避免下一次环境 refresh
把 Provider 回滚到旧值；no-update/timeout 不改变物理状态。冲突 observation 可以进入 Provider，
作为“传感器实际观测”，但命令结果必须保持 failed。no-update 必须保留 confirmation deadline，
到期后返回 `timeout / sensor-no-update`；显式 timeout 返回 `timeout / sensor-timeout`。Provider getter 每条恢复路径最多读取一次；异常或畸形
结果映射为明确 unavailable/null，不得让异常覆盖已经形成的终态 ToolResult。

## 8. Runtime boundary

Runtime 与 Coordinator 必须共享同一 Provider 实例。run option 不能注入替代车辆事实；
若保留 `vehicleStateSnapshot` 参数，只能用于同一 snapshot 身份断言。

初始 Provider throw/null/malformed 时，Runtime 使用合法、全字段 unknown 的
`runtime-provider-unavailable` sentinel。所有共享 registry 中的 vehicle-control intent
在进入 Coordinator 前统一 fail-close；conversation 与只读 external route 可继续。

Coordinator throw 或 malformed envelope 必须收敛为合法 `submitted -> failed`
ToolResult。RuntimeResult 单独携带最新 Provider snapshot 或明确 `null`。

## 9. HMI truth boundary

HMI 使用：

```js
mapVehicleExecutionToHmi({
  toolResult,
  vehicleStateSnapshot,
  previousConfirmedState,
})
```

- submitted、accepted、executing：只显示 pending，不播放最终动画；
- observed-succeeded：仅当 confirmedSnapshotId 与 snapshot.id 匹配时确认；
- 动画参数只从 snapshot values 投影；
- 一般 failed、timeout、duplicate：只取消相同 commandId 的 pending；
- `sensor-observation-conflict` 是唯一 failed 动画例外：只有已注册 dispatch、Run/command/component
  身份一致、事件 snapshot 投影与当前 Provider snapshot 一致且字段时间证明为执行后观测时，
  才播放 distinct `observed-conflict` actual-state reconciliation；动画读取实际值，命令仍 failed；
- 同组件新 pending 替换旧 pending；迟到旧终态不得覆盖新 pending；
- 一般失败保留上次 confirmed snapshot/presentation；合法 conflict 则合并 Provider 实际 snapshot；
- unknown tool fail-close；
- 外部数据展示使用独立兼容 mapper。

开发者车辆状态面板属于显式标记的本地仿真夹具，不属于上述 command-linked HMI execution
presentation。面板状态必须先经 Demo Sensor reading 和 Provider ingestion，再由 HMI 同步到最新
Provider snapshot；它不得创建 `commandId`、伪造 `observed-succeeded` 或显示车辆命令成功。
这个非命令状态投影例外只允许表达 Provider 已发布的模拟物理状态，不放宽任何 Runtime 车辆写入、
Safety、observation correlation 或 ToolResult 规则。

当前 Demo 为保证 pending 可感知，在 `app.js` 给 Simulator 配置 450ms 延迟；Coordinator
deadline 为 1000ms。真实生产延迟由适配器和 HMI 产品策略决定。

## 10. Demo / production boundary

当前 VehicleTools、DemoSensorSimulator 和 DevVehicleStateProvider 均为 simulated demo。
生产仍未接入：

- 真实 Vehicle Service Adapter / CAN 或域控写接口；
- 真实传感器/车身状态 Provider；
- 生产身份认证、权限、诊断和持久化幂等存储；
- 真实浏览器/车辆 HMI 的专项验收。

模拟成功只证明状态机与接口闭环，不证明真实车辆执行能力。

## 11. Runtime delivery validation

公开运行交付不包含本地 verifier。交付检查确认执行状态机及其 Runtime/HMI 依赖模块仍在
`src/` 中、可被 ES module loader 解析，且运行必需的配置和资产存在；真实车辆、浏览器和
生产 Provider 验收仍需在相应环境中另行完成。

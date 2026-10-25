# Safety and Vehicle State Specification

Status: current
Authority: Safety decision inputs and precedence, trusted VehicleStateSnapshot semantics and freshness, demo sensor-provider boundary, manual safety constraint application, ConfirmationChallenge lifecycle, and fail-safe verification.

> 公开运行交付不包含本地 verifier。文中保留的 verifier 文件名仅用于说明既有本地开发证据，
> 不是安装、启动或功能使用的前置文件。

## 1. Purpose and authority

本文档是以下事项的现行权威来源：

- Safety 决策的可信输入、执行门禁、enforcement profile、固定物理基线和裁决优先级；
- `VehicleStateSnapshot` 的结构、来源、仿真标记、单次运行绑定、未知值语义和时效；
- 本地 Demo Sensor Provider 与未来真实 VehicleState provider 的替换边界；
- Manual RAG 证据进入 Manual Constraint Registry、Manual Safety Policy 和 Safety Gateway 的信任边界；
- `ConfirmationChallenge` 的签发、验证、重入、消费、攻击面和当前已知缺口；
- 上述行为的 fail-safe 决策矩阵与可执行验证入口。

本文档不拥有 Manual RAG 的检索与问答策略，也不拥有 Vehicle Adapter 执行、`commandId`、`requestedState`、执行状态、sensor observation 或 Provider-confirmed completion；这些现行写执行规则见 [Vehicle Execution Specification](vehicle-execution.md)。Runtime 编排和跨 spec 所有权见第 13 节。

本文档同时区分 **Required contract** 与 **Current status / gap**。`必须`、`不得`和矩阵中的 Required result 定义目标安全规范；源码或 verifier 与目标不一致时，必须登记为当前不符合项。现有 verifier 退出 `0` 只证明它实际覆盖的 case，不表示整个实现已经符合本 spec。

Evidence:

- `safety-gateway.js`
- `vehicle-state.js`
- `confirmation-challenge.js`
- `manual-constraint-registry.js`
- `manual-safety-policy.js`
- `src/application/runtime-kernel.js`

## 2. Trust model

Safety 可以信任的输入仅包括：

1. 已注册的 Safety enforcement profile；
2. 固定 `SAFETY_BASELINE`；
3. 与当前 run 绑定、保留来源与时效元数据的 VehicleState；
4. 必需执行参数的显式来源，或绑定到可信 producer identity、由 Runtime 重新派生的 trusted-context provenance；
5. 由 Runtime 完成 challenge 校验后创建的 trusted confirmation assertions；
6. 通过本地 registry 内容完整性、来源、版本、页码、span 和 digest 校验并成功发布的 manual constraints。

用户文字、模型输出、会话记忆、HMI/display state、Adapter 的 `requestedState`、开发 `statePatch`、未入 Provider 的 sensor reading 以及任意外形类似可信确认的对象都不是车辆状态事实，不得直接覆盖或更新 VehicleState。原始 RAG 命中也不是 Safety 授权。VehicleState Provider 是唯一状态读取事实源；只有它显式 validation/ingestion 后发布的 snapshot 可供 Safety 消费，命令关联规则见 [Vehicle Execution Specification](vehicle-execution.md)。

Manual constraint 的当前可信度只表示仓库内本地 source/content integrity。它明确不代表人工审核、生产批准、身份认证、外部签名或 PKI。

当前实现使用 module-owned WeakSet 品牌化 trusted-context provenance。普通 JSON 或模型自报的 `"context"` 会在 Safety Gateway 降级为 `unknown`；只有 Runtime 通过可信 producer 路径创建的 provenance 才能满足 required slot 的 context 来源要求。

Evidence:

- `vehicle-state.js`
- `safety-gateway.js`
- `src/application/use-cases/vehicle-control.js`
- `scripts/verify/verify-vehicle-state-snapshot.mjs`

## 3. VehicleStateSnapshot contract

Safety 消费的快照包含：

| Field | Contract |
|---|---|
| `id` | 单个不可变 snapshot 的身份。所谓 stable 仅指该 snapshot 创建后身份不变；不表示跨 snapshot 或跨 run 恒定。 |
| `source` | 显式数据来源；缺失时为 `unknown`。 |
| `simulated` | 仅显式 `true` 才表示仿真来源。 |
| `capturedAt` | 非空时间字符串或 `null`；Safety 负责判断其是否为可解析、非过期、非越界未来时间。 |
| `freshnessMs` | 非负数或 `null`，参与快照年龄计算。 |
| `values` | 规范化且冻结的 VehicleState 字段集合。 |
| `capturedAtByField` | 每个规范字段最后一次实际观测时间；Safety 的时效判断以所需字段各自时间为准。 |

当前 `VehicleStateSnapshot` 契约没有 `snapshotId` 字段；当前身份字段是 `id`。若未来重命名为 `snapshotId`，必须单独迁移 producer、consumer、审计字段、验证器和兼容策略，不能由本次文档迁移隐式引入。

Required contract：规范化必须先把已知 VehicleState keys 初始化为 `null`，只用类型有效的输入覆盖。缺失、不可用或未知状态必须保留为 `unknown`/`null`，不得推断成静止、P 挡、后方安全、防夹可用或其他安全值。`freshnessMs` 未提供或不可用时也必须保持 `null`，不能被解释为零年龄。

Current status：`vehicle-state.js` 已使用严格类型规范化；显式 `null`、空字符串和布尔值不会被数值强转为安全事实。座椅字段统一为 `driverBackrestAngle`。`capturedAtByField` 防止部分 reading 给未更新字段重新盖时间戳。

Runtime 为每次 run 建立或重新规范化一份 snapshot，并把同一份 run-bound snapshot 传给 Safety。Demo HMI 在命令开始时必须先由 `DemoSensorSimulator.readVehicleState()` 产生新的模拟传感器读数并经 Provider ingestion 发布，不能复用页面加载时的旧时间戳；未知值仍保持 `null`。解析槽位中的速度、挡位、净空、防夹、雨量等值不能替代该快照。

Evidence:

- `vehicle-state.js`
- `safety-gateway.js`
- `src/application/use-cases/vehicle-control.js`
- `src/app/safety-state-refresh.js`
- `scripts/verify/verify-vehicle-state-snapshot.mjs`

## 4. Demo Sensor Provider

当前 `DevVehicleStateProvider` 是本地 Demo Sensor Provider，也是当前唯一 VehicleState 读取事实源：

- 输出固定标记 `source="dev-fixture"` 和 `simulated=true`；
- `getSnapshot()` 是只读接口，返回当前不可变 snapshot，不接受 patch；
- `ingestDemoSensorState()` 是非命令环境/Safety 状态的唯一 Demo 写入口；
- `ingestObservation()` 是 command-linked 组件确认的唯一写入口；
- 每次 ingestion 只刷新实际观测字段及其 `capturedAtByField`；
- 普通用户文字、模型槽位或确认响应不能修改速度、挡位、`rearClearance`、`windowAntiPinchAvailable`、`rainDetected` 等 fixture 状态。

Provider 边界必须保持可替换。未来真实 VehicleState provider 可以接入真实来源、时间与观测值，但 Safety 消费的 snapshot shape 不应因此改变。

主页面开发者车辆状态面板是 Demo Sensor 的仿真夹具，不是车辆写授权入口。它可以通过
`DemoSensorSimulator.readVehicleState()` 产生环境、Safety 和 ES7 组件的非命令 reading，再由
`ingestDemoSensorState()` 发布新 snapshot；页面控件或 Three.js 不得直接成为状态源。该路径不创建
SafetyDecision、ToolCall、command observation 或执行成功事实。开发者随后发起的自然语言车辆命令
仍必须使用同一 Provider snapshot 并完整经过 Safety、确认和 Vehicle Execution 链。

Evidence:

- `vehicle-state.js`
- `safety-gateway.js`
- `src/app/safety-state-refresh.js`
- `app.js`
- `src/app/developer-vehicle-state-controller.js`
- `scripts/verify/verify-vehicle-state-snapshot.mjs`

## 5. Freshness and fail-safe

`VEHICLE_STATE_FRESHNESS_POLICY` 当前规定 `maxAgeMs=5000`、`futureToleranceMs=1000`。Safety 对每个 governed intent 所需字段的 `capturedAtByField` 应用该策略：

- tailgate：`speedKph`、`gear`、`rearClearance`；
- window：`windowAntiPinchAvailable`、`rainDetected`；
- seat：`speedKph`。

只有 freshness 为 `fresh` 时，时间敏感字段才可参与裁决。缺失 snapshot、stale timestamp、越过容差的 future timestamp、缺失或 invalid timestamp、缺失年龄或 freshness 无法计算时，依赖这些状态的动作必须 fail safe。非 fresh snapshot 的时间敏感字段必须被无效化，而不是沿用看似安全的旧值。

Required contract 将“已知不安全事实”和“缺少可裁决事实”分开处理：已知不安全事实使用
`reject`；snapshot/Provider 不可用、字段不新鲜或 required field 为 unknown 时使用
`unavailable`，且不得创建 Vehicle ToolCall。fresh snapshot 内唯一例外是尾门后方净空未知：
在速度与挡位均安全时保持 `require_confirmation`，用户确认不能伪造传感器事实。

- tailgate open：移动、非 P 挡或 `rearClearance=false` 为 `reject`；`speedKph`/`gear`
  unknown 为 `unavailable`；静止、P 挡且 `rearClearance` unknown 为 `require_confirmation`；
- window：`windowAntiPinchAvailable=false` 为 `reject`；防夹或雨量 unknown/missing 为
  `unavailable`，不能按防夹可用或无雨处理；
- seat：已知移动状态按固定姿态边界裁决；`speedKph` unknown 为 `unavailable`。

Current status：Gateway 已按 `SAFETY_STATE_FIELDS_BY_INTENT` 检查字段级时间与 presence；缺失
snapshot、过期、未来或非法 required field 返回 `action=unavailable`。Runtime 在 Provider 不可用时
还会对共享 registry 中全部 vehicle-control intent 统一阻断，包括 climate。window 的
`rainDetected=null` 已返回 unavailable；已知 `windowAntiPinchAvailable=false` 仍返回 reject。

Climate 当前不依赖 VehicleState freshness，但仍受已注册 profile、参数 provenance 和固定 baseline 约束。

Evidence:

- `safety-gateway.js`
- `scripts/verify/verify-safety-enforcement-coverage.mjs`
- `scripts/verify/verify-safety-baseline-contract.mjs`
- `scripts/verify/verify-vehicle-state-snapshot.mjs`

## 6. Actionability and slot provenance

只有同时满足以下条件的输入才可进入可执行车辆路径：

1. `speechAct=command`；
2. `actionable=true`；
3. 原始输入存在与 intended intent 匹配的显式 action predicate；
4. intent 已注册相应 Safety profile；
5. 所有 required executable arguments 都存在并带有可审计的可信 provenance。

Required contract 只接受 `explicit` 或具有可信 origin binding 的 `context` provenance。`unknown`、缺失、`preference`、`memory-reference`、`context-memory` 或无 provenance 的值不能满足必需参数。Runtime 和 Safety 都不得使用会话记忆补齐可执行参数。

Current status：Safety Gateway 只接受 module-owned WeakSet 品牌化的 trusted-context provenance。`scripts/verify/verify-lean-runtime-vehicle-control.mjs` 同时覆盖普通 `"context"` 伪造被拒绝和 Runtime trusted-context 正例。

`slotProvenance` 必须贯穿 Safety decision 和 ToolCall 审计。用户或模型提供的 `vehicleSpeedKph`、`rearClearance`、`antiPinch` 等伪状态槽位必须被移除或忽略，不能转化为 trusted context。

Evidence:

- `agent-schemas.js`
- `safety-gateway.js`
- `scripts/verify/verify-safety-enforcement-coverage.mjs`
- `scripts/verify/verify-safety-baseline-contract.mjs`
- `scripts/verify/verify-lean-runtime-route-policy.mjs`
- `scripts/verify/verify-lean-runtime-vehicle-control.mjs`

## 7. Safety enforcement profiles

每个 governed vehicle intent 必须具有已注册且版本化的 Safety enforcement profile。当前 registry 覆盖 tailgate、window、driver seat、climate、只读 navigation/energy 和 `safety.reject`。

未注册 intent 必须 `reject`。已注册 profile 如果没有命中对应 enforcement handler，也必须 fail close，不能落入默认允许。只读 external-data profile 只允许进入只读 Adapter，不赋予车辆写入能力。

新增或改变 vehicle intent 时，profile、handler 和验证器必须同步更新；仅把 intent 加入 schema 不能形成执行权限。

Current verification status：`safety-gateway.js` 的默认分支实现了 registered profile without handler 的 fail-close，但当前 `scripts/verify/verify-safety-enforcement-coverage.mjs` 没有构造该 case；该要求目前是 source-only，缺少精确 verifier。

Evidence:

- `safety-gateway.js`
- `scripts/verify/verify-safety-enforcement-coverage.mjs`
- `scripts/verify/verify-safety-baseline-contract.mjs`

## 8. Baseline and decision precedence

所有物理边界只能来自固定 `SAFETY_BASELINE`。当前受本 spec 管理的边界包括：

- seat：最小角度 90°（`minAngle: 90`），静止最大角度 118°，行驶最大角度 112°，默认角度 106°；
- climate：温度 15–31°C（`minTemperature: 15`、`maxTemperature: 31`），风量 0–8 挡（`minFanLevel: 0`、`maxFanLevel: 8`）；
- window：检测到雨量时最大开度 30%。

Safety 最终裁决强度必须按以下顺序比较：

```text
reject > require_confirmation > clamp > allow
```

Manual Safety Policy 只能维持或加强固定结果，不能弱化它。手册 policy bundle 不允许 `allow` effect；无效 effect、弱于 baseline 的 effect 或缺少经校验 clamp 参数都必须 fail close。policy 数字 priority 不能压过上述 severity 顺序。

Seat 的 Required contract 还要求保留原始 requested angle 及 out-of-range audit；任何超出适用 stationary/driving 范围的原始请求都应由 Safety decision 返回 `clamp`。当前 `normalizeSlots()` 保留 `requestedAngle` 与 `angleOutOfRange`，Safety 按 stationary/driving 上限生成明确 `clamp` decision；原始 130° 静止请求会保留审计值并限制到 118°。

Evidence:

- `agent-schemas.js`
- `safety-gateway.js`
- `manual-safety-policy.js`
- `scripts/verify/verify-safety-enforcement-coverage.mjs`
- `scripts/verify/verify-safety-baseline-contract.mjs`

## 9. Manual safety constraint boundary

Manual RAG 到 Safety 之间分为四层：

1. **Manual RAG** 拥有 query planning、retrieval、ranking、eligibility、citations 和原始 `manualEvidence`。
2. **Manual Constraint Registry** 把 evidence 绑定到本地 registry 中登记的 source/chunk、版本、页码、完整内容或 reviewed span proof 以及 digest；只有 trust state 和完整性都有效的条目才能发布。本地字段名包含 `reviewed`，但当前 telemetry 明确为 `humanReviewed=false`、`productionApproved=false`。
3. **Manual Safety Policy** 只在可信、已发布且 citation binding 匹配的 constraint 上求值，effect 仅可为 `reject`、`require_confirmation` 或 `clamp`。
4. **Safety Gateway** 把有效 manual policy 与固定规则、trusted VehicleState、`slotProvenance` 和 Runtime-validated trusted confirmation assertions 合并为最终裁决。

Raw RAG hits 只能作为审计和解释输入，不能直接允许、拒绝、限幅或要求确认。低置信、无证据、retrieval unavailable、内容或 bundle tampering、未发布、revoked、版本回滚、future/unsigned trust state、无效 trust state 或 citation binding 失败时，必须回到保守的 fixed-rule fallback。

这里的 `unsigned` 表示当前本地版本/完整性契约不受信，不得被解释为系统已经具备外部 signer。当前实现没有人工批准、生产批准、外部签名或 PKI。

Manual policy 不能产生绕过 baseline 的 `allow`，也不能把 `reject` 降为 `require_confirmation`/`clamp`/`allow`，或把 `require_confirmation` 降为 `clamp`/`allow`。

Evidence:

- `manual-constraint-registry.js`
- `manual-safety-policy.js`
- `safety-gateway.js`
- `scripts/verify/verify-manual-constraint-registry.mjs`
- `scripts/verify/verify-safety-manual-constraints.mjs`
- `scripts/verify/verify-manual-safety-policy-bundle.mjs`

## 10. ConfirmationChallenge lifecycle

只有 `require_confirmation` decision 可以签发 `ConfirmationChallenge`。当前 challenge 绑定：

- challenge `id`；
- 基于 requestId、intent、排序 slots 和 policy 元数据计算的 `actionDigest`；
- challenge 发起 requestId；
- policy id/version；
- risk-specific assertions；
- 随机 response token；
- `issuedAt`、`expiresAt`；
- Runtime challenge store 中的一次性 `consumed` 状态。

wrong requestId、wrong token、action tampering、不同 action 或 policy 的跨请求复用、cross-policy use、incomplete/wrong assertions、expiry、已消费后的 replay、slot/context forgery 以及 arbitrary trusted-looking objects，都会在 Vehicle Adapter 执行前被拒绝。

有效 confirmation response 必须回到 Runtime 校验，再以 module-private 品牌化 trusted assertions 重新进入 Safety。只有 Safety 重评估允许后 Runtime 才消费 challenge 并调用 Vehicle Adapter；HMI 不能直接执行动作。

HMI 安全确认弹窗一打开即可确认或取消，不必等待风险提示播报结束（2026-10-04 决定）：确认会先停止播报、等当前 Run 结束，再按上述路径重新进入 Runtime 与 Safety；取消停止播报并清除待确认，不重新进入 Runtime、零 Vehicle ToolCall。只有 Run 仍在执行（尚未进入播报阶段）时才禁用这两个按钮。

确认续接 turn（同一 `ConfirmationChallenge` 的第二次运行）是“每个普通 turn 一次 Vehicle-SLU 请求”的显式例外：它不调用 Vehicle-SLU，只复用 vehicle-control use case 私有保存的 challenge 绑定；续接时必须重新读取 Provider snapshot 并重新运行 Safety，不得复用签发时的 snapshot 或 Safety 结论。

用户 acknowledgment 只证明用户确认了特定风险，不会断言 `rearClearance=true`、`antiPinch`/防夹可用、车辆静止、P 挡或任何其他传感器观察。消费 challenge 不得修改 simulated sensor fixture，确认后的 snapshot 仍保留原有 unknown/null 状态。

Evidence:

- `confirmation-challenge.js`
- `src/application/use-cases/vehicle-control.js`
- `src/interaction/interaction-session-controller.js`
- `safety-gateway.js`
- `scripts/verify/verify-confirmation-challenge.mjs`

## 11. Required decision matrices

### VehicleState

| Case | Required result | Current status / gap | Verification status |
|---|---|---|---|
| Numeric normalization | 显式 `null`、空字符串、布尔和其他非 number 输入保持 `null`，不得制造安全数值。 | **Compliant**：严格 number/type normalization 已接入。 | `verify-vehicle-state-snapshot.mjs` 覆盖 null/empty/boolean VehicleState。 |
| Metadata | snapshot 记录 `id`、`source`、`simulated`、`capturedAt`、`freshnessMs`、`capturedAtByField`；`id` 仅在该不可变 snapshot 内稳定。 | Shape 与严格 freshness normalization 符合。 | Shape 有 verifier；`freshnessMs` explicit-null 可继续补强。 |
| Fresh | timestamp/freshness 有效且 required field 具备 intent-specific 可用值时才进入 handler。 | 字段级 freshness 与 presence 已实现。 | Timestamp path 与 partial-ingestion 有 verifier；field-specific status 见下表。 |
| Stale | 时间敏感字段失效；依赖它们的动作 `unavailable`，零 Vehicle ToolCall。 | Compliant for covered intents。 | `verify-safety-sensor-execution-flow.mjs` 覆盖 stale window；snapshot verifier 保持时间边界覆盖。 |
| Future | 超过 future tolerance 的 timestamp 使时间敏感字段失效并 `unavailable`。 | Compliant for covered intents。 | `verify-vehicle-state-snapshot.mjs` 覆盖 future window。 |
| Invalid timestamp | 缺失或不可解析的 `capturedAt` 按 invalid/missing timestamp fail safe。 | Compliant for covered intents。 | `verify-vehicle-state-snapshot.mjs` 覆盖 missing timestamp seat 与 invalid timestamp window。 |
| Missing snapshot | 依赖 VehicleState 的 tailgate/window/seat 必须 `unavailable`，零 Vehicle ToolCall。 | Compliant；扁平 context 不能替代 snapshot。 | `verify-safety-sensor-execution-flow.mjs` 覆盖完全 missing snapshot。 |
| Missing/unknown field | 必须按 intent/field 采用下表结果；除尾门净空确认特例外，缺事实为 `unavailable`，不能当作 false/safe。 | Compliant for covered fields。 | `verify-safety-sensor-execution-flow.mjs` 覆盖 unknown rain；其他字段保持 focused verifier。 |

### Tailgate

| State | Required result | Current status / gap | Verification status |
|---|---|---|---|
| `speedKph=0`, `gear=P`, `rearClearance=true` | 打开 tailgate 为 `allow`。 | Source-compliant。 | N/A：focused verifier 未覆盖 exact safe case。 |
| moving、non-P 或 `rearClearance=false` | `reject`。 | Source-compliant。 | N/A：focused verifier 未逐项覆盖。 |
| `speedKph` 或 `gear` unknown | `unavailable`。 | Handler 与严格 numeric normalization 符合。 | 保持 unknown/stale/future 负样本。 |
| 静止/P 且 `rearClearance=null` | tailgate open 为 `require_confirmation`；manual constraint 不可用时保持 fixed-rule fallback。 | Compliant for open path。 | `verify-vehicle-state-snapshot.mjs` 与 `verify-safety-manual-constraints.mjs` 覆盖。 |
| stale/future/invalid snapshot | `unavailable`，不得使用看似安全的旧值。 | Source-compliant。 | Stale 有 verifier；future/invalid tailgate exact cases可继续扩充。 |

### Window

| State | Required result | Current status / gap | Verification status |
|---|---|---|---|
| `windowAntiPinchAvailable=true`, `rainDetected=false` | `allow`。 | Compliant。 | `verify-safety-manual-constraints.mjs` 覆盖 no-rain fixture。 |
| anti-pinch 明确为 false | `reject`；manual policy 只能维持或加强。 | Compliant。 | `verify-safety-sensor-execution-flow.mjs` 覆盖。 |
| anti-pinch 可用且 `rainDetected=true` | 超出 `SAFETY_BASELINE.window.rainCloseMaxPercent` 的请求 `clamp`。 | Source-compliant。 | Baseline verifier只静态确认常量引用；无 decision-level rain clamp verifier。 |
| anti-pinch 或 `rainDetected` 为 null/missing | `unavailable`；不得按防夹可用或 no-rain 处理。 | Compliant。 | `verify-safety-sensor-execution-flow.mjs` 覆盖 unknown rain。 |
| stale/future/invalid snapshot | `unavailable`。 | Compliant for covered paths。 | sensor flow 与 snapshot verifier 覆盖 stale/future/invalid 边界。 |

### Seat

| State | Required result | Current status / gap | Verification status |
|---|---|---|---|
| stationary, requested angle in 90–118° | `allow`。 | Source-compliant。 | `verify-safety-manual-constraints.mjs` 只覆盖一个 stationary in-range case。 |
| driving, requested angle in 90–112° | `allow`。 | Source-compliant。 | N/A：无 focused decision verifier。 |
| 原始请求超出适用范围 | 保留 raw requested angle/out-of-range audit，并由 Safety 返回 `clamp`。 | Compliant：保留 `requestedAngle`/`angleOutOfRange`。 | `scripts/verify/verify-safety-enforcement-coverage.mjs` 覆盖 stationary 130° → clamp 118°。 |
| speed unknown | `unavailable`。 | Handler 与严格 numeric normalization 均符合。 | 可继续补 exact fresh-null verifier。 |
| stale/future/invalid snapshot | `unavailable`。 | Source-compliant。 | Missing timestamp seat 有 verifier；其他 exact cases可继续扩充。 |

### Climate

| State | Required result | Current status / gap | Verification status |
|---|---|---|---|
| 目标温度在 15–31°C | `allow`。 | Compliant。 | `verify-safety-enforcement-coverage.mjs` 覆盖 22°C。 |
| 原始目标温度低于 15°C 或高于 31°C | 即使 normalized slot 被限到边界，仍因 `temperatureOutOfRange` `reject`。 | Source-compliant；raw requested temperature 与 flag 被保留。 | `verify-safety-baseline-contract.mjs` 覆盖 normalization/flag，但未执行 Gateway reject；decision-level verifier N/A。 |

### Generic Safety

| Case | Required result | Current status / gap | Verification status |
|---|---|---|---|
| Unregistered governed intent | `reject` / fail close。 | Compliant。 | `verify-safety-enforcement-coverage.mjs`。 |
| Non-command、non-actionable 或缺少 intent-matching predicate | 不进入执行路径；Safety bypass 尝试也 `reject`。 | Compliant on standard normalization path。 | `verify-lean-runtime-route-policy.mjs`。 |
| Required slot missing、`unknown`、`preference` 或 memory provenance | `reject` 或在 Safety 前转入 clarification；不得创建车辆 ToolCall。 | Compliant for covered labels。 | `verify-lean-runtime-vehicle-control.mjs`。 |
| Required slot with self-reported `context` | 只有可信 producer/origin binding 后才能满足 required slot。 | Compliant：普通字符串降级为 `unknown`，品牌化 provenance 才可信。 | `scripts/verify/verify-lean-runtime-vehicle-control.mjs`。 |
| Registered profile without handler | `reject` / fail close。 | Source branch exists。 | N/A：`verify-safety-enforcement-coverage.mjs` 未构造该 case。 |

### Manual policy

| Case | Required result | Current status / gap | Verification status |
|---|---|---|---|
| Trusted, integrity-checked, published constraint | 仅在 applicability 与 citation binding 匹配时应用 `reject`、`require_confirmation` 或有安全参数的 `clamp`。 | Compliant within local-only trust boundary。 | 三个 focused manual verifier。 |
| Low confidence、no evidence 或 retrieval unavailable | fixed-rule fallback。 | Compliant for covered cases。 | `verify-safety-manual-constraints.mjs`。 |
| Tampered、unpublished、revoked、unsigned/untrusted version、rollback 或 invalid trust state | 不应用 manual constraint；fixed-rule fallback，必要时进一步 fail close。 | Compliant for covered cases。 | `verify-manual-constraint-registry.mjs`, `verify-manual-safety-policy-bundle.mjs`。 |
| Manual effect weaker than baseline 或 `allow` | 不应用；固定 baseline 保持不变。 | Compliant。 | `verify-manual-safety-policy-bundle.mjs`。 |

### Confirmation attacks and lifecycle

| Case | Required result | Current status / gap | Verification status |
|---|---|---|---|
| Valid response, first use | Runtime 校验后重入 Safety；若重评估允许，challenge 消费且 Adapter 恰好执行一次。 | Compliant。 | `verify-confirmation-challenge.mjs`。 |
| Wrong token | `reject`，Adapter 不执行。 | Compliant。 | 同上。 |
| Action/digest tampering | `reject`，Adapter 不执行。 | Compliant。 | 同上。 |
| Cross-request with different action or policy | action digest 或 policy 不匹配，`reject`。 | Compliant for changed-action/policy case。 | 同上；现有 cross-request case 改变 action slots。 |
| Cross-policy use | `reject`。 | Compliant。 | 同上。 |
| Incomplete/wrong risk assertion | `reject`。 | Compliant。 | 同上。 |
| Expired challenge | `reject`。 | Compliant。 | 同上。 |
| Replay after consumption | `reject`，不得再次执行。 | Compliant。 | 同上。 |
| Parsed slot、unbranded context 或 wrong-risk branded assertion forgery | 不满足 trusted assertion，保持 `require_confirmation` 或 `reject`。 | Compliant for covered cases。 | 同上。 |
| Unconsumed same-action/same-policy challenge reused across a different `requestId` | 必须 `reject`。 | Compliant：challenge、response validation 与 digest 均绑定发起 requestId。 | `scripts/verify/verify-confirmation-challenge.mjs`。 |

Evidence:

- `vehicle-state.js`
- `safety-gateway.js`
- `agent-schemas.js`
- `manual-constraint-registry.js`
- `manual-safety-policy.js`
- `confirmation-challenge.js`
- `src/application/use-cases/vehicle-control.js`
- `scripts/verify/verify-vehicle-state-snapshot.mjs`
- `scripts/verify/verify-safety-enforcement-coverage.mjs`
- `scripts/verify/verify-safety-baseline-contract.mjs`
- `scripts/verify/verify-safety-manual-constraints.mjs`
- `scripts/verify/verify-manual-safety-policy-bundle.mjs`
- `scripts/verify/verify-confirmation-challenge.mjs`

## 12. Development and production boundary

当前 sensor provider 是 **local demo/simulated** 实现，snapshot 必须保留 `simulated=true` 和真实 `source`。它只支持开发 fixture 和离线验证，不代表已连接真实车辆传感器。

Production integration 是 future work。生产接入至少需要真实 VehicleState provider、可信来源和时间、字段级观测契约、故障与断连策略，以及相应端到端验收；provider 替换不得改变 Safety 消费的 snapshot shape。

当前 Manual Constraint Registry 与 policy bundle 也仅具备本地内容完整性保护：`humanReviewed=false`、`productionApproved=false`，没有外部 signer 或 PKI。任何生产审批、签名或身份认证能力都属于未来独立工作。

本阶段已经关闭的本地边界是：Provider snapshot 唯一事实读取、legacy `vehicleContext/contextPatch`
旁路移除、known-unsafe 与 unavailable 分流、版本化 enforcement profile，以及 Safety audit/fact refs。
这不代表全部 intent×field×timestamp 组合均已验收；表中标注 N/A 或“可继续扩充”的用例仍是
验证残余。生产化仍需真实 Provider、身份与密钥边界、故障注入及车辆级验收。

Vehicle Adapter 执行、幂等、`requestedState`、`commandId`、sensor observation 和 Provider-confirmed completion 不属于本 spec，详见 [Vehicle Execution Specification](vehicle-execution.md)；sensor reading 在 Provider 显式 validation/ingestion 前不得直接更新 VehicleState，且不能根据本地开发执行结果宣称生产车辆动作完成。

Evidence:

- `vehicle-state.js`
- `app.js`
- `manual-constraint-registry.js`
- `manual-safety-policy.js`
- `confirmation-challenge.js`
- `src/application/use-cases/vehicle-control.js`
- `src/app/safety-state-refresh.js`
- `scripts/verify/verify-vehicle-state-snapshot.mjs`
- `scripts/verify/verify-manual-constraint-registry.mjs`
- `scripts/verify/verify-manual-safety-policy-bundle.mjs`
- `scripts/verify/verify-confirmation-challenge.mjs`

## 13. Related specs

- [Runtime Architecture Specification](runtime-architecture.md) 是 Runtime 生命周期、编排顺序和非绕过架构边界的权威来源。
- [Vehicle Execution Specification](vehicle-execution.md) 是现行 authority，拥有 Vehicle Adapter execution、`commandId`、幂等、执行状态、ToolResult 边界、sensor observation，以及 Provider snapshot 关联后的确认完成。
- [PROJECT_GUIDE.md Manual RAG material](../../PROJECT_GUIDE.md) 在其专项迁移前仍是 Manual RAG query planning、retrieval、ranking、eligibility、citations、grounding 和问答行为的现行权威。

本 spec 与 Runtime spec 的职责分离：Runtime 拥有调用顺序；本 spec 拥有 Safety/VehicleState/confirmation 规则和 Provider snapshot 信任/新鲜度；Vehicle Execution spec 拥有动作执行结果、sensor observation 与 Provider snapshot 关联后的确认完成。Provider 始终是唯一状态读取事实源。

Evidence:

- `docs/specs/runtime-architecture.md`
- `PROJECT_GUIDE.md`
- `src/application/runtime-kernel.js`

## 14. Verification map

| Concern | Source evidence | Verifier coverage / status |
|---|---|---|
| Snapshot identity、shape、omitted-value defaults | `vehicle-state.js`, `src/application/use-cases/vehicle-control.js` | `scripts/verify/verify-vehicle-state-snapshot.mjs` 覆盖 `id` 关联、shape、omitted values。 |
| Numeric VehicleState unknown preservation | `vehicle-state.js` 严格 number/type normalization | `verify-vehicle-state-snapshot.mjs` 覆盖 null/empty/boolean。 |
| `freshnessMs` unknown preservation | `vehicle-state.js` 严格 finite-number normalization | Shape verifier 已覆盖；可继续补 explicit-null 专项断言。 |
| Run-bound demo fixture 与 ordinary text 隔离 | `vehicle-state.js`, `src/app/safety-state-refresh.js`, `src/application/use-cases/vehicle-control.js` | `scripts/verify/verify-vehicle-state-snapshot.mjs`。 |
| Snapshot stale/future/missing/invalid timestamp | `safety-gateway.js:249-307` | `scripts/verify/verify-vehicle-state-snapshot.mjs` 覆盖 stale tailgate、future/invalid window、missing timestamp seat；不等于全部 intent×timestamp 组合。 |
| Completely missing snapshot | `safety-gateway.js` 的 required-fresh-fields gate | `verify-safety-sensor-execution-flow.mjs` 覆盖 `action=unavailable`、零 ToolCall。 |
| Tailgate speed/gear/rear-clearance decisions | `safety-gateway.js:132-175` | Unknown rear confirmation 有 `verify-vehicle-state-snapshot.mjs` / `verify-safety-manual-constraints.mjs`；safe/moving/non-P/blocked 与 fresh-null speed/gear 无完整 verifier。 |
| Window anti-pinch decisions | `safety-gateway.js` window handler | False reject 由 `verify-safety-sensor-execution-flow.mjs` 覆盖；null 进入 unavailable gate。 |
| Window rain clamp | `safety-gateway.js:196-203` | `verify-safety-baseline-contract.mjs` 只静态确认 baseline 引用；decision-level verifier N/A。 |
| Window unknown rain fail-safe | `safety-gateway.js` required-state gate | `verify-safety-sensor-execution-flow.mjs` 覆盖 fresh null → unavailable、零 ToolCall。 |
| Seat stationary/driving decisions | `agent-schemas.js:588-590`, `safety-gateway.js:206-216` | 一个 stationary in-range case 有 `verify-safety-manual-constraints.mjs`；driving matrix 不完整。 |
| Seat raw out-of-range audit 与 Safety `clamp` | `agent-schemas.js:588-590` 与 `safety-gateway.js:211-216` 是 **counterevidence** | Baseline verifier只静态确认常量；stationary 130° decision 无 verifier；follow-up TDD required。 |
| Climate in-range/out-of-range | `agent-schemas.js:593-607`, `safety-gateway.js:219-228` | In-range 有 `verify-safety-enforcement-coverage.mjs`；out-of-range normalization 有 `verify-safety-baseline-contract.mjs`，Gateway reject 无 exact verifier。 |
| Speech act 与 action predicate | `agent-schemas.js`, `safety-gateway.js` | `scripts/verify/verify-lean-runtime-route-policy.mjs`。 |
| Required slot missing/unknown/preference/memory exclusion | `agent-schemas.js`, `safety-gateway.js`, `src/application/use-cases/vehicle-control.js` | `scripts/verify/verify-lean-runtime-vehicle-control.mjs`。 |
| Trusted-context origin binding | `agent-schemas.js` module-owned provenance | `verify-lean-runtime-vehicle-control.mjs` 覆盖普通字符串伪造拒绝与 Runtime trusted-context 正例。 |
| Profile registry coverage 与 unregistered fail-close | `safety-gateway.js:37-52,89-97` | `scripts/verify/verify-safety-enforcement-coverage.mjs`。 |
| Registered profile without handler fail-close | `safety-gateway.js:240-245` | N/A：source-only，coverage verifier 未构造该 case。 |
| Fixed physical baseline | `agent-schemas.js`, `safety-gateway.js` | `scripts/verify/verify-safety-baseline-contract.mjs` 只证明指定分支引用 baseline。 |
| Manual RAG query/retrieval/ranking/eligibility/citation/raw evidence ownership | `manual-rag-retriever.js`, `manual-evidence-eligibility.js`, `src/application/use-cases/vehicle-knowledge.js`（检索 query 来自 Vehicle-SLU knowledge 帧） | `scripts/verify/verify-manual-evidence-eligibility.mjs`, `scripts/verify/verify-manual-conversation-runtime.mjs`；该行为仍由 `PROJECT_GUIDE.md` 管理。 |
| Constraint publication、content/span/page/version/digest binding | `manual-constraint-registry.js` | `scripts/verify/verify-manual-constraint-registry.mjs`。 |
| Local-only integrity、非人工/非生产/非 PKI boundary | `manual-constraint-registry.js`, `manual-safety-policy.js` | `scripts/verify/verify-manual-constraint-registry.mjs`, `scripts/verify/verify-manual-safety-policy-bundle.mjs`。 |
| Manual constraint 到 Safety 的 applicability | `manual-constraint-registry.js`, `manual-safety-policy.js`, `safety-gateway.js` | `scripts/verify/verify-safety-manual-constraints.mjs`。 |
| Severity precedence、non-weakening、no `allow` | `manual-safety-policy.js`, `safety-gateway.js` | `scripts/verify/verify-manual-safety-policy-bundle.mjs`。 |
| Challenge digest/policy/token/assertion/expiry/consume | `confirmation-challenge.js`, `src/application/use-cases/vehicle-control.js` | `scripts/verify/verify-confirmation-challenge.mjs`。 |
| Confirmation 不伪造 sensor fact | `confirmation-challenge.js`, `src/application/use-cases/vehicle-control.js`, `safety-gateway.js` | `scripts/verify/verify-confirmation-challenge.mjs`。 |
| Cross-request rejection（含 same-action/same-policy） | `confirmation-challenge.js`, `src/application/use-cases/vehicle-control.js`, `src/interaction/interaction-session-controller.js` | `scripts/verify/verify-confirmation-challenge.mjs` 覆盖 requestId mismatch、changed action 与 changed policy。 |
| Local demo / production integration boundary | `vehicle-state.js`, `app.js`, `manual-constraint-registry.js`, `manual-safety-policy.js` | Local/simulated 与 local-only trust 有上述 focused verifiers；生产接入未完成，N/A。 |
| Vehicle Execution exclusion | `vehicle-tools.js`, `execution-state-contract.js`, `vehicle-execution-coordinator.js`, `src/application/use-cases/vehicle-control.js` | `scripts/verify/verify-vehicle-execution-coordinator.mjs` 与 `scripts/verify/verify-lean-runtime-vehicle-control.mjs` 证明独立执行/编排契约；权威规则见 current [Vehicle Execution Specification](vehicle-execution.md)。 |
| Runtime、Manual RAG 与 risk-register authority exclusions | `docs/specs/runtime-architecture.md`, `PROJECT_GUIDE.md`, `docs/audits/HARD_CODE_AUDIT.md` | N/A：文档所有权 concern；由 Task 5 structural/link scans 验证，不以 Runtime verifier 代替。 |
| 第 11 节完整矩阵 | 上述逐行 source | N/A：没有单一 verifier 完整覆盖；每行已单独标明 supported、partial、counterevidence 或 missing。 |

本 spec 定义目标安全契约，并诚实登记当前实现的 conformance、non-conformance 与 verification gap；它不改变 Runtime 或车辆执行行为。所有现有 verifier 即使退出 `0`，也只证明其列出的覆盖范围。

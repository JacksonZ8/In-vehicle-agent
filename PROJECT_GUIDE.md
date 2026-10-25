# 蔚来车载智能交互 Multi-Agent 项目手册

本文件是项目导航，只维护稳定目标、当前能力、启动入口、运行依赖和文档索引。可复用的验证/评测/建模脚本、当前规范和精选 golden fixtures 保留在 Git；训练数据、运行报告、用户设计参考、Blender 源文件与检查点、渲染预览和生成导出物仅保留在本地。系统契约以 `docs/specs/` 中的 current spec 为准。

Vehicle-SLU 当前状态：默认本地模型为 `cockpit-slu-v11-round4:latest`，dev80 意图 95.0%、误执行 0，已知问题与资格边界见 5.1；训练与资格过程记录保存在本地开发文档 `../lab/history/verification/`，不随公开快照发布。

## 运行入口

- 本地 Agent/HMI 的启动入口为 `scripts/services/start-nio-with-gptsovits.sh`；已有常驻服务的
  定向管理入口为 `scripts/services/restart-local-services.sh agent|tts|all`。端点与运行条件见
  第 9 节；服务控制授权不在本手册重复规定。
- 从仓库根目录运行 `npm start`，等价于执行
  `scripts/services/start-nio-with-gptsovits.sh`。运行前按需从 `.env.example` 配置模型 provider，
  并通过进程环境提供密钥；不得把密钥写入仓库。
- 验证、评测与车模构建脚本是可复用源文件并保留在仓库；大型训练数据、评测输出、Blender
  源场景/检查点、渲染预览和生成模型由 `.gitignore` 隔离，不属于应用运行前置条件。

## 1. 项目定位

本项目建设可迁移到真实车辆环境的车载智能助手。浏览器页面是 HMI、调试台和集成验证壳，不是最终产品边界。

生产目标：

- 用户通过语音或文本自然交流，系统区分车控、导航、补能、座舱、开放问答和安全拒绝。
- 车端本地模型优先承担低延迟语义解析、车控意图识别和安全前置判断；云端只增强复杂推理、知识检索和跨工具规划。
- 所有车辆动作必须通过 `Safety Gateway` 和 `Vehicle Service Adapter`，模型不得直接控制执行器。
- HMI 展示可审计链路：输入、解析、Agent 协作、模型 I/O、工具调用、耗时、安全结论和最终回复。

当前仍是本地开发环境，未接真实车辆总线、真实车辆账号、真实地图/POI/路况、真实云端模型。固定模板、规则回退、示例数据和 `dev-adapter` 只能用于开发验证，不得描述为生产能力或真实执行结果。

生产不可接受项：编造实时事实；用固定答案冒充开放问答；把开发替身说成车辆回执；把工程 overlay 说成原车部件；让任何模型、检索或联网搜索绕过安全网关。

## 2. 产品体验与 HMI

首屏是车载助手工作台：顶部车辆状态，左侧 Agent Matrix，中央 Vehicle Digital Twin，右侧 Runtime Log，底部语音/文本输入与播报控制；详情页展示 Agent 流程、LLM I/O、工具参数、阶段耗时与 telemetry。

视觉基准是“消费级车控 App + 可审计工程侧栏”。车辆主舞台优先，避免用密集网格和小字号 telemetry 压过主视觉。

交互约束：

- 车控请求产生结构化工具调用、Safety 决策和车辆组件反馈。
- 开放问答产生自然回复，必要时播报；缺少数据源时说明边界，不编造。
- Runtime Log 至少展示 requestId、输入摘要、Agent 状态、模型 provider/model/duration/degraded/reason、Safety 结果、工具执行结果和外部数据边界。
- 对话型手册问答使用 `result.manualEvidence` 驱动“用户手册问答证据”卡；车控安全路径使用 `safetyDecision.manualEvidence*` 驱动“手册安全证据”卡，两者不得混称。
- 顶部“网络”必须来自真实 NetworkStatus provider；当前未接入真实网络 provider 时显示 `开发环境 · 网络未知`，不得写成“5G 在线”。模型/规则/LLM 路由状态使用独立“模型链路”字段展示，不得复用网络状态。

## 3. Runtime 架构

Runtime 的系统边界、主链路、模块职责、共享契约所有权和不可绕过原则统一见
[Runtime Architecture Specification](docs/specs/runtime-architecture.md)。当前浏览器 composition
root 组合 `RuntimeKernel`、`RoutePolicy`、共享 Provider/Safety/Coordinator 和四条 use case。
每个普通 turn 先产生一个经验证的 `nio-vehicle-slu-contract@2.0.0` envelope，RoutePolicy
再为每个 Run 选择且只选择 chat、vehicle-knowledge、vehicle-control 或 task；
clarify/respond/cancel 是 terminal。天气是 direct `task`，不进入 Orchestrator；只有复杂 task 使用
Cabin 前台沟通与基于 structured frame authority 的 Orchestrator 后台协调。
确认续接 turn（同一 ConfirmationChallenge 的第二次运行）是唯一不调用 Vehicle-SLU 的显式例外：
它复用 vehicle-control 私有 challenge 绑定，并必须重新读取 Provider、重新运行 Safety。
当前本地开发部署中，`RuntimeKernel`、Safety、Provider 与 Tools 运行在浏览器页面进程内；
这只是部署位置，presentation 代码仍不得决定 Safety、Provider 或执行。

Run Event Protocol 由 `src/runtime/run-event-protocol.js` 拥有，Run Event Ledger 只保留当前
Run 与前一个已完成 Run。Presentation 只投影事件与 RuntimeResult，不授权或重写 Runtime、
Safety、Tool、Provider 的结论。车辆写始终遵守 Safety-before-write 与 Provider confirmation；
Simulation Scenario Console 只改变模拟传感器输入，不能直接编辑 Safety 或 Provider snapshot。

AI Agent 仅指 `Cabin Assistant` 与复杂任务 `Orchestrator` 两个 LLM 信息处理角色。
车辆知识是中性的 application use case：Manual RAG 负责检索，Cabin 负责回答，只有复杂任务
才由 Orchestrator 规划。Safety、Manual RAG、VehicleState Provider、Vehicle Tools 与 Adapter
仍分别是确定性裁决、证据、事实或执行组件。旧 B3 独立 Vehicle Knowledge Agent 不再代表
当前运行时身份，现行边界以 [Runtime Architecture Specification](docs/specs/runtime-architecture.md)
为准。
Safety、VehicleState 与 ConfirmationChallenge 的现行规则见
[Safety and Vehicle State Specification](docs/specs/safety-and-vehicle-state.md)；车辆写执行见
[Vehicle Execution Specification](docs/specs/vehicle-execution.md)。

## 5. 当前能力快照

### 5.1 本地模型与语义

- 所有启动入口（`npm start`、`scripts/services/restart-local-services.sh`、macOS 启动器）的默认
  Vehicle-SLU Profile 均为本地 `local-compact-v10`（Ollama，non-thinking，无 fallback），模型为
  `cockpit-slu-v11-round4:latest`（独立数据第四轮 LoRA，融合后转为 GGUF Q8_0；Ollama 输出格式为普通 JSON，
  不加 JSON-schema 语法约束，结构由 compact 展开器严格校验）。2026-10-06 dev80 实测：意图 95.0%，
  未请求执行与目标错配均为 0；dev80 对这些训练类别已经不再是盲测，最终资格还需要一套新的未见盲测集。
  已知问题：用户没有说明位置时，v11 会默认主驾（例如「把座椅靠背调到112度」被直接执行为主驾，
  「打开车窗」被追问时预填为左前），`verify-local-semantic-api` 因此保持失败，作为回归检查，
  留待后续训练修复。v10-1006 已备份到 `~/Desktop/待备份_旧模型/`；DashScope 云端 Vehicle-SLU 只能通过显式
  `NIO_VEHICLE_SLU_PROFILE=cloud-dashscope` opt-in，仍为单请求，未获云端授权时云端请求上限默认为 `0`。Orchestrator、Cabin 与 RAG rerank
  仍沿用 legacy task profile，尚未按后续迁移队列逐项切换；已接入不等于通过生产资格。
- 规划摘要 renderer 不得维护 window/seat 这类 intent 白名单。模板 eligibility 的权威来源是 `planning-renderer-contract.js` 的 `nio-planning-template-renderer@1.0.0`。`NIO_LLM_PLANNING_SUMMARY_MODE=template` 启用时，模板快路径必须按 ToolResult contract 判定：仅接受 `task=planning`、`toolResult.ok=true`、非空 `hmiSummary`、Safety 未拒绝/未要求确认、无外部数据需求、非 external-data source、非 `blocked/none` visualScenario 的结果；其他情况必须走 LLM 或边界解释。当前固定服务默认 `NIO_LLM_PLANNING_SUMMARY_MODE=llm`，因此模板分支不会在默认运行态启用。
- 本地服务为 `local-agent-server.mjs`，固定入口 `http://127.0.0.1:4173/`。除显式设置 `NIO_ALLOW_PORT_FALLBACK=true` 外，不允许自动漂移端口。
- 默认保持模型预热和 `NIO_OLLAMA_KEEP_ALIVE=24h`；模型、prompt style、timeout 均应由环境变量配置。
- telemetry 必须记录 provider、model、总耗时、Ollama 原生阶段耗时、prompt/eval counts、预热/缓存/降级状态和失败原因。
- 生产语义路由的唯一权威是每轮一次返回的经验证 Vehicle-SLU envelope；每个普通 turn 只发一次
  模型请求，不做 schema repair 或跨 Provider fallback；不存在关键词/正则 fast path、第二分类器或
  模型失败后的语义规则恢复。route policy、vehicle-control、vehicle-knowledge 与天气地点/时间都不得
  从原始文本或正则恢复语义。
- 语义超时、不可用、JSON 或 contract 无效时终态返回 `respond`、设置 `executionDisabled=true`，
  且不消费 RAG、不形成 evidence，也不调用 Safety、Tool、Adapter、Provider 或外部服务。与 RoutePolicy
  并行启动的私有、只读、可取消 manual prefetch 只在 `vehicle-knowledge / direct` 路由下可被采用，
  其他情况一律丢弃，永远不成为 evidence、公开结果或写权限。
- 只有 contract 中经 schema 验证的 capability、mode 和 canonical slot 可以进入后续门禁；缺失执行
  required slot 时定向澄清，不得从原文、历史规则、RAG 或服务端回填执行默认。
- 导航、补能、媒体和电话当前只保留结构化识别，没有注册生产 owner，不得执行。当前注册路径为
  general chat、vehicle knowledge/state 只读、weather 只读以及 7 个车辆写 intent（`VEHICLE_CONTROL_INTENTS`）：
  `body.window.setPosition`、`body.tailgate.open`、`seat.driver.setBackrestAngle`、`seat.comfort.setLevel`、
  `cabin.comfort.applySettings`、`vehicle.component.setState`、`cabin.climate.setPreset`。
- 模型决策只使用 evidence-based qualification，不回退到关键词或正则路由。当前主路径仍是
  本地开发交付，尚未取得完整生产资格证据，因此不得声明 production readiness。
- 车辆写入执行、ToolCall `commandId`、Adapter 幂等、执行状态、传感器 observation 与 Provider 确认闭环的权威规则见 [Vehicle Execution Specification](docs/specs/vehicle-execution.md)。
- Tools 继续控制车窗、座椅、尾门和空调；Adapter acceptance 只进入 HMI pending，最终动画必须由 VehicleState Provider 的后续 snapshot 确认。
- VehicleState Provider 是状态读取唯一事实源；`requestedState`、开发 `statePatch`、Adapter acceptance、sensor reading 和动画都不能绕过 Provider ingestion 直接成为车辆状态。
- 全部车控 intent 统一经过 `VehicleExecutionCoordinator`：`submitted → duplicate-command|accepted|failed|timeout`，`accepted → executing`，`executing → observed-succeeded|failed|timeout`。Demo Sensor Simulator 只产生模拟 reading，Provider ingestion 后的 snapshot 才是事实。
- Demo 环境/Safety 状态只能通过 `ingestDemoSensorState()` 写入；命令组件确认只能通过 `ingestObservation()` 写入。`getSnapshot()` 保持只读，字段时效由 `capturedAtByField` 独立记录。
- HMI 在执行中显示 pending；仅匹配当前 commandId 和 `confirmedSnapshotId` 的 Provider snapshot 可以更新动画。迟到、重复、失败和缺失结果不得覆盖新 pending 或上次 confirmed 状态。
- 可执行命令的逐参数 provenance 必须可审计；其是否满足 Safety 信任边界及当前实现缺口以 [Safety and Vehicle State Specification](docs/specs/safety-and-vehicle-state.md) 为准。
- 本地 SLU 小模型（`cockpit-slu-*`）的融合与导入由 `scripts/services/slu-fuse-and-deploy.sh` 承担：
  `LoRA adapter → mlx_lm fuse → Modelfile → ollama create -q q4_K_M`。训练工程（权重、adapter、
  数据集）不在本仓库内，脚本按 `SLU_TRAIN_ROOT` → 向上查找 `adapters/` + `config/` →
  `~/Desktop/vehicle-slu-finetune` 三级定位，因此同一份脚本在训练工程内也能直接运行。
  `Modelfile` 是由训练工程根的 `Modelfile.template` 生成的**产物、不入库**；模板以
  `FROM __FUSED__` 占位，从机制上避免 `FROM` 与实际融合目录漂移。模型 tag ↔ 评测结果 ↔
  权重来源的清单见训练工程 `MODELS.md`。compact prompt 通道由 `NIO_VEHICLE_SLU_PROFILE`
  环境开关驱动，所有启动入口默认启用 `local-compact-v10`；需要云端语义解析时必须显式设置
  `NIO_VEHICLE_SLU_PROFILE=cloud-dashscope`。

### 5.2 P0-2 用户手册 RAG

P0-2 闭环及四项生产加固已完成：

- `ES8用户手册.pdf` 已提取 480 页、411 个 chunk。
- 运行时 embedding 默认模型是 `bge-m3`；现有索引为 411 条真实向量、1024 维。缺模型或构建失败不得写入伪向量。
- `POST /api/manual-rag` 优先使用 `vector-bge-m3`，失败时以明确 telemetry 回退关键词检索；结果缓存不改变引用和安全裁决。Manual RAG 的 lexical/keyword fallback 仅用于 retrieval，不得承担语义路由、scope 分类或车辆写授权。API 必须透传 `vehicleModel`、`corpusId`、`profileMode` 和 `allowDevelopmentAssumedCorpus`（支持顶层或 `filters`），服务态 strict/production 无车型请求必须 `not-applicable` 且不得加载 ES8 index；显式选择未接入 artifact 的 placeholder corpus 必须返回 `corpus-artifact-unavailable`。
- keyword fallback 不得维护固定领域 `KEY_TERMS` 白名单。当前 fallback 在进程内从 411 个手册 chunk 构建 `manual-corpus-lexical-index@0.2.0`：section/category/tags/text 统计 document frequency，metadata 术语作为 manual anchor，高频泛词降级，并带版本化 `manual-corpus-lexical-synonym-overlay@0.1.0`。同义 overlay 只在 canonical term 存在于当前 corpus lexical index 时启用，例如香薰→香氛、遮阳板→遮阳帘、V2L/外放电→车外放电；候选仍必须命中手册标题/标签/分类锚点后才可进入 eligibility，不能只靠正文碎片 n-gram 形成 evidence。
- 明确手册问题和具有咨询语气的操作/安全/故障/保养自然问题进入只读 Manual RAG；“打开尾门”“把车窗打开一半”等明确执行命令仍走车控链路。
- 是否进入只读 Manual RAG 以及检索 query 只由 Vehicle-SLU knowledge 帧决定：RoutePolicy 消费 `knowledgeNeed=manual` 帧，检索 query 取帧的 `standaloneQuery`/`slots.query`。原规则版 ManualQueryPlan（topic anchor、goal cue、domain/goal/entity routing）无生产调用方，已于 2026-10-04 删除，不得恢复为检索触发依据。
- 被 HMI 浏览器直接 import 的模块不得静态导入 `node:*` 或 Node-only retriever；需要语料派生数据时，应使用浏览器安全 artifact、运行时注入或通过 `/api/*` 访问服务端能力。
- `adaptiveK` 当前限定为 1–8，并根据执行/解释、故障、安全、保养、复合请求和实体复杂度选择；计划、query、filters 和实际 topK 必须进入 Runtime event、Manual telemetry 与 HMI 审计。
- 命中回答注入真实 evidence 并附页码；未命中或服务不可用时只给能力边界，不用模型知识补写手册步骤。
- 手册回答统一经过 `nio-manual-claim-grounding@1.4.0`：按可核验 claim 逐条绑定单个支持它的 evidence 句、chunkId 与 citation。确定性事实抽取必须来自 `nio-manual-deterministic-fact-extraction@1.0.0`，词法候选评分必须来自 `nio-manual-lexical-candidate-scoring@1.0.0`，结构化回答 claim 输出必须来自 `nio-manual-answer-claims@1.0.0`；运行分支不得另写部件、单位、条件、否定、泛词、2–4 gram、coverage/shared 阈值、score 权重或 answerClaims 形状。当前词法候选排序优先使用部件、数字单位、条件和 2–4 字词片段；数字与单位、否定极性、部件主体、条件/时态必须确定性一致，禁止把多个 evidence 各自提供的片段拼成一个无人能单独证明的 claim。无法证明的 claim 必须剔除。
- 全部 claim 不支持时，只能使用与问题存在词法关联的可追踪 evidence extract fallback；若问题与所有 evidence 零 lexical overlap，必须返回能力边界，`evidenceIds=[]`，不得选择第一条 evidence 或生成伪引用。最终页码引用只来自实际支持 retained claims 或 fallback 摘录的 evidence。`manualGrounding` 必须记录 policy/version、逐 claim 支持关系、拒绝原因、fallback 选择、最终 evidenceIds、`answerClaimsPolicy` 和 `answerClaims`。`answerClaims[]` 只允许表达已支持 claim 或 evidence extract fallback，并绑定 chunkId、citation、sentence 与 provenance；当前策略是保守事实校验和结构化审计，不得描述为完整语义蕴含模型。
- 手册屏幕回答由 `nio-manual-answer-composer@1.0.0` 消费 `answerClaims[]` 生成确定性自然文案。supported claims 使用“根据已接入手册...”式短说明；fallback evidence extracts 明确说明“不能确认原回答中的说法”，再给出相关手册摘录。Composer 不得直接读取原始 LLM 未验证句子、不得扩大 evidenceIds、不得新增手册事实；页码引用仍由 citation formatter 追加。TTS 不朗读 composer 引用附录，仍优先消费 Runtime 的 `assistantSpeechText`。
- 手册回答正文以自然语音为优先，默认 1–3 句、目标不超过 120 个汉字；fallback 摘录数量、最大允许摘录数、目标字数和最小字数必须来自 `MANUAL_CLAIM_GROUNDING_POLICY.speech`，不得在 fallback 函数内再写死第二份 3 条或 40/120 字边界。只回答与问题直接相关的证据，不要求复述全部命中。HMI 屏幕文本保留真实页码引用；Runtime 对手册问答可额外输出 `assistantSpeechText`，其生成必须来自版本化 `MANUAL_SPEECH_POLICY`（`nio-manual-speech-text@1.0.0`）：只包含已 grounding 的简短结论或能力边界，不含“手册依据”、页码、chunk、retrieval 等审计附录，供 TTS 优先播报。当前 `RuntimeKernel` 路径不得维护第二份本地手册语音截断 helper。
- 手册问答不创建 ToolCall，不触发 Vehicle Adapter；HMI 必须展示 retrieval mode、embedding 状态、query、页码和 evidence。
- 版本化黄金集覆盖操作、安全、故障、保养；质量评测必须真实调用接口，输出 Recall@K、引用命中率、引用完整性和逐例结果。
- 手册候选必须经过 `nio-manual-evidence-eligibility@1.1.0` 后才能成为 evidence。策略统一校验 retrieval score、query lexical/entity coverage、answerability、sourceId/title、车型适用性以及目录/封面/短文本噪声；vector、keyword、API、Runtime和Safety不得按“有候选”直接判hit。
- 手册 corpus identity、阈值、实体词表、answerability 词表和校准说明必须来自 `nio-manual-corpus-registry@1.1.0`。当前唯一可检索可信 corpus 仍严格绑定 `nio-es8-user-manual-2026 / 蔚来 ES8 用户手册`，其 calibration 为 `nio-es8-manual-evidence-eligibility-calibration@1.0.0`；`nio-et5-user-manual-placeholder` 仅用于 selector/cache/citation 隔离验证，`retrievalReady=false` 且没有 chunks/embeddings，不得返回 ES8 evidence。新增可检索 corpus 必须提供自己的 artifact、阈值来源、OOD/FPR/Recall 边界和黄金集，不能继承 ES8 阈值。
- 手册 source metadata 必须可移植，不得保存本机绝对路径。当前 `data/manual-rag/es8-manual-source.json` 的 `sourceFile` 为项目相对 `ES8用户手册.pdf`；构建脚本必须用 `PDF_PATH.relative_to(ROOT)` 写入该字段。
- 手册 artifact 路径、引用文案和未命中文案不得在 retriever、Runtime、server prompt 或评测脚本里散落手写 `ES8 用户手册` / `es8-manual-*.jsonl` 模板；当前默认 chunks/embeddings path、citation 和 miss summary 均由 `ManualCorpusRegistry` 的 corpus metadata 派生。显示引用与检索结果可以有不同格式，但必须来自同一 evidence/corpus metadata，不得伪造页码或把未知 corpus 默认格式化成 ES8。
- 手册检索必须先通过 `ManualCorpusRegistry` selector 解析 raw text / vehicleModel / corpusId。显式 ES8 可选择当前 ES8 corpus；显式 ET5 只能选择 `nio-et5-user-manual-placeholder` 并返回 `corpus-artifact-unavailable`，不得加载 ES8 chunks/vector index；显式 ES6、其他 ET/EC 等无已注册 corpus 的车型必须在 selector 阶段 `not-applicable/model-mismatch`，vector path 不得加载 ES8 embedding index，telemetry 必须输出 `manualCorpusSelection`。无车型仅可在 `local-dev` 中 `assumedCorpus=true` 使用默认 corpus；production/strict 不得默认套 ES8。
- 用户明确询问 ES6、未接入 ET/EC 等其他车型时必须 `not-applicable` 或 `corpus-artifact-unavailable`，不得套用 ES8；未指定车型仅可在 `local-dev` 中标记为 assumed corpus，不代表 VIN/实车匹配。production/strict 模式无车型不得默认套用 ES8，必须要求明确车型或由可信 VehicleContext/VIN 选择 corpus。
- eligibility telemetry 必须包含policy id/version、registry、corpus calibration、逐候选eligible/reasons/metrics、accepted/rejected count、miss reason与corpus applicability。全部不合格为miss；低可信证据不得注入对话prompt、引用或手册安全策略，固定Safety规则继续且不得放宽。

### 5.3 P0-3 手册驱动安全策略

- Safety 决策、VehicleStateSnapshot 信任与时效、Demo Sensor Provider、固定 baseline、手册安全约束和 ConfirmationChallenge 的权威规则见 [Safety and Vehicle State Specification](docs/specs/safety-and-vehicle-state.md)。
- 当前 VehicleState provider 仍是明确标记 `simulated=true` 的开发 fixture；目标规范要求未知、缺失、过期、未来或非法安全状态按 intent/field fail-safe，且不能由用户文字、模型、记忆或 confirmation response 补成传感器事实。当前实现不符合项与 verifier gap 以该 spec 的 Current status 为准，不得概括成已全部实现。

### 5.4 本地 TTS

- 前端默认 `gpt-sovits`，请求 `/api/tts`；服务端代理默认指向 `http://127.0.0.1:9880/tts`。
- 当前 Sandrone GPT-SoVITS 仅限本地非商业测试，权利状态未验证，不可用于生产、商用或公开演示，不得上传文本或音频到第三方。
- `.ua/tts-profiles.json` 是当前 TTS profile 与 synthesis 参数的权威配置，`tts-profile-loader.mjs` 是 4173 与启动脚本的共享 loader。4173 `/api/tts` 必须消费 `defaultProfile`、voice identity、license boundary 和 `synthesis.profileId`；请求/响应 telemetry 必须记录 profileId、configVersion、synthesisProfileId 与 licenseBoundary，禁止在运行模块或启动脚本中漂移出另一套默认合成参数。
- TTS profile 的 `refAudioPath` 应使用项目内相对路径或显式环境变量；loader 负责解析为 GPT-SoVITS 所需的绝对路径。不得把 `/Users/...` 这类本机绝对路径写入默认 profile。
- TTS 已具备独立 telemetry、请求取消、Stop/替换播报、浏览器 fallback 和“首块优先”。文本分块、`prefetchWindow`、默认语言、并发上限、短 opener 是否独立成块与估算语速必须来自版本化 `VOICE_PROVIDER_CAPABILITY_POLICY`（`nio-voice-provider-capability@1.1.0`）；当前 `gpt-sovits` 能力仍为 48 字符上限、单块 lookahead、单并发预取，且 `separateShortOpener=false`。首块开始播放时预合成下一块，当前块结束后直接播放已就绪音频；该 lookahead 可隐藏部分合成时间，但当下一块合成慢于当前块播放时仍会存在间隔。
- TTS 分块策略会把非开场短残片合并到下一块，并且对本地 GPT-SoVITS 默认把 1–8 字逗号开场白合并进首个请求，避免“你好，”这类短 opener 单独触发一次慢 TTS 请求并造成后续大间隔。当前实测显示并发 lookahead 对本地 GPT-SoVITS 组合不稳定，未作为默认能力。
- TTS 调用必须使用 `ResponseEnvelope` 分离屏幕显示文本与 `speechText`；引用、手册依据、数据来源等可以留在 HMI，但不得未经治理直接进入角色语音。若 RuntimeResult 提供 `assistantSpeechText`，HMI 必须优先使用它作为 `speechText`，并在 telemetry 中将 provenance 标为 `manual-runtime-speech-text`；该字段的 Runtime 生成策略由 `nio-manual-speech-text@1.0.0` 约束。否则再按通用 `nio-vehicle-speech-text@1.0.0` 从屏幕文本生成。
- 当前播报文本治理策略为 `nio-vehicle-speech-text@1.0.0`：去除 Markdown、引用附录、手册依据、数据来源和时间边界，默认选择前 1–2 个自然句，基础目标 72 字、硬上限 96 字；实际运行会通过 `getVehicleSpeechTextPolicy(provider)` 结合 provider capability 收紧语音目标。当前 `gpt-sovits` 目标优先贴合单个 provider chunk，首句过长时按自然边界截到目标长度，尽量避免 49–96 字单句被拆成两次慢 TTS 请求。屏幕显示文本不因此删减；TTS 调用必须随 `ResponseEnvelope` 携带实际用于生成 `speechText` 的 `speechTextPolicy`，telemetry 必须记录 `displayTextChars`、`speechTextChars`、`speechTextPolicy` 和 `speechTextProvenance`。
- Agent 运行详情必须展示当前运行的 TTS provider、状态、分块数、首块请求到响应头、首块请求到完整音频就绪、从发起播报到 `Audio.onplay`、最大分块间隔，并保留真实 `x-nio-tts-*` 响应头。没有播放事件时显示 `unavailable`，不得用 HTTP 或完整 Buffer 时间代替可听反馈时间。
- TTS telemetry 必须记录 provider capability、每段 request/ready/playStart/playEnd、上一段结束到下一段开始 gap、顶层 `chunkGapsMs/maxChunkGapMs`、首音与总完成时间。分块长度、预取窗口和并发上限必须来自 `VOICE_PROVIDER_CAPABILITY_POLICY`。
- 当前仍是完整首块 Buffer 后 `Audio.play()`，不是字节流 TTFA。性能口径为“用户提交到首次可听语音开始”，必须同时覆盖短句和长句，并分解 parser、RAG/Safety、LLM、TTS 和 browser play。
- MPS/non-half A/B 已完成但未采纳；当前继续使用 CPU、`is_half:false`。没有新的音质和稳定性证据不得切换默认设备。
- TTS 失败只影响语音，不得阻塞文本或改变 Runtime、Safety 和车辆执行结果。
- Agent-only 启动不得因可选 TTS profile 配置错误而失败；profile 损坏时 4173 仍应启动，`/api/tts` 失败由浏览器语音 fallback 承接。需要启动或调试 9880 时，才应把 profile 错误作为 TTS 服务启动 blocker。

### 5.5 实时数据与开放问答

- Open-Meteo 天气 adapter 提供独立 `POST /api/weather` 契约以及对话 Runtime 复用入口，返回当前天气、逐小时预报和未来 3 日预报。数据包含天气代码、温度/体感、湿度、降水、降水概率和风速，并保留 provider、source、查询/预报时间及地点解析 telemetry。
- 天气地点只来自 Vehicle-SLU `weather.query` frame 的 `location` slot；slot 缺失时按下述默认地点或澄清规则处理，不得从原始文本解析地点。时间窗口与回答侧重点由天气工具按原话组织，只影响回答，不影响路由或授权。
- 杭州、上海、北京、广州、深圳使用本地可信坐标；其他明确城市通过 Open-Meteo Geocoding API 解析。未提供地点时只能标记为“默认杭州（非实时定位）”；明确地点无法解析时必须报错，不得静默回退杭州。
- “这里/当前位置/我这边”和“目的地/终点”等位置指代必须来自可信 `WeatherLocationContext.current/destination`；缺少上下文时必须澄清且不得调用上游地理编码或天气 API，不能把指代词当城市名，也不能回退默认杭州伪装成实时定位或目的地天气。
- Open-Meteo Geocoding 返回多个同名或近似同名候选时，除非用户输入已包含可唯一匹配的省份、国家或等价行政限定，否则必须返回 `weather_location_ambiguous` 与候选项让上层澄清；不得把第一个候选当作事实地点。天气地点澄清响应必须携带 `weatherLocationClarification`，其 policy 为 `nio-weather-location-clarification@1.0.0`，包含 code、requestedName/reference、clarification 文案和候选项；`这里/目的地` 缺可信上下文时 candidates 为空且不得访问上游。
- Geocoding 候选窗口由 `nio-weather-geocoding-resolution` 策略声明，当前请求 `count=10`，避免常见地名超过前三个候选时漏掉用户已明确给出的行政限定；测试必须覆盖行政限定候选不在前三个时仍可唯一消歧。
- 天气响应采用混合策略：纯事实问题继续走 `weather-template` 快路径；建议、比较、规划和解释问题由 `Weather Fact Pack -> Weather Response Composer -> grounding` 生成自然短答。Fact Pack 只包含目标地点/日期及 Open-Meteo 的温度、体感、降水和风速字段，并显式列出缺失字段。
- Composer 只能使用 Fact Pack，输出不得包含不支持的数字、紫外线、空气质量、官方预警或车辆执行声明；超过长度、模型失败或 grounding 不通过时回退确定性天气摘要。穿衣/带伞/防风等启发式建议必须通过版本化 `WeatherAdvicePolicy` 声明 policyId、provenance、适用地区/人群/输入边界，并由 composer prompt、fallback 与 telemetry 共用；不得在 `formatWeatherSummary()` 等运行时函数里再维护第二份阈值。穿衣分档仅作为 fallback，不再是建议型天气问题的主回答路径。
- WeatherAdvicePolicy 当前只按“健康成人、未接入个人偏好/活动强度/特殊人群画像”的本地启发式工作；当用户显式询问老人、儿童、孕妇、疾病、高强度训练，或跑步、骑行、露营、徒步、散步等活动适宜性问题时，Fact Pack 必须输出 `adviceContext.requiresPersonalizationBoundary=true`，回答和 fallback 必须说明未接入个人健康、偏好或活动强度画像，不能给出确定的个体适宜性结论。
- Weather grounding 必须把数值、单位、日期词和字段词绑定到同一个 Fact Pack claim；例如降水概率的百分比不能改写为摄氏度，今天/明天的降水概率不能交换，最高温/最低温不能互相借值。Fact Pack 必须显式列出当前链路缺失的 UV、空气质量和官方预警字段；模型用数字或“防晒/AQI/空气优/无预警”等非数字话术提到这些缺失字段时必须回退。
- Weather composer 支持结构化输出 `{response, answerClaims}`；每个 `answerClaims[]` 必须绑定 `fieldPath/fieldValue/unit/dateTerm` 到 Fact Pack claim，校验失败时回退。纯文本回答会尽量从数字、单位、日期词和字段词派生 `answerClaims`，派生失败时才保留自然语言数字 grounding 兜底；telemetry 必须记录 `composerOutputFormat`、`grounding.answerClaimsStatus/source` 和 `answerClaims` 数量。
- 对“今天和明天哪个更适合出行”“周六和周日哪个更适合出行”“周末哪天更适合出行”这类两日比较，若回答明确推荐某一天，必须通过 `nio-weather-comparison-grounding@1.0.0` 的 FactPack 打分校验；推荐错天或依据不足时回退。周末比较必须把目标两天标成“周六/周日”，并让 fallback 摘要、FactPack claim dateTerms 与比较 grounding 使用同一标签；普通“周末天气怎么样”仍是 range，不得被升级成推荐比较。该策略当前只覆盖窄范围出行适宜性比较，不代表完整因果或个性化决策模型。
- 天气查询属于只读外部数据，不创建 ToolCall、不触发 Vehicle Adapter，也不进入动态回答缓存。Open-Meteo 来源、抓取时间、地点解析和 grounding 必须保留在 Runtime telemetry/Fact Pack；天气正文不应机械附加“数据来自/时间边界”，自然语音短答也不得朗读完整来源附录。
- 美食、餐厅、附近推荐和其他 POI 问题在真实地图、POI、定位、评分或营业状态接入前，只能由共享 `BoundaryResponseBuilder` 输出能力边界；server 和 cloud fallback 必须共用同一 builder。用户未提供品类或偏好时不得主动注入“麻辣烫/火锅/咖啡”等具体菜系、店型、汤底或口味建议，也不得编造店名、距离、排队、评分或地址。
- 未接真实 POI、路线、路况、补能排队、价格、用户账号或联网搜索时，必须说明数据边界。
- 车辆一般知识可使用 `vehicle-knowledge.js` 暴露的 `nio-vehicle-knowledge-seed-retrieval@1.0.0`，当前唯一 seed 是 `data/vehicle-knowledge/nio-es6-official.json` 对应的 NIO ES6 官方车型页资料。该 seed 只可用于 ES6 官方车型页一般介绍；用户明确询问 ET/EC/ES8 或其他品牌车型时必须返回 `not-applicable` 边界，不得套用 ES6 配置或事实。`/api/local-llm` 遇到显式非 ES6 车型必须走 deterministic `local-boundary`，`promptChars=0`，不得把 not-applicable 交给 LLM 自行遵守。具体操作、安全、故障、保养优先使用手册 RAG，真实车辆状态必须来自车辆服务。

## 6. 车模与车辆资产

当前主 HMI 只加载 `assets/models/nio-es7/nio-es7-animated.glb` 与对应
`nio-es7-component-manifest.json`。该资产是在 ItsDiyor 的 `Nio ES7 2023` CC BY 4.0
模型基础上形成的可署名衍生物，不是蔚来官方工程数据、量产数字孪生或真实车辆回执。完整来源、
许可和修改边界见 `vehicle-model-lab/THIRD_PARTY_NOTICES.md`。

当前 VehicleAssetProfile 为 `nio-es7-stage-c-components@1.0.0 / local-dev`，包含 52 个稳定
组件节点、25 条机械动作 clip、5 项灯光控制和主驾四轴连续调节。`productionApproved=false`，
公开发布与商业使用仍需独立完成资产审查；本地展示通过不等于生产资产获批。

ES7 运行时禁止 inline manifest fallback。manifest 缺失、非法、稳定节点不全或 25 条 clip
不完整时必须 fail-closed、停止模型加载并让 HMI 显示失败状态。旧 Ferrari 资产只作为历史开发
材料在本地保留并由 Git 忽略，不是公开交付或主页面加载候选，也不得恢复工程代理机械动作或 overlay 旁路。

HMI 动画只能由已注册 ToolPresentation 和 Provider confirmed snapshot 驱动。未知工具无论成功
或失败都必须 `no-animation`；pending、Adapter acceptance、requested state 或页面文本均不能直接
改变 ES7 姿态。座椅四座聚焦、相机和材质雾化只属于展示状态，不写入 VehicleState。

稳定约束：

- 公开仓库只交付冻结的 GLB、manifest、第三方署名和许可证；Blender 母版、检查点、预览与建模流水线保留在本地并由 Git 忽略。
- 动作目录、manifest 和 GLB clip 必须保持 25 条机械动作一一对应；缺失或多余动作均拒绝加载。
- 可动车窗、尾门、座椅、车门、把手、前舱盖、充电口、后视镜、雨刷、悬架和轮组必须使用稳定节点与原生 clip，不得回退为代理几何。
- `missingOriginalComponents` 必须为空，主 HMI 不提供手动展示控制、组件爆炸或工程 overlay 公共入口。
- 用户手动拖拽后应暂时保留人工视角，不立即强制相机回位。

ES7 A+B+C 车模与主页面聚焦效果已于 2026-08-28 通过用户视觉验收。Blender 在 Codex
沙盒可能因 GPU/Metal 初始化异常退出；受控非沙盒或用户普通终端可运行。清理异常管线时只
结束对应 Blender/npm 进程，不得误关 4173 或 GPT-SoVITS。

## 7. 安全、数据和授权硬约束

- 所有车辆写入动作执行前必须调用 Safety Gateway；Safety 决策不得被本地/云端 LLM、RAG 或搜索覆盖，Vehicle Adapter 结果必须来自车辆服务回执或明确失败原因。
- 高风险或不确定意图必须澄清或交由 Safety Gateway 裁决；驾驶中回复应简短并可中断。
- 缺少实时或权威数据时不编造天气、位置、店铺、距离、评分、营业、路况、排队、价格、车辆状态或法规。
- 本地手册、模型、参考音频和车辆资产必须保留来源、版本和授权边界；禁止把 license-unverified 资产用于生产或公开发布。

## 8. 技术规格索引

- [Runtime Architecture Specification](docs/specs/runtime-architecture.md)：Runtime 边界、调用顺序、模块职责、共享契约所有权和不可绕过架构原则。
- [Safety and Vehicle State Specification](docs/specs/safety-and-vehicle-state.md)：Status: current；Safety、VehicleState 和 ConfirmationChallenge 的权威规则与当前不符合项/verification gap。
- [Vehicle Execution Specification](docs/specs/vehicle-execution.md)：Status: current；车辆写执行、`commandId`、Adapter 幂等、执行状态、sensor observation、Provider confirmation 与 HMI pending→confirmed 边界的权威规则。
- UI 设计语言：[docs/guides/DESIGN.md](docs/guides/DESIGN.md)。
- 车辆组件建模：[docs/guides/VEHICLE_COMPONENT_MODELING.md](docs/guides/VEHICLE_COMPONENT_MODELING.md)。
- 历史计划、设计与审计索引：本地开发记录 `../lab/history/README.md`（仅历史记录，不随公开快照发布；`docs/specs/` 是唯一现行权威）。
尚未建立的 spec 只是迁移目标，不得当作已完成或当前权威文件。

## 9. 服务与 HMI 运行路径

- 本地端点：HMI / Agent Server 为 `http://127.0.0.1:4173/`，GPT-SoVITS 为
  `http://127.0.0.1:9880/docs`，Ollama 为 `http://127.0.0.1:11434`。
- Node 入口使用 ES module。页面出现旧内容时，先检查缓存与运行中的服务状态。
- `scripts/services/restart-local-services.sh` 和 `scripts/services/stop-local-services.sh` 的 `agent|tts|all`
  选择器分别对应 4173、9880 或两者；应只管理明确选择的服务，避免把 4173、9880 与
  11434 的运行状态捆绑处理。
- benchmark fault-injection 仅用于本地开发：`src/benchmark/benchmark-fault-profile.js` 是无副作用的纯模块，被 app.js 与 server 静态导入，但只有同时设置 `NIO_DEV_BENCHMARK_FAULTS=true` 与具体 fault profile 时才生效，否则 `resolveBenchmarkFaultProfile` 直接拒绝。
- HMI 运行详情使用稳定的 `data-testid="run-detail-card"`、`data-card-kind` 和只读
  `window.__runtimeDebug()`；业务 E2E 优先验证这些结构化接口，而非页面全文扫描。

## 10. 当前优先级

### 当前展示收敛主线

项目从工程原型进入可展示版本收敛阶段，按以下三条主线推进：

1. **响应速度**：缩短用户提交到首次有意义反馈、首段有效文本和首次可听语音的等待时间；分解并审计 Vehicle-SLU、RAG/Safety、回答生成、TTS 和浏览器播放阶段，不以伪进度或绕过安全链路换取速度。
2. **车模与动效基线（已完成）**：ES7 A+B+C、25 条机械动作、主驾四轴和四座聚焦已通过用户视觉验收；后续变化继续遵守 Provider snapshot 确认后才播放完成动画的真实性边界。
3. **演示稳定性（当前焦点）**：固定可重复的演示场景、服务与模型预检及首屏可操作状态；明确区分成功能力、安全边界与尚未接入能力，避免现场依赖不稳定或未授权服务。

三条主线共享现有 Runtime、Safety、VehicleState、Tool Presentation 和 telemetry 契约，不以展示优化为由引入第二套业务事实或执行旁路。

P0：

- 保持开放问答分流、P0-2 手册闭环和 P0-3 两项安全策略的回归稳定。
- 继续降低“用户提交到首次可听语音开始”的端到端延迟；短句、长句必须共享同一基线，任何优化不得绕过 Safety Gateway。
- 继续统一动画链路，保证按钮、文本和语音车控都遵守 [Vehicle Execution Specification](docs/specs/vehicle-execution.md) 的 HMI pending→sensor-confirmed 边界。
- 扩大语义、手册检索和 grounding 评测覆盖，重点修复已暴露的故障类召回缺口。

P1：

- 将 `vehicle-tools.js` 替换为可插拔真实 Vehicle Service Adapter。
- 增加 Safety Gateway 单元测试与车控工具集成测试。
- 接入真实 POI/路线/补能或云端检索 adapter，并完整展示来源与时间。

P2：

- 完成当前 ES7 衍生资产的公开发布/商业使用审查，或替换为获正式生产批准的目标车型资产。
- 接入真实云端/私有云模型及用户记忆。
- 评估真正的音频字节流播放；只有协议、音质和稳定性证据充分时才调整默认 TTS 后端。

## 11. 验收标准

基础：页面可打开、车模可旋转缩放、文本输入可用、Agent Matrix/Runtime Log/详情页更新，主要 JS/MJS 通过 `node --check`。

问答与手册：

- 天气、餐饮、车辆知识、闲聊不互相混淆；无数据源时给边界。
- 天气语义验收使用经验证的 Vehicle-SLU `weather.query` readonly frame；旧
  `conversationGoal.domain`、`resolveConversationRoute()` 和 `slots.topic` 不再拥有生产语义路由权。
- 天气 API 的当前与 3 日预报字段完整；明确城市解析失败不得回退默认地点；无地点默认杭州必须展示“非实时定位”；明天/后天问题不得只返回当前天气。
- “适合穿什么衣服”等建议型天气问题必须针对目标日期回答建议，普通事实查询不得无故附加穿衣模板；来源和时间边界至少在 Runtime telemetry/Fact Pack 中可审计。
- 无地点的开放天气问题必须保留“默认杭州（非实时定位）”边界；模型遗漏时 grounding 拒绝。比较/范围问题 fallback 必须覆盖全部目标日期，不得只返回其中一天或硬编码比较结论。“今晚”必须使用逐小时数据窗口，缺 hourly 时说明逐小时预报不可用，不得拿今日整天 forecast 顶替。周末、下周一等超出三日的目标必须由 WeatherQueryPlan 扩展 `forecast_days` 并按目标日期匹配 forecast。
- 手册命中展示真实页码和 evidence，未命中不编造；自然咨询进入只读问答，明确车控命令不误路由。
- HMI 对话 evidence 卡与安全 evidence 卡各用正确数据源和标题。
- grounding 能剔除 evidence 不支持的声明；黄金集评测输出 Recall@K、引用命中率、完整性和分类结果。
- Manual eligibility正负/OOD质量门同时报告precision、classification recall、expected-chunk Recall@K、FPR、nDCG、citation correctness和miss reason accuracy；不得只用正例召回证明可用。明确其他车型与非手册问题必须miss。
- 开放问答与手册问答不触发 Vehicle Adapter。

车控与安全：

- 车窗、尾门、座椅、空调等所有写入均经过 Safety Gateway；开发结果标记 `dev-adapter`。
- Safety、VehicleState 与 ConfirmationChallenge 的专项验收及当前不符合项/verification gap 以 [Safety and Vehicle State Specification](docs/specs/safety-and-vehicle-state.md) 为准。
- HMI 从 ToolCall submitted 开始进入 pending，accepted/executing 继续保持 pending；仅匹配的后续 VehicleState Provider snapshot 可驱动 sensor-confirmed 最终动画，详见 [Vehicle Execution Specification](docs/specs/vehicle-execution.md)。
- 模糊“开点窗/座椅调一下/空调舒服一点”必须澄清且不调用 Vehicle Adapter；明确
  “主驾车窗一半/主驾座椅112度/空调22度”才保留车辆写候选，并能追溯每个工具参数来源；
  导航、补能、媒体和电话请求均返回当前能力边界。
- “尾门坏了/车窗异响/尾门已经打开了/车窗开着/不要打开尾门/我没有让你打开尾门/可以打开车窗吗/如果打开尾门会怎样/打开尾门需要什么条件/明天再说”等非执行 frame 不得生成 ToolCall；明确尾门写命令只能按 Vehicle-SLU contract → capability/slot → Safety → Tool/Adapter → Provider 链路执行。
- 语义验收必须冻结并完整运行 120 条 Vehicle-SLU acceptance corpus，覆盖一般对话、车辆知识、完整/缺槽车控、只读与延后 capability、non-execution 和复合输入；同时通过 no-keyword routing gate，不得以 browser/server 规则一致性代替模型契约、Runtime 零旁路和零 false write 验收。
- 演示合格线（2026-10-04 用户确定，选项 5A：继续训练本地模型直至达标）：本地 Vehicle-SLU 误执行必须为 0（未请求的车辆/服务执行意图与车辆目标错配均为 0），意图准确率 ≥ 90%。该评测在 spec 讨论与代码重构完成后，于新冻结的未见评测集上执行一次；开发集 dev80 的成绩只用于选择 checkpoint，不能作为合格证明。

TTS：

- benchmark 同时覆盖短句和长句并分解全链路耗时；不得把 HTTP 首响应称为真实 TTFA。
- 运行详情的 TTS 指标必须绑定到产生该回答的 run；新运行开始时停止旧播报并解除旧 run 的 telemetry 绑定，避免跨运行串写。
- Stop 和新播报能取消旧请求且不播放旧音频；真实失败才回退浏览器语音。
- 文本和安全/车控链路不被 TTS 阻塞；当前行为明确标注为“完整首块后播放”，不是字节流。

生产迁移：真实动作有真实服务回执，实时事实有真实来源，模型与工具可追踪，安全拒绝可解释，开发替身不作为生产通过项。

## 2026-10-03 当前独立优化检查点

1400试验及独立dev已正常终态，handle22115已消费exit0；意图71/80、闭环17/20、mixed0/4、车辆目标错配3、未请求服务意图1、非ok2，P50/P951265/1718ms，不合格。裸Qwen3-8B对照31实际派发/30完成/1超时，后49不派发，30契约非法；其格式探针4/4可省略k/c，但训练语义探针0/6契约通过，追加提示仅1/6且文案限制过窄，明确不采用。上述旧running状态仅历史。

下一小步：按训练来源结构计数（1361总行、344多帧、social+execute10、knowledge+execute29）独立创作48条共存来源。作者只读现行contract/compact-v9/ontology/catalog，不读既有表达、dev、保留评测、标注、模型输出或本手册历史指标；32社交+独立肯定动作、16知识+独立肯定动作，支持取消/否定干扰但严格分子句。保持模型唯一语义权威。输出train-only草稿原话+compact与来源说明，主代理源审核、当前契约验证、保留话语只查重后才可准入，非人类金标；本步不训练、不服务控制、不提交。

## 2026-10-03 多轮上下文来源边界

共存1420训练正常终态，周期检查点前提错误导致原核验器失败；最终权重按终态日志与224有限张量独立核验，原失败保存。恢复dev80/80已完成：意图68/80、闭环16/20、mixed0/4、未请求车辆3/服务1、车辆目标错配2、非ok1、P50/P95/max1339/2032/2168ms，综合失败，不晋级。当前无模型任务。

下一来源小步仅依据现行契约和训练结构计数：普通priorContext18，无多帧priorContext训练。独立作者按当前合同创作24组两轮对话，首轮多项明确请求，后轮独立修正/选择性撤回/知识或当前查询/社交切换，来源表达与目标不得从dev或模型结果取得。主代理按真实RoutePolicy及projectVehicleSluConversationContext派生上轮验证语义；来源仍agent draft。作者禁止读现有训练原话/dev/保留评测/标注/任何模型结果。源语义审核、契约、多轮上下文及只查重隔离后才可准入；不启动训练。另一个只读开发标签复核代理只读独立dev源及契约，不读模型输出、不改标签、不接触训练作者。

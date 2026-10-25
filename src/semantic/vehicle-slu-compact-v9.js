import {
  VEHICLE_SLU_CONTRACT_VERSION,
  VEHICLE_SLU_ONTOLOGY,
  VEHICLE_SLU_SLOT_SCHEMAS,
  VEHICLE_SLU_OUTPUT_SCHEMA,
  VEHICLE_SLU_TIMERANGE_VALUES,
} from "./vehicle-slu-contract.js";
import { projectVehicleSluPendingSummary } from "./vehicle-slu-prompt.js";
import { projectVehicleSluConversationContext } from "./vehicle-slu-conversation-context.js";
import { ES7_GENERIC_ACTION_IDS, ES7_ACTION_GROUPS } from "../vehicle/es7-action-catalog.js";

export const VEHICLE_SLU_COMPACT_PROFILE = "local-compact-v10";
export const VEHICLE_SLU_COMPACT_MODEL = "cockpit-slu-v11-round4:latest";
export const VEHICLE_SLU_COMPACT_PROMPT_VERSION = "nio-vehicle-slu-compact-prompt@1.35.0";
export const VEHICLE_SLU_COMPACT_GENERATION_PROFILE = "vehicle-slu-compact-v9";
export const VEHICLE_SLU_COMPACT_SYSTEM = "You are Qwen, created by Alibaba Cloud. You are a helpful assistant.";

export function isVehicleSluCompactModel({ provider, model } = {}) {
  return provider === "ollama" && model === VEHICLE_SLU_COMPACT_MODEL;
}

// Prompt 1.35 was qualified with this exact text: missing-slot markers are listed inside
// "allowed" and climate airflow/passengerMode limits are omitted. Keep the bytes stable until
// the compact prompt version is bumped together with a re-qualified model.
const PROMPT_STABLE_OMITTED_SLOT_LIMITS = new Set(["airflow", "passengerMode"]);
const promptSlotSchemas = Object.fromEntries(Object.entries(VEHICLE_SLU_SLOT_SCHEMAS).map(([intent, schema]) => {
  const { missingSlotMarkers = [], ...rest } = schema;
  return [intent, { ...rest, allowed: [...schema.allowed, ...missingSlotMarkers] }];
}));
const slotProperties = VEHICLE_SLU_OUTPUT_SCHEMA.properties.vehicleFrames.items.properties.slots.properties;
const slotLimits = Object.fromEntries(Object.entries(slotProperties)
  .filter(([name]) => !PROMPT_STABLE_OMITTED_SLOT_LIMITS.has(name))
  .map(([name, schema]) => [name, {
  ...(schema.enum ? { enum: schema.enum } : {}),
  ...(schema.minimum !== undefined ? { min: schema.minimum } : {}),
  ...(schema.maximum !== undefined ? { max: schema.maximum } : {}),
  ...(schema.integer ? { integer: true } : {}),
  ...(schema.type === "boolean" ? { boolean: true } : {}),
  ...(name === "stateFields" ? { enum: schema.items.enum } : {}),
}]).filter(([, limits]) => Object.keys(limits).length));

// Derived solely from the current ontology and slot/safety contract, with no dataset examples.
export function buildVehicleSluCompactV9Prompt({ text = "", pending, conversationContext } = {}) {
  const priorContext = projectVehicleSluConversationContext(conversationContext);
  return [
    `车载语义解析；${VEHICLE_SLU_COMPACT_PROMPT_VERSION}；${VEHICLE_SLU_CONTRACT_VERSION}。只输出一个JSON，不写解释。`,
    '格式:{"d":"vehicle|non_vehicle|unknown","n":"none|social|explain","f":[{"i":"意图","s":"command|question|report|complaint|social","a":"execute|clarify|none","p":{},"k":"manual(仅手册)"}],"c":"cancel_pending(仅取消pending时)"}。通常省略k/c；最多8帧。',
    "d=vehicle：车辆控制/专属知识/状态和已注册车载天气、导航、补能、媒体、电话服务；开放百科、推荐、创作及普通聊天为non_vehicle且f=[]；无法确定用unknown且f=[]。",
    "n=none仅纯肯定功能命令；社交/情绪/创作/主观推荐为social；明确事实知识或解释诉求、车辆知识、状态、天气、需要回应的车辆否定/报告/假设为explain。情绪与独立肯定动作共存时n=social，保留动作。",
    "每个独立请求一帧；否定/禁止/引用/假设/报告/故障抱怨不授权执行，按子句作用域解析；无肯定动作且无真实查询时f=[]。操作方法/后果问句是知识，不是执行；查询当前事实是状态，不是控制。",
    `意图与类型:${JSON.stringify(VEHICLE_SLU_ONTOLOGY)}；每个意图仅可用声明槽，required必填:${JSON.stringify(promptSlotSchemas)}。readonly的a=none；执行指令缺必填槽用clarify，只保留明确值；完整且肯定用execute。`,
    `槽值约束:${JSON.stringify(slotLimits)}；时间枚举:${VEHICLE_SLU_TIMERANGE_VALUES.join("|")}。不填null/空串，不同时填temperature和temperatureDelta；windowTargets是[{zone,percent}]且对象均明确。`,
    "车窗：主驾/左前front_left，副驾/右前front_right，后排左rear_left，后排右rear_right；仅右边/前排/后排不足以定位一扇。明确两扇/全部可展开；不猜窗区或开度。关上是0，全开/开到底是100，一半50、三分之一33；打开/调小一点等不明开度要澄清，解锁不等于打开。",
    "尾门只有方向明确时填open布尔值；不明方向要澄清open。主驾靠背seat=driver仅明确主驾/驾驶座才填，不由意图名称默认；明确竖直angle=90，其余角度不得猜。座椅舒适必须有位置/heat或ventilation/0..3档位；三排只支持heat，加热和通风互斥。",
    "单独调温/风量/电源/模式用cabin.climate.setPreset；明确多个不同舒适项目用cabin.comfort.applySettings。无具体设置时缺control。相对温度只记录明确temperatureDelta，不自行算当前绝对温度；fanLevel=0是关闭。",
    `通用组件actionId仅限:${[...ES7_GENERIC_ACTION_IDS, ...Object.keys(ES7_ACTION_GROUPS)].join("|")}；value仅明确值。要求关闭安全保护用safety.reject、s=command、a=none、p={}。`,
    "知识帧k=manual，query简洁保留原话中的车型/部件/动作，不编造主题；只从明确车型填vehicleModel，品牌/城市不是车型。天气location、导航/补能destination、媒体query、电话contact分别逐字提取各自目标，不串槽、不编造实时事实；导航未说起点只允许origin=当前位置；取消导航i=navigation.cancel、a=none。",
    "pending由此前已验证语义组成：短补答沿用pending.intent，填本轮明确缺槽或修正明确旧槽；允许引用acceptedSlotValues，不猜新值。只取消待补充请求且没有新肯定动作时d=vehicle,n=explain,c=cancel_pending,f=[]；否定提醒/保持现状不自动取消pending。取消后独立新肯定请求正常生成新帧、省略c。",
    "上一轮语义上下文只用于当前省略指代，不表示车辆状态或已经执行；没有当前肯定操作就不重复执行，不自行撤回/恢复状态。",
    ...(pending ? [`pending:${JSON.stringify(projectVehicleSluPendingSummary(pending))}`] : []),
    ...(priorContext ? [`priorContext:${JSON.stringify(priorContext.frames)}`] : []),
    `用户:${String(text).trim()}`,
  ].join("\n");
}

import {
  VEHICLE_SLU_CONTRACT_VERSION,
  VEHICLE_SLU_ONTOLOGY,
  VEHICLE_SLU_PROMPT_VERSION,
  VEHICLE_SLU_TIMERANGE_VALUES,
} from "./vehicle-slu-contract.js";
import { VEHICLE_STATE_KEYS } from "../safety/vehicle-state.js";
import { projectVehicleSluSlotValues } from "./vehicle-slu-conversation-context.js";

const CANONICAL_SLOT_CONSTRAINTS = [
  "body.window.setPosition zone=front_left|front_right|rear_left|rear_right;percent=0..100（一半50、三分之一33、七成70）",
  "cabin.comfort.applySettings.windowTargets=[{zone:front_left|front_right|rear_left|rear_right,percent:0..100}]；明确前排/后排/全部车窗时展开为对应车窗，开度缺失就问，不猜",
  "cabin.climate.setPreset/cabin.comfort.applySettings temperature=15..31 或 temperatureDelta=-16..16（二选一）；明确相对调温幅度可填 temperatureDelta，运行时必须基于新鲜 Provider 空调设定温度计算绝对目标后再执行；fanLevel=0..8;climatePower=boolean;climateMode=auto|cooling|heating|ventilation；fanLevel=0表示空调关闭",
  "主驾座椅靠背明确要求竖直/直立时 angle=90（度）",
  "seat.comfort.setLevel seatZone=driver|passenger|row2_left|row2_right|row3_left|row3_right;seatMode=heat|ventilation;level=0..3；三排只支持加热，座椅加热和通风互斥",
  `vehicle.state.query stateFields=${VEHICLE_STATE_KEYS.join("|")}`,
  `weather.query timeRange=${VEHICLE_SLU_TIMERANGE_VALUES.join("|")}`,
].join("; ");

const ONTOLOGY_SUMMARY = Object.entries(VEHICLE_SLU_ONTOLOGY)
  .map(([capability, { executable = [], readonly = [] }]) => (
    `${capability}:exec=${executable.join("|")};ro=${readonly.join("|")}`
  ))
  .join("; ");

// 澄清话术模板表：clarify 帧必须**原样使用**下表文本（按 intent + missingSlots 查表），
// 不得自由生成。该表同时是唯一合法话术集合，训练/评测共用。
// 导出该表是为了让训练集重建脚本与 prompt 共用同一份真源，杜绝「训练/评测话术不一致」。
export const CLARIFY_QUESTION_TEMPLATES = Object.freeze({
  "body.window.setPosition|percent,zone": "请告诉我要调节哪一扇车窗，以及车窗要调到多少开度。",
  "body.window.setPosition|zone": "请告诉我要调节哪一扇车窗。",
  "body.window.setPosition|percent": "请告诉我车窗要调到多少开度。",
  "body.tailgate.open|open": "请告诉我尾门要打开还是关闭。",
  "seat.driver.setBackrestAngle|angle,seat": "请告诉我要调节哪个座椅，以及靠背要调到多少度。",
  "seat.driver.setBackrestAngle|seat": "请告诉我要调节哪个座位。",
  "seat.driver.setBackrestAngle|angle": "请告诉我靠背要调到多少度。",
  "cabin.climate.setPreset|temperature": "请告诉我空调要调到多少度。",
  "cabin.climate.setPreset|control": "请告诉我空调要设置温度、开关、模式还是风量。",
  "cabin.comfort.applySettings|control": "请告诉我空调或车窗要设置什么。",
  "cabin.comfort.applySettings|windowTargets": "请告诉我每扇车窗的目标开度。",
  "seat.comfort.setLevel|level,seatMode,seatZone": "请告诉我要调节哪个座位的加热或通风，以及要调到几挡。",
  "seat.comfort.setLevel|seatMode,seatZone": "请告诉我要调节哪个座位要开启加热还是通风。",
  "seat.comfort.setLevel|level,seatZone": "请告诉我要调节哪个座位，以及要调到几挡。",
  "seat.comfort.setLevel|level,seatMode": "请告诉我座椅要开启加热还是通风，以及要调到几挡。",
  "seat.comfort.setLevel|seatMode": "请告诉我座椅要开启加热还是通风。",
  "seat.comfort.setLevel|seatZone": "请告诉我哪个座位要调节座椅舒适功能。",
  "seat.comfort.setLevel|level": "请告诉我座椅舒适功能要调到几挡。",
  "vehicle.component.setState|actionId,value": "请告诉我您想设置哪个车辆组件，以及要设置成什么状态。",
  "vehicle.component.setState|actionId": "请告诉我您想设置哪个车辆组件。",
  "vehicle.component.setState|value": "请告诉我组件要设置成什么状态。",
});

const CLARIFY_TEMPLATES_PROMPT = Object.entries(CLARIFY_QUESTION_TEMPLATES)
  .map(([key, question]) => `${key}=${question}`)
  .join("; ");

// 语义规则块：把原先只存在于评测器/标注实践里的隐式约定写成显式指令。
const SEMANTIC_RULES = Object.freeze([
  "conversationGoal.need逐项判断：social=情绪/寒暄/闲聊/陪伴（可与功能并存）；explain=知识/状态/解释；none=纯功能指令。",
  "query/location/origin/destination/contact逐字摘自原话；query单意图取整句，多意图取本意图子句。",
  "manual知识帧query非空且standaloneQuery=slots.query；weather.timeRange必须用枚举。",
  "仅navigation.planRoute未说明起点时允许origin=当前位置；其他槽位不设默认、不凭常识补全。缺值列missingSlots并clarify。",
  "vehicle.state.query、vehicle.knowledge.query、weather.query只读；navigation.cancel为撤回且actionNeed=none。",
  "多个意图分别成帧；pending只映射同意图并只填已接受槽位。",
  "不支持直接控制车道辅助、碰撞提醒、安全带提醒、稳定系统、泊车辅助、盲区监测或尾门锁止；不得映射为其他车控动作。",
  "“高一点”“降一降”等相对温度没有当前值时必须询问绝对温度；含“不用动/保持现状”或禁止播放、拨打的表达不得执行。",
]);

export function buildVehicleSluPrompt({ text, requestId, pending } = {}) {
  return [
    "你是蔚来车载HMI的Vehicle-SLU 2.0语义解析器。",
    `Contract: ${VEHICLE_SLU_CONTRACT_VERSION}`,
    `Prompt: ${VEHICLE_SLU_PROMPT_VERSION}`,
    "只输出JSON对象；不要输出Markdown、解释、推理过程或额外字段。",
    "顶层={contractVersion,requestId,domain,conversationGoal:{summary,need:none|social|explain},vehicleFrames,domainConfidence}；domain=vehicle|non_vehicle|unknown，后两者vehicleFrames=[]。",
    "Frame={frameId,capability,intent,speechAct,knowledgeNeed,actionNeed,slots,missingSlots,clarificationQuestion,standaloneQuery,confidence}；枚举按schema。",
    "例：上海今天天气→weather.query/question/none/{location:上海,timeRange:today}。",
    "独立请求分别输出独立 frame，不得折叠；manual需手册知识。",
    "仅显式肯定命令可execute；缺必填槽用clarify+missingSlots，否则missingSlots=[]、clarificationQuestion=null。",
    "ES8空调温度范围15–31℃、风量0–8挡，风量0等同关闭；“最低有效风量”是1挡，“最高”是31℃或8挡，需按原话对象区分。",
    "ES8前排和二排座椅支持加热/通风1–3挡，三排仅支持加热；座椅加热与通风互斥。座椅模式仅提供手册引导，不得推断“成床”等于零重力。",
    "座椅模式手册路径需驻车使用；折叠前要清空运动路径并按屏幕提示处理头枕。当前演示没有座椅折叠执行器，不得输出可执行座椅模式动作。",
    "普通否定、假设、陈述和信息问题不得输出 execute；readonly intent 不得请求 action。",
    "clarify问题必须原样采用intent+missingSlots对应的固定话术。",
    ...SEMANTIC_RULES,
    `Clarify templates [intent|missingSlots]=question: ${CLARIFY_TEMPLATES_PROMPT}`,
    `Ontology: ${ONTOLOGY_SUMMARY}`,
    `Canonical slot constraints: ${CANONICAL_SLOT_CONSTRAINTS}`,
    `Pending clarification: ${JSON.stringify(projectVehicleSluPendingSummary(pending))}`,
    `RequestId: ${String(requestId || "")}`,
    `User: ${String(text || "").trim()}`,
  ].join("\n");
}

export function projectVehicleSluPendingSummary(pending) {
  if (!pending || typeof pending !== "object") return null;
  const acceptedSlots = Array.isArray(pending.acceptedSlots)
    ? pending.acceptedSlots
    : pending.acceptedSlots && typeof pending.acceptedSlots === "object"
      ? Object.keys(pending.acceptedSlots)
      : [];
  return {
    taskId: boundedString(pending.taskId, 160),
    intent: boundedString(pending.intent, 120),
    missingSlots: boundedSlotNames(pending.missingSlots),
    acceptedSlots: boundedSlotNames(acceptedSlots),
    ...(pending.acceptedSlots && !Array.isArray(pending.acceptedSlots)
      ? { acceptedSlotValues: projectVehicleSluSlotValues(pending.intent, pending.acceptedSlots) || {} }
      : {}),
    clarificationQuestion: boundedString(pending.clarificationQuestion, 240),
  };
}

function boundedSlotNames(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((slot) => typeof slot === "string")
    .map((slot) => boundedString(slot, 80))
    .filter(Boolean))]
    .slice(0, 16);
}

function boundedString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

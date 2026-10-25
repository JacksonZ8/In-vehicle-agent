import {
  VEHICLE_SLU_CONTRACT_VERSION, VEHICLE_SLU_ONTOLOGY,
  VEHICLE_SLU_SLOT_SCHEMAS, VEHICLE_SLU_TIMERANGE_VALUES,
  createVehicleSluEnvelope, getMissingVehicleSluRequiredSlots,
} from './vehicle-slu-contract.js';
import { CLARIFY_QUESTION_TEMPLATES, projectVehicleSluPendingSummary } from './vehicle-slu-prompt.js';
import { ES7_GENERIC_ACTION_IDS, ES7_ACTION_GROUPS } from '../vehicle/es7-action-catalog.js';

export const VEHICLE_SLU_COMPACT_VERSION = 'nio-vehicle-slu-compact@1.0.0';
const CAPABILITY = Object.fromEntries(Object.entries(VEHICLE_SLU_ONTOLOGY).flatMap(([cap, types]) =>
  [...(types.executable ?? []), ...(types.readonly ?? [])].map(intent => [intent, cap])));
// Ollama output format for the compact model: plain JSON mode, not a JSON-schema grammar. The
// schema grammar distorted the v11 model's slot keys (dev80 intent 87.5% with it, 95% without);
// structure and values are enforced by expandVehicleSluCompact, which fails closed.
export const VEHICLE_SLU_COMPACT_OUTPUT_FORMAT = 'json';

function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => ![...required, ...optional].includes(k))) {
    throw new TypeError('Invalid compact object keys');
  }
}

// Metadata and presentation are deterministic. No text-based slot recovery or action repair.
export function expandVehicleSluCompact(value, {requestId, text = ''} = {}) {
  exactObject(value, ['d', 'n', 'f'], ['c']);
  if (Object.hasOwn(value, 'c') && value.c !== 'cancel_pending') throw new TypeError('Invalid compact dialogue action');
  if (!Array.isArray(value.f) || value.f.length > 8) throw new TypeError('Invalid compact frames');
  const vehicleFrames = value.f.map((frame, index) => {
    exactObject(frame, ['i', 's', 'a', 'p'], ['k']);
    if (Object.hasOwn(frame, 'k') && frame.k !== 'manual') throw new TypeError('Invalid compact knowledge need');
    const missing = getMissingVehicleSluRequiredSlots(frame.i, frame.p);
    if (frame.a === 'execute' && missing.length) throw new TypeError('Execution requires explicit required slots');
    const missingSlots = frame.a === 'clarify' ? missing : [];
    const templateKey = `${frame.i}|${[...missingSlots].sort().join(',')}`;
    const clarificationQuestion = frame.a === 'clarify' ? CLARIFY_QUESTION_TEMPLATES[templateKey] : null;
    if (frame.a === 'clarify' && !clarificationQuestion) throw new TypeError('Invalid compact clarification');
    return {
      frameId: `f${index + 1}`, capability: CAPABILITY[frame.i], intent: frame.i,
      speechAct: frame.s, knowledgeNeed: frame.k ?? 'none', actionNeed: frame.a,
      slots: frame.p, missingSlots, clarificationQuestion,
      standaloneQuery: frame.k === 'manual' ? frame.p?.query : null,
      confidence: 0, // Uncalibrated: this protocol does not ask the model to invent confidence.
    };
  });
  return createVehicleSluEnvelope({
    contractVersion: VEHICLE_SLU_CONTRACT_VERSION, requestId,
    domain: value.d, conversationGoal: {summary: String(text).slice(0, 240), need: value.n,
      ...(value.c ? {dialogueAction: value.c} : {})},
    vehicleFrames, domainConfidence: 0,
  });
}

export function compactVehicleSluEnvelope(envelope) {
  createVehicleSluEnvelope(envelope);
  return {d: envelope.domain, n: envelope.conversationGoal.need,
    ...(envelope.conversationGoal.dialogueAction ? {c: envelope.conversationGoal.dialogueAction} : {}),
    f: envelope.vehicleFrames.map(f => ({
    i: f.intent, s: f.speechAct, a: f.actionNeed, p: f.slots,
    ...(f.knowledgeNeed === 'manual' ? {k: 'manual'} : {}),
  }))};
}

export function buildVehicleSluCompactPrompt({text = '', pending} = {}) {
  return [
    `你是车载语义解析器。协议 ${VEHICLE_SLU_COMPACT_VERSION}，只输出JSON。`,
    '格式 {d:vehicle|non_vehicle|unknown,n:none|social|explain,f:[{i:意图,s:command|question|report|complaint|social,a:execute|clarify|none,p:槽位对象,k?:manual}]}。',
    'non_vehicle/unknown的f为空。寒暄情绪、闲聊创作为social；信息/解释请求为explain；纯功能指令（含否定撤回）为none。情绪寒暄与指令共存n=social，动作独立。',
    '只有明确肯定命令可execute；否定/撤回/引用/假设/报告不执行。查询状态和问使用方法不可变成控制。s按实际话语行为选择。',
    '缺必填槽时clarify，p只保留已明确槽位。不猜前后左右、角度、温度、车型、目的地。右边/后排不足以定位一扇窗；调小一点不是0。开/关对应100/0，半开50、三分之一33。',
    '每项独立请求一帧；数值、方位归各自对象，禁止串槽、漏帧或添加原话没有的动作。取消导航i=navigation.cancel,a=none。',
    '知识使用方法i=vehicle.knowledge.query,k=manual；当前数值i=vehicle.state.query,p.stateFields。除手册知识外不输出k。',
    '自由文本槽位逐字摘取，不改写；query取本意图所在子句去首尾空白及句末标点。车型未说不填。导航未说起点时唯一允许默认origin=当前位置。',
    `意图槽位（required必填）:${JSON.stringify(VEHICLE_SLU_SLOT_SCHEMAS)}`,
    `timeRange:${VEHICLE_SLU_TIMERANGE_VALUES.join('|')}。车窗zone=front_left|front_right|rear_left|rear_right，驾驶座seat=driver。`,
    `组件actionId仅限:${[...ES7_GENERIC_ACTION_IDS,...Object.keys(ES7_ACTION_GROUPS)].join('|')}。危险受保护操作i=safety.reject,a=none,p={}。`,
    ...(pending ? [`待澄清:${JSON.stringify(projectVehicleSluPendingSummary(pending))}`] : []),
    `用户:${String(text).trim()}`,
  ].join('\n');
}

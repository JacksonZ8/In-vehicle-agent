import { TASK_PROGRESS_STAGES } from "../runtime/run-event-protocol.js";

const PROGRESS_COPY = Object.freeze({
  accepted: "已收到目标，正在确定处理路径",
  planning: "正在拆解需要协同的步骤",
  executing: "正在执行已通过校验的步骤",
  waiting: "正在等待外部能力返回",
  finalizing: "执行事实已汇总，正在生成回复",
});
const PROGRESS_STAGE_SET = new Set(TASK_PROGRESS_STAGES);
const ACTIVE_STATUSES = new Set(["queued", "running", "waiting"]);

export function presentProgress(snapshot, event = null) {
  if (!isRecord(snapshot)) return null;

  const taskId = requiredText(snapshot.taskId);
  const runId = requiredText(snapshot.runId);
  const status = requiredText(snapshot.status);
  const currentStage = requiredText(snapshot.currentStage);
  if (!taskId || !runId || !ACTIVE_STATUSES.has(status) || !PROGRESS_STAGE_SET.has(currentStage)) {
    return null;
  }

  if (event !== null) {
    if (!isRecord(event) || requiredText(event.runId) !== runId) return null;
  }

  return PROGRESS_COPY[currentStage];
}

function requiredText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

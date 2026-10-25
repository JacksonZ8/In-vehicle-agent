import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [index, app, styles] = await Promise.all([
  readFile(new URL("../../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../src/app/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../src/app/styles.css", import.meta.url), "utf8"),
]);

assert.match(index, /id="runFeedback" class="run-feedback" role="status" aria-live="polite" aria-atomic="true"/);
assert.match(app, /function beginRunFeedback\(\)/);
assert.match(app, /function bindRunFeedbackRequest\(event\)/);
assert.match(app, /currentRequestId && currentRequestId !== event\.runId/);
assert.match(app, /function updateRunFeedbackFromRuntimeEvent\(event\)/);
assert.match(app, /语义解析完成，正在确定处理路径/);
assert.match(app, /正在组织回复/);
assert.match(app, /回复已生成，正在准备语音/);
assert.match(app, /正在播报/);
assert.match(app, /播报已暂停/);
assert.match(app, /function updateRunFeedbackFromVoiceStatus\(status, token = state\.voiceOutput\.feedbackToken\)/);
assert.match(app, /if \(token !== state\.runFeedback\.token\) return/);
assert.match(app, /function applyRuntimeResult\(result, turnContext\)/);
assert.match(app, /!state\.currentRun\?\.requestId/);
assert.match(app, /state\.currentRun\.requestId !== result\.requestId/);
assert.match(app, /state\.consumedRuntimeRequestIds\.has\(result\.requestId\)/);
assert.match(app, /function renderAssistantText\(text, runId\)/);
assert.match(app, /els\.assistantText\.dataset\.runId = ownerRunId/);
assert.match(app, /renderAssistantText\("正在生成回复", requestId\)/);
assert.match(app, /renderAssistantText\(response, opts\.runId\)/);
assert.match(app, /setRunFeedback\("本次处理未完成，请重试", feedbackToken\)/);
assert.match(styles, /\.assistant-response \.run-feedback/);
const feedbackSource = app.slice(app.indexOf("function beginRunFeedback()"), app.indexOf("function isCurrentRuntimeInteraction("));
assert.doesNotMatch(feedbackSource, /预计.*(?:秒|分钟)|ETA|token进度|真实首音|车辆执行进度|工具执行进度/iu);

console.log(JSON.stringify({
  runFeedbackDomAndAria: true,
  requestIsolationGuards: true,
  runtimeAndVoiceStages: true,
  noFalseProgressClaims: true,
}, null, 2));

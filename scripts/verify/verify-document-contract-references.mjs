import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const authorityDocuments = [
  "PROJECT_GUIDE.md",
  "docs/guides/DESIGN.md",
  "docs/audits/HARD_CODE_AUDIT.md",
  "docs/specs/runtime-architecture.md",
  "docs/specs/safety-and-vehicle-state.md",
  "docs/specs/vehicle-execution.md",
];
const currentContractDocuments = new Set([
  "PROJECT_GUIDE.md",
  "docs/guides/DESIGN.md",
  "docs/specs/runtime-architecture.md",
  "docs/specs/safety-and-vehicle-state.md",
  "docs/specs/vehicle-execution.md",
]);
const documentContractMarkers = Object.freeze({
  "docs/specs/runtime-architecture.md": Object.freeze({
    required: Object.freeze([
      "`nio-vehicle-slu-contract@2.0.0`",
      "每个普通用户 turn 恰好一次 Vehicle-SLU 本地语义请求",
      "`Cabin Assistant` 始终拥有前台沟通",
      "不得重新解释原始用户文本",
      "`contract → capability/slot → Safety → Tool/Adapter → Provider`",
      "RAG 只能提供检索证据，不能授予语义 scope 或车辆写权限",
      "`executionDisabled=true`",
      "零 RAG、Safety、Tool、Adapter、Provider 或外部服务调用",
      "`navigation`（含 `energy.findSwapStation`）、`media` 与 `phone`",
      "本地 Vehicle-SLU 请求数与云端模型请求数必须分开计数",
      "在线验收 harness 不得启动、停止或重启服务",
      "未获云端授权时请求上限默认为 `0`",
    ]),
    forbidden: Object.freeze([
      "`clarify` 与 `cancel` 是终态",
    ]),
  }),
  "PROJECT_GUIDE.md": Object.freeze({
    required: Object.freeze([
      "`nio-vehicle-slu-contract@2.0.0`",
      "120 条 Vehicle-SLU acceptance corpus",
      "no-keyword routing gate",
      "Manual RAG 的 lexical/keyword fallback 仅用于 retrieval",
      "不得承担语义路由",
      "导航、补能、媒体和电话当前只保留结构化识别",
    ]),
    forbidden: Object.freeze([
      "共享语义策略当前为 `nio-semantic-policy@1.0.0`",
      "规则只可直接完成保守高精度路径",
      "服务端只可从同一原始文本的高置信规则结果回填",
      "SemanticPolicy 黄金集至少覆盖",
      "规则结构化结果必须深度一致",
      "导航去西湖”等保留执行能力",
      "明确“打开尾门/关闭尾门”等命令仍进入 Manual RAG 与 Safety Gateway 全链路",
      "再把 `navigation.planRoute` / `energy.findSwapStation` 调度到 ExternalDataAdapter",
    ]),
  }),
});

const missing = [];

for (const relativeDocument of authorityDocuments) {
  const documentPath = path.join(root, relativeDocument);
  const source = fs.readFileSync(documentPath, "utf8");

  if (currentContractDocuments.has(relativeDocument)) {
    for (const match of source.matchAll(/`(scripts\/[^`\s]+\.(?:mjs|sh))(?:\s+[^`]*)?`/g)) {
      if (!fs.existsSync(path.join(root, match[1]))) {
        missing.push(`${relativeDocument}: missing script ${match[1]}`);
      }
    }

    for (const deletedSource of ["agent-runtime.js", "b2-agent-coordinator.js"]) {
      if (source.includes(`\`${deletedSource}\``)) {
        missing.push(`${relativeDocument}: deleted source ${deletedSource}`);
      }
    }

    const markerContract = documentContractMarkers[relativeDocument];
    if (markerContract) {
      for (const marker of markerContract.required) {
        if (!source.includes(marker)) {
          missing.push(`${relativeDocument}: missing required marker ${marker}`);
        }
      }
      for (const marker of markerContract.forbidden) {
        if (source.includes(marker)) {
          missing.push(`${relativeDocument}: forbidden current marker ${marker}`);
        }
      }
    }
  }

  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/g)) {
    const target = match[1];
    if (/^[a-z]+:\/\//i.test(target)) continue;
    const resolved = path.resolve(path.dirname(documentPath), target);
    if (!fs.existsSync(resolved)) {
      missing.push(`${relativeDocument}: missing Markdown target ${target}`);
    }
  }
}

assert.deepEqual(missing, [], `Authority document references are stale:\n${missing.join("\n")}`);

console.log(JSON.stringify({
  authorityDocuments: authorityDocuments.length,
  scriptReferences: "valid",
  deletedSourceReferences: "absent",
  markdownTargets: "valid",
}, null, 2));

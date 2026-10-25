import assert from "node:assert/strict";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { createRouteDecision } from "../../src/application/route-policy.js";
import { prepareManualRetrievalCandidate } from "../../src/manual/manual-retrieval-candidate.js";
import { parseCommandWithSemanticPolicy } from "../lib/semantic-policy.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function knowledgeRoute(rawText, requestId) {
  const parsedCommand = parseCommandWithSemanticPolicy(rawText, { requestId });
  return {
    decision: createRouteDecision({
      disposition: "execute",
      routeId: "vehicle-knowledge",
      mode: "direct",
      confidence: 1,
      reasonCode: "trusted-vehicle-knowledge",
      semanticSource: "deterministic",
      normalizedIntentRef: { requestId, intent: parsedCommand.intent },
      runId: requestId,
    }),
    parsedCommand,
    semanticTelemetry: Object.freeze({ source: "deterministic" }),
  };
}

function terminalRoute(rawText, requestId) {
  const parsedCommand = parseCommandWithSemanticPolicy(rawText, { requestId });
  return {
    decision: createRouteDecision({
      disposition: "respond",
      routeId: null,
      mode: null,
      confidence: 1,
      reasonCode: "conversation-direct",
      semanticSource: "deterministic",
      normalizedIntentRef: { requestId, intent: parsedCommand.intent },
      runId: requestId,
    }),
    parsedCommand,
    semanticTelemetry: Object.freeze({ source: "deterministic" }),
    assistantResponse: "普通对话回答。",
  };
}

function createRuntime({ routePolicy, vehicleKnowledgeUseCase, prepareCandidate }) {
  let now = Date.parse("2026-08-12T00:00:00.000Z");
  return new RuntimeKernel({
    routePolicy,
    useCases: Object.freeze({
      "vehicle-knowledge": vehicleKnowledgeUseCase || Object.freeze({
        async execute() { throw new Error("unexpected knowledge execution"); },
      }),
    }),
    runEventLedger: new RunEventLedger(),
    sessionMemory: new SessionMemory({ now: () => now }),
    now: () => ++now,
    prepareManualRetrievalCandidate: prepareCandidate,
  });
}

{
  const routeGate = deferred();
  const retrievalGate = deferred();
  const markers = [];
  const query = "ES8 打开尾门前需要确认什么条件？";
  const requestId = "run:parallel-knowledge";
  const runtime = createRuntime({
    routePolicy: Object.freeze({
      resolve(rawText, options) {
        markers.push("route-started");
        return routeGate.promise.then(() => knowledgeRoute(rawText, options.requestId));
      },
    }),
    prepareCandidate(input) {
      markers.push("candidate-prepared");
      return prepareManualRetrievalCandidate({
        ...input,
        monotonicNow: (() => {
          const ticks = [100, 5100];
          return () => ticks.shift();
        })(),
        retrieve() {
          markers.push("retrieval-started");
          return retrievalGate.promise;
        },
      });
    },
    vehicleKnowledgeUseCase: Object.freeze({
      async execute(context) {
        markers.push("knowledge-use-case-started");
        assert.ok(context.manualRetrievalCandidate, "selected knowledge route must receive candidate");
        const consumed = await context.manualRetrievalCandidate.consume({
          runId: context.runId,
          query: context.rawText,
          vehicleModel: "ES8",
        });
        markers.push("candidate-consumed");
        return Object.freeze({
          assistantResponse: "已基于手册回答。",
          manualEvidence: Object.freeze({
            status: consumed.result.metadata.status,
            evidenceRefs: Object.freeze([]),
          }),
          modelCalls: Object.freeze([]),
          degraded: false,
          outcomeStatus: "answered",
        });
      },
    }),
  });

  const pending = runtime.run(query, { requestId });
  await Promise.resolve();
  assert.deepEqual(markers, ["route-started", "candidate-prepared", "retrieval-started"],
    "Route and Manual retrieval must both start before either resolves");
  routeGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(markers.includes("knowledge-use-case-started"), true);
  assert.equal(markers.includes("candidate-consumed"), false);
  const privateResult = Object.freeze(Object.assign([], {
    metadata: Object.freeze({ status: "hit", runId: requestId }),
  }));
  retrievalGate.resolve(privateResult);
  const result = await pending;
  assert.equal(result.manualEvidence.status, "hit");
  assert.equal(JSON.stringify(result).includes("candidate-prepared"), false);
  assert.deepEqual(markers, [
    "route-started", "candidate-prepared", "retrieval-started",
    "knowledge-use-case-started", "candidate-consumed",
  ]);
}

{
  let discardCount = 0;
  const runtime = createRuntime({
    routePolicy: Object.freeze({
      resolve(rawText, options) {
        return terminalRoute(rawText, options.requestId);
      },
    }),
    prepareCandidate() {
      return Object.freeze({
        async consume() { throw new Error("terminal route must not consume candidate"); },
        discard() {
          discardCount += 1;
          return discardCount === 1;
        },
      });
    },
  });
  const result = await runtime.run("请用简单的话解释什么是多智能体协作。", {
    requestId: "run:parallel-discard",
  });
  assert.equal(discardCount, 1, "terminal route must discard candidate exactly once in cleanup");
  assert.equal(result.assistantResponse, "普通对话回答。");
  assert.equal(JSON.stringify(result).includes("manualRetrievalCandidate"), false);
}

{
  let unhandled = null;
  const onUnhandled = (error) => { unhandled = error; };
  process.once("unhandledRejection", onUnhandled);
  const runtime = createRuntime({
    routePolicy: Object.freeze({
      resolve(rawText, options) {
        return terminalRoute(rawText, options.requestId);
      },
    }),
    async prepareCandidate() {
      throw new Error("PRIVATE_ASYNC_PREPARATION_FAILURE");
    },
  });
  await runtime.run("普通对话", { requestId: "run:async-preparation-failure" });
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(unhandled, null, "invalid async candidate preparation must be observed privately");
}

console.log("Runtime parallel Manual RAG verification passed");

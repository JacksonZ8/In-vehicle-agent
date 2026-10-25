import assert from "node:assert/strict";
import {
  MANUAL_RETRIEVAL_CANDIDATE_MISMATCH,
  normalizeManualCandidateQuery,
  prepareManualRetrievalCandidate,
} from "../../src/manual/manual-retrieval-candidate.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

assert.equal(normalizeManualCandidateQuery("  ES8   尾门\n条件  "), "ES8 尾门 条件");

{
  const gate = deferred();
  const calls = [];
  const ticks = [10, 42];
  const candidate = prepareManualRetrievalCandidate({
    runId: "run:hit",
    query: " ES8 尾门条件 ",
    vehicleModel: "ES8",
    monotonicNow: () => ticks.shift(),
    retrieve(query, options) {
      calls.push({ query, options });
      return gate.promise;
    },
  });
  assert.equal(calls.length, 1, "preparation must synchronously start one retrieval");
  assert.equal(calls[0].query, "ES8 尾门条件");
  assert.equal(calls[0].options.runId, "run:hit");
  assert.equal(calls[0].options.vehicleModel, "ES8");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(Object.isFrozen(candidate), true);

  const evidence = Object.freeze(Object.assign([], {
    metadata: Object.freeze({ status: "hit", runId: "run:hit" }),
  }));
  gate.resolve(evidence);
  const consumed = await candidate.consume({
    runId: "run:hit",
    query: "ES8   尾门条件",
    vehicleModel: "ES8",
  });
  assert.equal(consumed.result, evidence, "trusted evidence identity must be preserved");
  assert.equal(consumed.durationMs, 32);
  assert.equal(Object.isFrozen(consumed), true);
  await assert.rejects(
    candidate.consume({ runId: "run:hit", query: "ES8 尾门条件", vehicleModel: "ES8" }),
    (error) => error?.code === "manual-retrieval-candidate-consumed",
  );
  assert.equal(candidate.discard("run-finalized"), false, "consumed discard is an idempotent no-op");
}

{
  const candidate = prepareManualRetrievalCandidate({
    runId: "run:mismatch",
    query: "ES8 尾门条件",
    retrieve: async () => Object.freeze([]),
  });
  await assert.rejects(
    candidate.consume({ runId: "run:other", query: "ES8 尾门条件", vehicleModel: "ES8" }),
    (error) => error?.code === MANUAL_RETRIEVAL_CANDIDATE_MISMATCH,
  );
  await assert.rejects(
    candidate.consume({ runId: "run:mismatch", query: "ES8 车窗条件", vehicleModel: "ES8" }),
    (error) => error?.code === MANUAL_RETRIEVAL_CANDIDATE_MISMATCH,
  );
  await assert.rejects(
    candidate.consume({ runId: "run:mismatch", query: "ES8 尾门条件", vehicleModel: "ET9" }),
    (error) => error?.code === MANUAL_RETRIEVAL_CANDIDATE_MISMATCH,
  );
  assert.equal(candidate.discard("route-mismatch"), true);
  assert.equal(candidate.discard("route-mismatch-again"), false);
}

{
  const gate = deferred();
  let privateSignal;
  let unhandled = null;
  const onUnhandled = (error) => { unhandled = error; };
  process.once("unhandledRejection", onUnhandled);
  const candidate = prepareManualRetrievalCandidate({
    runId: "run:discard",
    query: "ES8 尾门条件",
    retrieve(_query, options) {
      privateSignal = options.signal;
      return gate.promise;
    },
  });
  assert.equal(candidate.discard("non-knowledge-route"), true);
  assert.equal(privateSignal.aborted, true);
  gate.reject(new Error("PRIVATE_LATE_RETRIEVAL_FAILURE"));
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(unhandled, null, "discarded rejection must be observed privately");
  await assert.rejects(
    candidate.consume({ runId: "run:discard", query: "ES8 尾门条件", vehicleModel: "ES8" }),
    (error) => error?.code === "manual-retrieval-candidate-discarded",
  );
}

{
  const caller = new AbortController();
  const gate = deferred();
  const candidate = prepareManualRetrievalCandidate({
    runId: "run:cancel",
    query: "ES8 尾门条件",
    signal: caller.signal,
    retrieve: () => gate.promise,
  });
  const callerReason = new Error("caller-cancelled");
  caller.abort(callerReason);
  gate.resolve(Object.freeze([]));
  await assert.rejects(
    candidate.consume({ runId: "run:cancel", query: "ES8 尾门条件", vehicleModel: "ES8" }),
    (error) => error?.name === "AbortError" && error?.reason === callerReason,
    "caller cancellation must beat a late retrieval success",
  );
}

{
  let consumed = 0;
  const candidate = prepareManualRetrievalCandidate({
    runId: "run:validate-before-commit",
    query: "ES8 尾门条件",
    retrieve: async () => Object.freeze([]),
    validateResult() {
      throw new TypeError("candidate-result-invalid");
    },
    onConsume() { consumed += 1; },
  });
  await assert.rejects(
    candidate.consume({
      runId: "run:validate-before-commit",
      query: "ES8 尾门条件",
      vehicleModel: "ES8",
    }),
    /candidate-result-invalid/,
  );
  assert.equal(consumed, 0, "private transitions must not commit before result validation");
}

console.log("manual retrieval candidate verification passed");

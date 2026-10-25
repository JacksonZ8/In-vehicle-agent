import assert from "node:assert/strict";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");

async function assertServerReachable() {
  try {
    const response = await fetch(`${baseUrl}/`, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    if (response.ok || response.status === 404 || response.status === 405) return;
    const fallback = await fetch(`${baseUrl}/`, { method: "GET", signal: AbortSignal.timeout(3_000) });
    assert.ok(fallback.ok, `/ returned HTTP ${fallback.status}`);
  } catch (error) {
    throw new Error(`Cannot reach ${baseUrl}/. Start 4173 before running this verifier. Cause: ${error.message}`);
  }
}

async function postLocalLlm(rawText) {
  const response = await fetch(`${baseUrl}/api/local-llm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      task: "conversation_general",
      rawText,
      prompt: rawText,
      parsedCommand: {
        intent: "conversation.general",
        rawText,
        slots: { topic: "vehicle_knowledge" },
      },
    }),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawBody: text };
  }
  assert.ok(response.ok, `/api/local-llm returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

await assertServerReachable();

const cases = [];
for (const rawText of ["蔚来 ET5 的中控屏多大？", "ES8 的儿童锁怎么用？", "特斯拉 Model Y 后备箱多大？"]) {
  const body = await postLocalLlm(rawText);
  assert.equal(body.model, "vehicle-knowledge-boundary", `${rawText}: model`);
  assert.equal(body.telemetry?.provider, "local-boundary", `${rawText}: provider`);
  assert.equal(body.telemetry?.reason, "vehicle-knowledge-seed-not-applicable", `${rawText}: reason`);
  assert.equal(body.telemetry?.promptChars, 0, `${rawText}: should not call Ollama prompt`);
  assert.equal(body.telemetry?.cacheEligible, false, `${rawText}: boundary must not enter dynamic LLM cache`);
  assert.equal(body.telemetry?.vehicleKnowledgeApplicability?.status, "not-applicable", `${rawText}: applicability`);
  assert.match(body.summary, /不能把它套用到|不能编造/, `${rawText}: boundary summary`);
  assert.doesNotMatch(body.summary, /15\.6 英寸|NIO ES6 是蔚来的智能电动 SUV|3 区空调/, `${rawText}: must not answer with ES6 seed facts`);
  cases.push({
    rawText,
    provider: body.telemetry.provider,
    durationMs: body.telemetry.durationMs,
    explicitModels: body.telemetry.vehicleKnowledgeApplicability.explicitModels,
  });
}

console.log(JSON.stringify({ ok: true, baseUrl, cases }, null, 2));

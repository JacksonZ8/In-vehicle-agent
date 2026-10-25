export function createChatUseCase({ cloudAdapter } = {}) {
  if (!cloudAdapter || typeof cloudAdapter.converse !== "function") {
    throw new TypeError("cloudAdapter must provide converse()");
  }
  return Object.freeze({
    async execute(context) {
      context.throwIfAborted();
      const output = await cloudAdapter.converse(
        context.rawText,
        context.parsedCommand,
        { memoryHint: context.memoryHint ?? null },
        { signal: context.signal, deadlineAt: context.deadlineAt },
      );
      context.throwIfAborted();
      return Object.freeze({
        assistantResponse: String(output?.summary || "").trim() || "抱歉，我们暂时无法完成。",
        modelCalls: Object.freeze([{ phase: "chat-response", telemetry: output?.telemetry ?? {} }]),
        degraded: output?.degraded === true || output?.telemetry?.degraded === true,
      });
    },
  });
}

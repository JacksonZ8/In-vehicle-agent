const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function readString(env, name, fallback) {
  return typeof env[name] === "string" ? env[name] : fallback;
}

function isAllowedDashscopeBaseUrl(value) {
  try {
    const url = new URL(value);
    const sharedHost = url.hostname === "dashscope.aliyuncs.com";
    const workspaceHost = /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/i.test(url.hostname);
    const allowed = url.protocol === "https:"
      && (sharedHost || workspaceHost)
      && url.pathname.replace(/\/+$/, "") === "/compatible-mode/v1"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
    return allowed;
  } catch {
    return false;
  }
}

function readiness(status, reasonCode = null) {
  return Object.freeze(reasonCode ? { status, reasonCode } : { status });
}

export function resolveModelProviderConnections(env = {}, { ollamaClient } = {}) {
  const dashscopeBaseUrl = readString(
    env,
    "NIO_DASHSCOPE_BASE_URL",
    DEFAULT_DASHSCOPE_BASE_URL,
  );
  const dashscopeApiKey = readString(env, "DASHSCOPE_API_KEY", "").trim();
  const ollamaReady = Boolean(ollamaClient && typeof ollamaClient.generate === "function");
  const dashscopeReady = Boolean(
    dashscopeApiKey && isAllowedDashscopeBaseUrl(dashscopeBaseUrl),
  );
  const dashscope = {
    baseUrl: dashscopeBaseUrl,
    readiness: readiness(
      dashscopeReady ? "ready" : "blocked",
      dashscopeReady ? null : "provider-config-invalid",
    ),
  };
  Object.defineProperty(dashscope, "apiKey", {
    value: dashscopeApiKey,
    enumerable: false,
  });

  return Object.freeze({
    ollama: Object.freeze({
      client: ollamaClient,
      readiness: readiness(
        ollamaReady ? "ready" : "blocked",
        ollamaReady ? null : "provider-config-invalid",
      ),
    }),
    dashscope: Object.freeze(dashscope),
  });
}

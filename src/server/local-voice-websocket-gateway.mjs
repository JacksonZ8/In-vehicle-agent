import { WebSocket, WebSocketServer } from "ws";

const LOCAL_VOICE_STREAM_PATH = "/api/local-voice/stream";

function requestOrigin(request) {
  const value = request?.headers?.origin;
  return typeof value === "string" ? value.trim() : "";
}

export function isSameOriginLoopbackRequest(request) {
  const origin = requestOrigin(request);
  const host = typeof request?.headers?.host === "string" ? request.headers.host.trim() : "";
  if (!origin || !host || origin.length > 256 || host.length > 128) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && ["127.0.0.1", "localhost"].includes(parsed.hostname)
      && parsed.host === host
      && parsed.origin === origin;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, statusCode, reason) {
  if (!socket || socket.destroyed) return;
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
}

export function attachLocalVoiceWebSocketGateway(server, { coordinator } = {}) {
  if (!server || typeof server.on !== "function") throw new TypeError("server is required");
  if (!coordinator
    || typeof coordinator.connect !== "function"
    || typeof coordinator.receiveText !== "function"
    || typeof coordinator.receiveBinary !== "function") {
    throw new TypeError("local voice coordinator is required");
  }

  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1_024,
    maxBufferedChunks: 8,
    maxFragments: 4,
  });

  const handleUpgrade = (request, socket, head) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== LOCAL_VOICE_STREAM_PATH) return;
    if (!isSameOriginLoopbackRequest(request)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const sessionId = url.searchParams.get("sessionId") || "";
    let activeWebsocket = null;
    try {
      coordinator.connect({
        sessionId,
        origin: requestOrigin(request),
        send(event) {
          if (activeWebsocket?.readyState === WebSocket.OPEN) {
            activeWebsocket.send(JSON.stringify(event));
          }
        },
      });
    } catch {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      activeWebsocket = websocket;
      websocket.binaryType = "nodebuffer";
      websocket.on("message", (data, isBinary) => {
        let result;
        try {
          result = isBinary
            ? coordinator.receiveBinary(sessionId, data)
            : coordinator.receiveText(sessionId, data.toString("utf8"));
        } catch {
          websocket.close(1008, "invalid-voice-session");
          return;
        }
        if (result?.ok === false) websocket.close(1008, result.reasonCode);
        if (result?.closed === true) websocket.close(1000, "client-stopped");
      });
      websocket.once("close", () => coordinator.disconnect(sessionId, "connection-closed"));
      websocket.once("error", () => coordinator.disconnect(sessionId, "connection-error"));
    });
  };

  server.on("upgrade", handleUpgrade);
  server.once("close", () => {
    server.removeListener("upgrade", handleUpgrade);
    coordinator.close?.();
    websocketServer.close();
  });
  return websocketServer;
}

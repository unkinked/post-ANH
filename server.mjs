import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 8080);
const configFilePath = join(root, "webhook-config.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

const webhookPath = "/api/webhooks/interop";
const lastWebhookPath = "/api/webhooks/last";
const healthWebhookPath = "/api/webhooks/health";
const configPath = "/api/config";
const connectionCheckPath = "/api/connection-check";

function defaultWebhookUrl(origin) {
  return `${origin}${webhookPath}`;
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readStoredConfig() {
  if (!existsSync(configFilePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(configFilePath, "utf8"));
  } catch {
    return null;
  }
}

function persistConfig(config) {
  writeFileSync(configFilePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function getOrigin(request) {
  const host = request.headers.host || `127.0.0.1:${port}`;
  return `http://${host}`;
}

function createInitialConfig() {
  const stored = readStoredConfig();
  return {
    webhook_enabled: stored?.webhook_enabled ?? true,
    webhook_url: stored?.webhook_url ?? "",
    external_project_url: stored?.external_project_url ?? "",
    webhook_auth_type: stored?.webhook_auth_type === "hmac" ? "hmac" : "bearer",
    webhook_auth_token: stored?.webhook_auth_token ?? "",
    webhook_secret: stored?.webhook_secret ?? "",
  };
}

const state = {
  config: createInitialConfig(),
  lastEvent: {
    status: 200,
    message: "Esperando la primera insercion.",
    received_at: null,
    payload: null,
  },
};

function resolveConfigForOrigin(origin) {
  const resolved = {
    webhook_enabled: Boolean(state.config.webhook_enabled),
    webhook_url: state.config.webhook_url || defaultWebhookUrl(origin),
    external_project_url: state.config.external_project_url || "",
    webhook_auth_type: state.config.webhook_auth_type === "hmac" ? "hmac" : "bearer",
  };

  if (resolved.webhook_auth_type === "bearer") {
    resolved.webhook_auth_token = state.config.webhook_auth_token || "";
  } else {
    resolved.webhook_secret = state.config.webhook_secret || "";
  }

  return resolved;
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(text);
}

function normalizeConfig(input, origin) {
  const normalized = {
    webhook_enabled: input.webhook_enabled !== false,
    webhook_url: "",
    external_project_url: "",
    webhook_auth_type: input.webhook_auth_type === "hmac" ? "hmac" : "bearer",
    webhook_auth_token: "",
    webhook_secret: "",
  };

  const requestedUrl = String(input.webhook_url || "").trim();
  normalized.webhook_url = requestedUrl || defaultWebhookUrl(origin);
  normalized.external_project_url = String(input.external_project_url || "").trim();

  if (normalized.webhook_auth_type === "bearer") {
    normalized.webhook_auth_token = String(input.webhook_auth_token || "").trim();
  } else {
    normalized.webhook_secret = String(input.webhook_secret || "").trim();
  }

  return normalized;
}

function validateConfig(config) {
  if (!isValidHttpUrl(config.webhook_url)) {
    return "Ingresa una URL webhook valida con http:// o https://.";
  }

  if (config.external_project_url && !isValidHttpUrl(config.external_project_url)) {
    return "Ingresa una URL valida para el proyecto externo.";
  }

  if (config.webhook_auth_type === "bearer" && !config.webhook_auth_token) {
    return "Debes generar un token Bearer.";
  }

  if (config.webhook_auth_type === "hmac" && !config.webhook_secret) {
    return "Debes generar un secreto HMAC.";
  }

  return null;
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        rejectBody(new Error("Payload demasiado grande."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!raw) {
        rejectBody(new Error("El body JSON es obligatorio."));
        return;
      }

      try {
        resolveBody({ parsed: JSON.parse(raw), raw });
      } catch {
        rejectBody(new Error("El body no contiene un JSON valido."));
      }
    });

    request.on("error", rejectBody);
  });
}

function createSignature(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function signaturesMatch(expected, received) {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function updateLastEvent(status, message, payload) {
  state.lastEvent = {
    status,
    message,
    received_at: new Date().toISOString(),
    payload,
  };
}

function resolveRequestPath(url) {
  const parsedUrl = new URL(url, `http://localhost:${port}`);
  const cleanPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const filePath = normalize(join(root, decodeURIComponent(cleanPath)));

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

async function handleConfig(request, response) {
  const origin = getOrigin(request);

  if (request.method === "GET") {
    sendJson(response, 200, { config: resolveConfigForOrigin(origin) });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Metodo no permitido." });
    return;
  }

  try {
    const { parsed } = await readJsonBody(request);
    const normalized = normalizeConfig(parsed, origin);
    const error = validateConfig(normalized);

    if (error) {
      sendJson(response, 400, { message: error });
      return;
    }

    state.config = normalized;
    persistConfig(state.config);
    sendJson(response, 200, {
      message: "Configuracion guardada.",
      config: resolveConfigForOrigin(origin),
    });
  } catch (error) {
    sendJson(response, 400, { message: error.message });
  }
}

async function handleIncomingWebhook(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Metodo no permitido." });
    return;
  }

  if (!state.config.webhook_enabled) {
    updateLastEvent(400, "El webhook esta desactivado.", null);
    sendJson(response, 400, { message: "El webhook esta desactivado." });
    return;
  }

  try {
    const { parsed, raw } = await readJsonBody(request);

    if (state.config.webhook_auth_type === "bearer") {
      const header = request.headers.authorization || "";
      const expected = `Bearer ${state.config.webhook_auth_token}`;
      if (!state.config.webhook_auth_token || header !== expected) {
        updateLastEvent(400, "Token Bearer invalido o ausente.", parsed);
        sendJson(response, 400, { message: "Token Bearer invalido o ausente." });
        return;
      }
    } else {
      const header = String(request.headers["x-webhook-signature"] || "");
      const expected = createSignature(state.config.webhook_secret || "", raw);
      if (!header || !state.config.webhook_secret || !signaturesMatch(expected, header)) {
        updateLastEvent(400, "Firma HMAC invalida o ausente.", parsed);
        sendJson(response, 400, { message: "Firma HMAC invalida o ausente." });
        return;
      }
    }

    const status = state.lastEvent.payload ? 200 : 201;
    const message = status === 201 ? "Insercion recibida correctamente." : "Insercion actualizada correctamente.";
    updateLastEvent(status, message, parsed);
    sendJson(response, status, {
      status,
      message,
      received_at: state.lastEvent.received_at,
      payload: parsed,
    });
  } catch (error) {
    updateLastEvent(400, error.message, null);
    sendJson(response, 400, { message: error.message });
  }
}

function handleLastWebhook(_request, response) {
  sendJson(response, 200, state.lastEvent);
}

function handleHealthWebhook(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { success: false, status: 405, message: "Metodo no permitido" }, {
      "Access-Control-Allow-Origin": "*",
    });
    return;
  }

  sendJson(
    response,
    200,
    {
      success: true,
      status: 200,
      message: state.config.webhook_enabled ? "Webhook activo" : "Webhook inactivo",
    },
    {
      "Access-Control-Allow-Origin": "*",
    },
  );
}

async function handleConnectionCheck(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { success: false, status: 405, message: "Metodo no permitido." });
    return;
  }

  try {
    const { parsed } = await readJsonBody(request);
    const targetUrl = String(parsed.url || "").trim();

    if (!isValidHttpUrl(targetUrl)) {
      sendJson(response, 400, {
        success: false,
        status: 400,
        message: "La URL del proyecto externo no es valida.",
      });
      return;
    }

    const startedAt = Date.now();
    let upstreamResponse;

    try {
      upstreamResponse = await fetch(targetUrl, {
        method: "HEAD",
        redirect: "follow",
      });
    } catch {
      upstreamResponse = await fetch(targetUrl, {
        method: "GET",
        redirect: "follow",
      });
    }

    sendJson(response, 200, {
      success: true,
      status: upstreamResponse.status,
      message: "Activo",
      response_time_ms: Date.now() - startedAt,
    });
  } catch (error) {
    sendJson(response, 200, {
      success: false,
      status: 0,
      message: "Inactivo",
      response_time_ms: null,
    });
  }
}

const server = createServer(async (request, response) => {
  const parsedUrl = new URL(request.url || "/", `http://localhost:${port}`);

  if (parsedUrl.pathname === configPath) {
    await handleConfig(request, response);
    return;
  }

  if (parsedUrl.pathname === webhookPath) {
    await handleIncomingWebhook(request, response);
    return;
  }

  if (parsedUrl.pathname === lastWebhookPath) {
    handleLastWebhook(request, response);
    return;
  }

  if (parsedUrl.pathname === healthWebhookPath) {
    handleHealthWebhook(request, response);
    return;
  }

  if (parsedUrl.pathname === connectionCheckPath) {
    await handleConnectionCheck(request, response);
    return;
  }

  const filePath = resolveRequestPath(request.url || "/");

  if (!filePath) {
    sendText(response, 403, "Ruta no permitida.");
    return;
  }

  if (!existsSync(filePath)) {
    sendText(response, 404, "Archivo no encontrado.");
    return;
  }

  const fileStats = statSync(filePath);
  if (fileStats.isDirectory()) {
    sendText(response, 403, "Directory listing desactivado.");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  const title = readFileSync(join(root, "index.html"), "utf8").match(/<title>([^<]+)<\/title>/)?.[1] || "Webhook app";
  console.log(`${title} running at http://127.0.0.1:${port}/`);
  console.log(`Webhook receiver: http://127.0.0.1:${port}${webhookPath}`);
});

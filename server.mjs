import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 8080);
const configFilePath = join(root, "webhook-config.json");

const webhookPath = "/api/webhooks/interoperability";
const lastWebhookPath = "/api/webhooks/last";
const healthWebhookPath = "/api/webhooks/health";
const configPath = "/api/config";
const connectionCheckPath = "/api/connection-check";
const dashboardPath = "/api/dashboard";
const authTestPath = "/api/auth-test";

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

const HISTORY_LIMIT = 20;
const LOG_LIMIT = 40;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

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
  if (!existsSync(configFilePath)) return null;

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
  const protocol = request.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${host}`;
}

function getIdentifier(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "desconocido";
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

function createInitialState() {
  return {
    config: createInitialConfig(),
    lastValidEvent: {
      status: 200,
      message: "Esperando la primera inserción válida.",
      received_at: null,
      payload: null,
      identifier: null,
    },
    lastAttempt: {
      id: 0,
      status: 200,
      message: "Esperando requests.",
      received_at: null,
      success: null,
      payload_visible: false,
      payload: null,
      identifier: null,
      auth_type: null,
    },
    history: [],
    logs: [],
    stats: {
      successful_requests: 0,
      failed_requests: 0,
      last_access: null,
      last_error: null,
    },
    security: {
      protected: true,
      auth_active: true,
      last_failed_attempt: null,
      security_level: "Medio",
    },
    rateLimit: new Map(),
  };
}

const state = createInitialState();

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

function getSecurityLevel() {
  if (!state.config.webhook_enabled) return "Bajo";
  return state.config.webhook_auth_type === "hmac" ? "Alto" : "Medio";
}

function refreshSecurityState() {
  state.security.protected = Boolean(state.config.webhook_enabled);
  state.security.auth_active = state.config.webhook_auth_type === "bearer"
    ? Boolean(state.config.webhook_auth_token)
    : Boolean(state.config.webhook_secret);
  state.security.security_level = getSecurityLevel();
}

function apiHeaders(extraHeaders = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Signature, X-Webhook-Test, X-Webhook-Source",
    ...extraHeaders,
  };
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, apiHeaders(extraHeaders));
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(text);
}

function pushLog(level, message, meta = {}) {
  state.logs.unshift({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
  state.logs = state.logs.slice(0, LOG_LIMIT);
}

function pushHistory(entry) {
  state.history.unshift(entry);
  state.history = state.history.slice(0, HISTORY_LIMIT);
}

function registerAttempt({
  status,
  message,
  success,
  identifier,
  authType,
  payload = null,
  payloadVisible = false,
  result,
}) {
  const timestamp = new Date().toISOString();

  state.lastAttempt = {
    id: state.lastAttempt.id + 1,
    status,
    message,
    received_at: timestamp,
    success,
    payload_visible: payloadVisible,
    payload: payloadVisible ? payload : null,
    identifier,
    auth_type: authType,
  };

  state.stats.last_access = timestamp;

  pushHistory({
    timestamp,
    status,
    auth_type: authType || state.config.webhook_auth_type,
    result,
    identifier,
    success,
  });

  if (success) {
    state.stats.successful_requests += 1;
    pushLog("success", message, { status, identifier });
  } else {
    state.stats.failed_requests += 1;
    state.stats.last_error = { timestamp, message, status };
    state.security.last_failed_attempt = timestamp;
    pushLog(status === 429 ? "warning" : "error", message, { status, identifier });
  }
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

  const requestedWebhookUrl = String(input.webhook_url || "").trim();
  normalized.webhook_url = requestedWebhookUrl || defaultWebhookUrl(origin);
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
    return "Ingresa una URL webhook válida con http:// o https://.";
  }

  if (config.external_project_url && !isValidHttpUrl(config.external_project_url)) {
    return "Ingresa una URL válida para el proyecto externo.";
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
        rejectBody(new Error("El body no contiene un JSON válido."));
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
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isRateLimited(identifier) {
  const now = Date.now();
  const attempts = state.rateLimit.get(identifier) || [];
  const recentAttempts = attempts.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

  if (recentAttempts.length >= RATE_LIMIT_MAX) {
    state.rateLimit.set(identifier, recentAttempts);
    return true;
  }

  recentAttempts.push(now);
  state.rateLimit.set(identifier, recentAttempts);
  return false;
}

function resolveRequestPath(url) {
  const parsedUrl = new URL(url, `http://localhost:${port}`);
  const cleanPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const filePath = normalize(join(root, decodeURIComponent(cleanPath)));
  return filePath.startsWith(root) ? filePath : null;
}

function safeParsePayload(payload) {
  if (payload && typeof payload === "object") return payload;
  return null;
}

function authErrorResponse(authType, reason) {
  if (authType === "hmac") {
    return reason === "missing"
      ? { status: 401, body: { success: false, error: "Firma requerida" } }
      : { status: 401, body: { success: false, error: "Firma inválida" } };
  }

  return reason === "missing"
    ? { status: 401, body: { success: false, error: "Token requerido" } }
    : { status: 401, body: { success: false, error: "Token inválido" } };
}

function validateWebhookAuth(request, rawBody) {
  if (state.config.webhook_auth_type === "bearer") {
    const header = String(request.headers.authorization || "");
    if (!header) return { ok: false, ...authErrorResponse("bearer", "missing") };

    const expected = `Bearer ${state.config.webhook_auth_token}`;
    if (!state.config.webhook_auth_token || header !== expected) {
      return { ok: false, ...authErrorResponse("bearer", "invalid") };
    }

    return { ok: true };
  }

  const signature = String(request.headers["x-webhook-signature"] || "");
  if (!signature) return { ok: false, ...authErrorResponse("hmac", "missing") };

  const expected = createSignature(state.config.webhook_secret || "", rawBody);
  if (!state.config.webhook_secret || !signaturesMatch(expected, signature)) {
    return { ok: false, ...authErrorResponse("hmac", "invalid") };
  }

  return { ok: true };
}

function currentDashboard() {
  refreshSecurityState();

  return {
    received_panel: {
      status: state.lastAttempt.status,
      message: state.lastAttempt.message,
      received_at: state.lastAttempt.received_at,
      payload: state.lastAttempt.payload_visible ? state.lastAttempt.payload : null,
      success: state.lastAttempt.success,
    },
    kpis: {
      successful_requests: state.stats.successful_requests,
      failed_requests: state.stats.failed_requests,
      last_access: state.stats.last_access,
      last_error: state.stats.last_error,
    },
    history: state.history,
    logs: state.logs,
    security: state.security,
    auth_type: state.config.webhook_auth_type,
  };
}

async function handleConfig(request, response) {
  const origin = getOrigin(request);

  if (request.method === "GET") {
    sendJson(response, 200, { config: resolveConfigForOrigin(origin) });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Método no permitido." });
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
    refreshSecurityState();
    persistConfig(state.config);
    pushLog("warning", "Configuración del webhook actualizada.", { status: 200, identifier: "dashboard" });

    sendJson(response, 200, {
      message: "Configuración guardada.",
      config: resolveConfigForOrigin(origin),
    });
  } catch (error) {
    sendJson(response, 400, { message: error.message });
  }
}

async function handleIncomingWebhook(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Método no permitido." });
    return;
  }

  const identifier = getIdentifier(request);
  const authType = state.config.webhook_auth_type;
  const isDryRun = String(request.headers["x-webhook-test"] || "") === "true";\n  console.log("DEBUG: received webhook from", getOrigin(request), "identifier", identifier, "auth_type", state.config.webhook_auth_type);

  pushLog("neutral", `Incoming webhook: id=${identifier}, origin=${getOrigin(request)}, auth=${state.config.webhook_auth_type}, dryRun=${isDryRun}`);

  if (isRateLimited(identifier)) {
    registerAttempt({
      status: 429,
      message: "Demasiadas solicitudes",
      success: false,
      identifier,
      authType,
      payloadVisible: false,
      result: "Rate limit",
    });
    sendJson(response, 429, { success: false, error: "Demasiadas solicitudes" });
    return;
  }

  if (!state.config.webhook_enabled) {
    registerAttempt({
      status: 400,
      message: "Webhook desactivado.",
      success: false,
      identifier,
      authType,
      payloadVisible: false,
      result: "Webhook desactivado",
    });
    sendJson(response, 400, { success: false, error: "Webhook desactivado" });
    return;
  }

  pushLog("warning", "Request recibido.", { status: 0, identifier });

  try {
    const { parsed, raw } = await readJsonBody(request);
    const payload = safeParsePayload(parsed);

    const authResult = validateWebhookAuth(request, raw);
    if (!authResult.ok) {
      registerAttempt({
        status: authResult.status,
        message: authResult.body.error,
        success: false,
        identifier,
        authType,
        payloadVisible: false,
        result: authResult.body.error,
      });
      sendJson(response, authResult.status, authResult.body);
      return;
    }

    if (isDryRun) {
      registerAttempt({
        status: 200,
        message: "Autenticación válida",
        success: true,
        identifier,
        authType,
        payloadVisible: false,
        result: "Dry run",
      });
      sendJson(response, 200, { success: true, message: "Autenticación válida" });
      return;
    }

    const status = state.lastValidEvent.payload ? 200 : 201;
    const message = status === 201 ? "Datos procesados correctamente." : "Datos actualizados correctamente.";
    const timestamp = new Date().toISOString();

    state.lastValidEvent = {
      status,
      message,
      received_at: timestamp,
      payload,
      identifier,
    };

    registerAttempt({
      status,
      message,
      success: true,
      identifier,
      authType,
      payload,
      payloadVisible: true,
      result: "Procesado",
    });

    sendJson(response, status, {
      success: true,
      status,
      message,
      received_at: timestamp,
      payload,
    });
  } catch (error) {
    registerAttempt({
      status: 400,
      message: error.message,
      success: false,
      identifier,
      authType,
      payloadVisible: false,
      result: "JSON inválido",
    });
    sendJson(response, 400, { success: false, error: error.message });
  }
}

function handleLastWebhook(_request, response) {
  sendJson(response, 200, state.lastValidEvent);
}

function handleHealthWebhook(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { success: false, status: 405, message: "Método no permitido" });
    return;
  }

  sendJson(response, 200, {
    success: true,
    status: 200,
    message: state.config.webhook_enabled ? "Webhook activo" : "Webhook inactivo",
  });
}

async function handleConnectionCheck(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { success: false, status: 405, message: "Método no permitido." });
    return;
  }

  try {
    const { parsed } = await readJsonBody(request);
    const targetUrl = String(parsed.url || "").trim();

    if (!isValidHttpUrl(targetUrl)) {
      sendJson(response, 400, {
        success: false,
        status: 400,
        message: "La URL del proyecto externo no es válida.",
      });
      return;
    }

    const startedAt = Date.now();
    let upstreamResponse;

    try {
      upstreamResponse = await fetch(targetUrl, { method: "HEAD", redirect: "follow" });
    } catch {
      upstreamResponse = await fetch(targetUrl, { method: "GET", redirect: "follow" });
    }

    sendJson(response, 200, {
      success: true,
      status: upstreamResponse.status,
      message: "Activo",
      response_time_ms: Date.now() - startedAt,
    });
  } catch {
    sendJson(response, 200, {
      success: false,
      status: 0,
      message: "Inactivo",
      response_time_ms: null,
    });
  }
}

async function handleAuthTest(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { success: false, error: "Método no permitido." });
    return;
  }

  try {
    const { parsed } = await readJsonBody(request);
    const mode = parsed.mode === "invalid" ? "invalid" : "valid";
    const payload = {
      test: true,
      source: "auth-test",
      timestamp: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "X-Webhook-Test": "true",
      "X-Webhook-Source": "dashboard",
    };

    if (state.config.webhook_auth_type === "bearer") {
      headers.Authorization = mode === "valid"
        ? `Bearer ${state.config.webhook_auth_token}`
        : "Bearer token-invalido";
    } else {
      const secret = mode === "valid" ? state.config.webhook_secret : "secreto-invalido";
      headers["X-Webhook-Signature"] = createSignature(secret, body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const startedAt = Date.now();

    try {
      const webhookResponse = await fetch(state.config.webhook_url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      let responseBody = {};
      try {
        responseBody = await webhookResponse.json();
      } catch {
        responseBody = {};
      }

      const ok = webhookResponse.ok;
      sendJson(response, 200, {
        success: ok,
        result: ok ? "válido" : webhookResponse.status === 401 ? "inválido" : "error",
        status: webhookResponse.status,
        response_time_ms: Date.now() - startedAt,
        message: responseBody.message || responseBody.error || (ok ? "Autenticación válida" : "Error de autenticación"),
      });
    } catch (error) {
      clearTimeout(timeout);
      sendJson(response, 200, {
        success: false,
        result: error.name === "AbortError" ? "timeout" : "error de red",
        status: 0,
        response_time_ms: null,
        message: error.name === "AbortError" ? "La prueba excedió el tiempo de espera." : "No fue posible completar la prueba.",
      });
    }
  } catch (error) {
    sendJson(response, 400, { success: false, error: error.message });
  }
}

function handleDashboard(_request, response) {
  sendJson(response, 200, currentDashboard());
}

const apiPaths = new Set([
  webhookPath,
  lastWebhookPath,
  healthWebhookPath,
  configPath,
  connectionCheckPath,
  dashboardPath,
  authTestPath,
]);

const server = createServer(async (request, response) => {
  const parsedUrl = new URL(request.url || "/", `http://localhost:${port}`);

  if (request.method === "OPTIONS" && apiPaths.has(parsedUrl.pathname)) {
    response.writeHead(204, apiHeaders());
    response.end();
    return;
  }

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

  if (parsedUrl.pathname === dashboardPath) {
    handleDashboard(request, response);
    return;
  }

  if (parsedUrl.pathname === authTestPath) {
    await handleAuthTest(request, response);
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

refreshSecurityState();

server.listen(port, "0.0.0.0", () => {
  const title =
    readFileSync(join(root, "index.html"), "utf8").match(/<title>([^<]+)<\/title>/)?.[1] ||
    "Webhook app";

  console.log(`${title} running on port ${port}`);
  console.log(`Webhook receiver: /api/webhooks/interoperability`);
});
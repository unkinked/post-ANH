const webhookPath = "/api/webhooks/interoperability";
const configEndpoint = "/api/config";
const lastWebhookEndpoint = "/api/webhooks/last";
const connectionCheckEndpoint = "/api/connection-check";
const dashboardEndpoint = "/api/dashboard";
const authTestEndpoint = "/api/auth-test";
const pollIntervalMs = 3000;

const elements = {
  webhookUrl: document.querySelector("#webhookUrl"),
  externalProjectUrl: document.querySelector("#externalProjectUrl"),
  authType: document.querySelector("#authType"),
  authTestMode: document.querySelector("#authTestMode"),
  bearerFields: document.querySelector("#bearerFields"),
  hmacFields: document.querySelector("#hmacFields"),
  token: document.querySelector("#authToken"),
  secret: document.querySelector("#hmacSecret"),
  saveStatus: document.querySelector("#saveStatus"),
  toastStack: document.querySelector("#toastStack"),
  attemptAlert: document.querySelector("#attemptAlert"),
  attemptAlertTitle: document.querySelector("#attemptAlertTitle"),
  attemptAlertMessage: document.querySelector("#attemptAlertMessage"),
  connectionIndicator: document.querySelector("#connectionIndicator"),
  connectionMessage: document.querySelector("#connectionMessage"),
  connectionHttp: document.querySelector("#connectionHttp"),
  connectionTime: document.querySelector("#connectionTime"),
  receivedStatus: document.querySelector("#receivedStatus"),
  receivedDate: document.querySelector("#receivedDate"),
  receivedMessage: document.querySelector("#receivedMessage"),
  receivedPayload: document.querySelector("#receivedPayload"),
  historyBody: document.querySelector("#historyBody"),
  logsList: document.querySelector("#logsList"),
  kpiSuccess: document.querySelector("#kpiSuccess"),
  kpiFailed: document.querySelector("#kpiFailed"),
  kpiLastAccess: document.querySelector("#kpiLastAccess"),
  kpiLastError: document.querySelector("#kpiLastError"),
  securityProtected: document.querySelector("#securityProtected"),
  securityAuth: document.querySelector("#securityAuth"),
  securityLastFailed: document.querySelector("#securityLastFailed"),
  securityLevel: document.querySelector("#securityLevel"),
  authTestBadge: document.querySelector("#authTestBadge"),
  authTestMessage: document.querySelector("#authTestMessage"),
  errors: {
    webhookUrl: document.querySelector("#webhookUrlError"),
    externalProjectUrl: document.querySelector("#externalProjectUrlError"),
    token: document.querySelector("#authTokenError"),
    secret: document.querySelector("#hmacSecretError"),
  },
};

const buttons = {
  saveWebhookUrl: document.querySelector("#saveWebhookUrl"),
  copyWebhookUrl: document.querySelector("#copyWebhookUrl"),
  saveExternalUrl: document.querySelector("#saveExternalUrl"),
  verifyConnection: document.querySelector("#verifyConnection"),
  generateToken: document.querySelector("#generateToken"),
  copyToken: document.querySelector("#copyToken"),
  toggleToken: document.querySelector("#toggleToken"),
  generateSecret: document.querySelector("#generateSecret"),
  copySecret: document.querySelector("#copySecret"),
  toggleSecret: document.querySelector("#toggleSecret"),
  copyBearerExample: document.querySelector("#copyBearerExample"),
  copyCurlExample: document.querySelector("#copyCurlExample"),
  copyJsonExample: document.querySelector("#copyJsonExample"),
  runAuthTest: document.querySelector("#runAuthTest"),
};

let pollTimer = null;
let lastAttemptId = null;

function defaultWebhookUrl() {
  return `${window.location.origin}${webhookPath}`;
}

function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateBearerToken() {
  return `whk_bearer_${randomBase64Url(32)}`;
}

function generateHmacSecret() {
  return `whk_hmac_${randomBase64Url(48)}`;
}

function clearErrors() {
  Object.values(elements.errors).forEach((element) => {
    element.textContent = "";
  });
}

function isValidUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function setAuthView() {
  const isBearer = elements.authType.value === "bearer";
  elements.bearerFields.classList.toggle("hidden", !isBearer);
  elements.hmacFields.classList.toggle("hidden", isBearer);
}

function setPasswordVisibility(input, button) {
  const hidden = input.type === "password";
  input.type = hidden ? "text" : "password";
  button.textContent = hidden ? "Ocultar" : "Ver";
}

function formatTimestamp(value) {
  if (!value) return "Sin registros";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-CO");
}

function pushToast(type, message) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  elements.toastStack.prepend(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 4200);
}

async function copyText(value, message) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    elements.saveStatus.textContent = message;
    pushToast("success", message);
  } catch {
    elements.saveStatus.textContent = "No se pudo copiar automáticamente.";
    pushToast("error", "No se pudo copiar automáticamente.");
  }
}

function getConfigPayload() {
  return {
    webhook_enabled: true,
    webhook_url: elements.webhookUrl.value.trim(),
    external_project_url: elements.externalProjectUrl.value.trim(),
    webhook_auth_type: elements.authType.value,
    webhook_auth_token: elements.authType.value === "bearer" ? elements.token.value.trim() : "",
    webhook_secret: elements.authType.value === "hmac" ? elements.secret.value.trim() : "",
  };
}

function validateConfig() {
  clearErrors();
  const payload = getConfigPayload();
  let valid = true;

  if (!isValidUrl(payload.webhook_url)) {
    elements.errors.webhookUrl.textContent = "Ingresa una URL webhook válida con http:// o https://.";
    valid = false;
  }

  if (payload.external_project_url && !isValidUrl(payload.external_project_url)) {
    elements.errors.externalProjectUrl.textContent = "Ingresa una URL válida para el proyecto externo.";
    valid = false;
  }

  if (payload.webhook_auth_type === "bearer" && !payload.webhook_auth_token) {
    elements.errors.token.textContent = "Genera un token Bearer para guardar la configuración.";
    valid = false;
  }

  if (payload.webhook_auth_type === "hmac" && !payload.webhook_secret) {
    elements.errors.secret.textContent = "Genera un secreto HMAC para guardar la configuración.";
    valid = false;
  }

  return valid;
}

async function saveConfig(message) {
  if (!validateConfig()) return false;

  try {
    const response = await fetch(configEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getConfigPayload()),
    });
    const data = await response.json();

    if (!response.ok) {
      elements.saveStatus.textContent = data.message || "No se pudo guardar la configuración.";
      pushToast("error", data.message || "No se pudo guardar la configuración.");
      return false;
    }

    elements.webhookUrl.value = data.config.webhook_url;
    elements.externalProjectUrl.value = data.config.external_project_url || "";
    elements.token.value = data.config.webhook_auth_token || "";
    elements.secret.value = data.config.webhook_secret || "";
    elements.saveStatus.textContent = message;
    pushToast("success", message);
    return true;
  } catch {
    elements.saveStatus.textContent = "No fue posible conectar con el servidor.";
    pushToast("error", "No fue posible conectar con el servidor.");
    return false;
  }
}

function setConnectionState(state, message, status = "-", time = "-") {
  elements.connectionIndicator.className = `connection-pill ${state}`;
  elements.connectionIndicator.textContent =
    state === "success" ? "Activo" : state === "error" ? "Inactivo" : "Sin verificar";
  elements.connectionMessage.textContent = message;
  elements.connectionHttp.textContent = `HTTP: ${status}`;
  elements.connectionTime.textContent = `Tiempo: ${time}`;
}

function setAuthTestState(state, message) {
  elements.authTestBadge.className = `badge ${state}`;
  elements.authTestBadge.textContent =
    state === "badge-success" ? "Válido" :
    state === "badge-error" ? "Inválido" :
    state === "badge-warning" ? "Timeout" :
    "Sin ejecutar";
  elements.authTestMessage.textContent = message;
}

function renderReceivedPanel(panel) {
  const statusText = panel?.status ?? "-";
  elements.receivedStatus.textContent = statusText;
  elements.receivedDate.textContent = formatTimestamp(panel?.received_at);
  elements.receivedMessage.textContent = panel?.message || "Esperando datos";

  if (panel?.payload) {
    elements.receivedPayload.textContent = JSON.stringify(panel.payload, null, 2);
  } else if (panel?.success === false) {
    elements.receivedPayload.textContent = "No se muestran datos porque el intento falló o la autenticación fue inválida.";
  } else {
    elements.receivedPayload.textContent = "Aún no se ha recibido ninguna inserción.";
  }

  const failed = panel?.success === false;
  elements.attemptAlert.classList.toggle("hidden", !failed);
  if (failed) {
    elements.attemptAlert.className = "attempt-alert attempt-alert-error";
    elements.attemptAlertTitle.textContent = `HTTP ${statusText}`;
    elements.attemptAlertMessage.textContent = panel.message || "Se detectó un intento fallido.";
  }
}

function renderKpis(kpis) {
  elements.kpiSuccess.textContent = String(kpis?.successful_requests ?? 0);
  elements.kpiFailed.textContent = String(kpis?.failed_requests ?? 0);
  elements.kpiLastAccess.textContent = formatTimestamp(kpis?.last_access);
  elements.kpiLastError.textContent = kpis?.last_error
    ? `${formatTimestamp(kpis.last_error.timestamp)} · ${kpis.last_error.message}`
    : "Sin errores";
}

function renderSecurity(security) {
  elements.securityProtected.className = `badge ${security?.protected ? "badge-success" : "badge-error"}`;
  elements.securityProtected.textContent = security?.protected ? "Sí" : "No";
  elements.securityAuth.className = `badge ${security?.auth_active ? "badge-success" : "badge-error"}`;
  elements.securityAuth.textContent = security?.auth_active ? "Activa" : "Inactiva";
  elements.securityLastFailed.textContent = formatTimestamp(security?.last_failed_attempt);

  const level = security?.security_level || "Medio";
  const levelClass = level === "Alto" ? "badge-success" : level === "Bajo" ? "badge-error" : "badge-warning";
  elements.securityLevel.className = `badge ${levelClass}`;
  elements.securityLevel.textContent = level;
}

function renderHistory(history) {
  if (!history?.length) {
    elements.historyBody.innerHTML = '<tr><td colspan="6" class="empty-row">Aún no hay requests.</td></tr>';
    return;
  }

  elements.historyBody.innerHTML = history.map((item) => `
    <tr>
      <td>${formatTimestamp(item.timestamp)}</td>
      <td><span class="badge ${item.success ? "badge-success" : "badge-error"}">${item.status}</span></td>
      <td>${item.auth_type || "-"}</td>
      <td>${item.result}</td>
      <td>${item.identifier || "-"}</td>
      <td>${item.success ? "Success" : "Error"}</td>
    </tr>
  `).join("");
}

function renderLogs(logs) {
  if (!logs?.length) {
    elements.logsList.innerHTML = '<div class="log-item log-neutral">Aún no hay eventos registrados.</div>';
    return;
  }

  elements.logsList.innerHTML = logs.map((item) => `
    <div class="log-item log-${item.level}">
      <span class="log-time">[${new Date(item.timestamp).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}]</span>
      <span>${item.message}</span>
    </div>
  `).join("");
}

function maybeNotifyAttempt(panel) {
  if (!panel || panel.id == null || panel.id === lastAttemptId) return;
  lastAttemptId = panel.id;

  if (panel.success === false) {
    pushToast("error", `HTTP ${panel.status}: ${panel.message}`);
  } else if (panel.success === true) {
    pushToast("success", panel.message || "Request procesado.");
  }
}

async function fetchDashboard() {
  try {
    const response = await fetch(dashboardEndpoint, { cache: "no-store" });
    if (!response.ok) return;
    const dashboard = await response.json();

    const receivedPanel = {
      ...dashboard.received_panel,
      id: dashboard.received_panel?.received_at,
    };

    renderReceivedPanel(receivedPanel);
    renderKpis(dashboard.kpis);
    renderSecurity(dashboard.security);
    renderHistory(dashboard.history);
    renderLogs(dashboard.logs);
    maybeNotifyAttempt(receivedPanel);
  } catch {
    elements.receivedMessage.textContent = "No se pudo consultar el estado del dashboard.";
  }
}

async function verifyConnection() {
  clearErrors();

  if (!isValidUrl(elements.externalProjectUrl.value.trim())) {
    elements.errors.externalProjectUrl.textContent = "Ingresa una URL válida del proyecto externo antes de verificar.";
    setConnectionState("error", "La URL del proyecto externo no es válida.", 400, "-");
    return;
  }

  buttons.verifyConnection.disabled = true;
  setConnectionState("neutral", "Verificando disponibilidad...", "-", "-");

  try {
    const response = await fetch(connectionCheckEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: elements.externalProjectUrl.value.trim() }),
    });
    const data = await response.json();
    const elapsed = data.response_time_ms != null ? `${data.response_time_ms} ms` : "-";
    setConnectionState(data.success ? "success" : "error", data.message || "Inactivo", data.status ?? "-", elapsed);
  } catch {
    setConnectionState("error", "Inactivo", "error", "-");
  } finally {
    buttons.verifyConnection.disabled = false;
  }
}

function buildBearerExample() {
  return `fetch("${elements.webhookUrl.value.trim()}", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${elements.token.value.trim() || "TOKEN"}"
  },
  body: JSON.stringify({
    id: 123,
    nombre: "Cliente Demo",
    accion: "insert"
  })
});`;
}

function buildCurlExample() {
  if (elements.authType.value === "hmac") {
    return `curl -X POST "${elements.webhookUrl.value.trim()}" \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Signature: sha256=FIRMA_GENERADA" \\
  -d '{"id":123,"nombre":"Cliente Demo","accion":"insert"}'`;
  }

  return `curl -X POST "${elements.webhookUrl.value.trim()}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${elements.token.value.trim() || "TOKEN"}" \\
  -d '{"id":123,"nombre":"Cliente Demo","accion":"insert"}'`;
}

function buildJsonExample() {
  return JSON.stringify(getConfigPayload(), null, 2);
}

async function runAuthTest() {
  buttons.runAuthTest.disabled = true;
  setAuthTestState("badge-warning", "Ejecutando prueba de autenticación...");

  try {
    const response = await fetch(authTestEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: elements.authTestMode.value }),
    });
    const data = await response.json();

    if (data.result === "válido") {
      setAuthTestState("badge-success", `${data.message} · HTTP ${data.status} · ${data.response_time_ms} ms`);
    } else if (data.result === "inválido") {
      setAuthTestState("badge-error", `${data.message} · HTTP ${data.status}`);
    } else if (data.result === "timeout") {
      setAuthTestState("badge-warning", data.message);
    } else {
      setAuthTestState("badge-error", data.message || "No se pudo completar la prueba.");
    }
  } catch {
    setAuthTestState("badge-error", "Error de red al ejecutar la prueba.");
  } finally {
    buttons.runAuthTest.disabled = false;
  }
}

function startPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(fetchDashboard, pollIntervalMs);
}

async function loadInitialState() {
  elements.webhookUrl.value = defaultWebhookUrl();
  elements.externalProjectUrl.value = "";
  setConnectionState("neutral", "Aún no se ha comprobado la disponibilidad del sitio.", "-", "-");
  setAuthTestState("badge-neutral", "Aún no se ha ejecutado ninguna prueba.");

  try {
    const response = await fetch(configEndpoint, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    const config = data.config;

    elements.webhookUrl.value = config.webhook_url || defaultWebhookUrl();
    elements.externalProjectUrl.value = config.external_project_url || "";
    elements.authType.value = config.webhook_auth_type || "bearer";
    elements.token.value = config.webhook_auth_token || "";
    elements.secret.value = config.webhook_secret || "";
  } catch {
    elements.authType.value = "bearer";
  }

  if (elements.authType.value === "bearer" && !elements.token.value.trim()) {
    elements.token.value = generateBearerToken();
  }

  if (elements.authType.value === "hmac" && !elements.secret.value.trim()) {
    elements.secret.value = generateHmacSecret();
  }

  setAuthView();
  await saveConfig("Configuración lista.");
  await fetchDashboard();
}

elements.authType.addEventListener("change", async () => {
  setAuthView();

  if (elements.authType.value === "bearer" && !elements.token.value.trim()) {
    elements.token.value = generateBearerToken();
  }

  if (elements.authType.value === "hmac" && !elements.secret.value.trim()) {
    elements.secret.value = generateHmacSecret();
  }

  await saveConfig("Autenticación guardada.");
});

buttons.saveWebhookUrl.addEventListener("click", async () => {
  await saveConfig("URL webhook guardada.");
});

buttons.copyWebhookUrl.addEventListener("click", async () => {
  await copyText(elements.webhookUrl.value.trim(), "URL webhook copiada.");
});

buttons.saveExternalUrl.addEventListener("click", async () => {
  await saveConfig("URL del proyecto externo guardada.");
});

buttons.verifyConnection.addEventListener("click", verifyConnection);

buttons.generateToken.addEventListener("click", async () => {
  elements.token.value = generateBearerToken();
  await saveConfig("Token Bearer regenerado.");
});

buttons.copyToken.addEventListener("click", async () => {
  await copyText(elements.token.value.trim(), "Token copiado.");
});

buttons.toggleToken.addEventListener("click", () => {
  setPasswordVisibility(elements.token, buttons.toggleToken);
});

buttons.generateSecret.addEventListener("click", async () => {
  elements.secret.value = generateHmacSecret();
  await saveConfig("Secreto HMAC regenerado.");
});

buttons.copySecret.addEventListener("click", async () => {
  await copyText(elements.secret.value.trim(), "Secreto copiado.");
});

buttons.toggleSecret.addEventListener("click", () => {
  setPasswordVisibility(elements.secret, buttons.toggleSecret);
});

buttons.copyBearerExample.addEventListener("click", async () => {
  await copyText(buildBearerExample(), "Ejemplo Bearer copiado.");
});

buttons.copyCurlExample.addEventListener("click", async () => {
  await copyText(buildCurlExample(), "Ejemplo curl copiado.");
});

buttons.copyJsonExample.addEventListener("click", async () => {
  await copyText(buildJsonExample(), "Ejemplo JSON copiado.");
});

buttons.runAuthTest.addEventListener("click", runAuthTest);

loadInitialState();
startPolling();

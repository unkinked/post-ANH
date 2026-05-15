const webhookPath = "/api/webhooks/interoperability";
const configEndpoint = "/api/config";
const lastWebhookEndpoint = "/api/webhooks/last";
const connectionCheckEndpoint = "/api/connection-check";
const pollIntervalMs = 3000;

const elements = {
  webhookUrl: document.querySelector("#webhookUrl"),
  externalProjectUrl: document.querySelector("#externalProjectUrl"),
  authType: document.querySelector("#authType"),
  bearerFields: document.querySelector("#bearerFields"),
  hmacFields: document.querySelector("#hmacFields"),
  token: document.querySelector("#authToken"),
  secret: document.querySelector("#hmacSecret"),
  saveStatus: document.querySelector("#saveStatus"),
  connectionIndicator: document.querySelector("#connectionIndicator"),
  connectionMessage: document.querySelector("#connectionMessage"),
  connectionHttp: document.querySelector("#connectionHttp"),
  connectionTime: document.querySelector("#connectionTime"),
  receivedStatus: document.querySelector("#receivedStatus"),
  receivedDate: document.querySelector("#receivedDate"),
  receivedMessage: document.querySelector("#receivedMessage"),
  receivedPayload: document.querySelector("#receivedPayload"),
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
};

let pollTimer = null;

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

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    elements.saveStatus.textContent = message;
  } catch {
    elements.saveStatus.textContent = "No se pudo copiar automaticamente.";
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
    elements.errors.webhookUrl.textContent = "Ingresa una URL webhook valida con http:// o https://.";
    valid = false;
  }

  if (payload.external_project_url && !isValidUrl(payload.external_project_url)) {
    elements.errors.externalProjectUrl.textContent = "Ingresa una URL valida para el proyecto externo.";
    valid = false;
  }

  if (payload.webhook_auth_type === "bearer" && !payload.webhook_auth_token) {
    elements.errors.token.textContent = "Genera un token Bearer para guardar la configuracion.";
    valid = false;
  }

  if (payload.webhook_auth_type === "hmac" && !payload.webhook_secret) {
    elements.errors.secret.textContent = "Genera un secreto HMAC para guardar la configuracion.";
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
      elements.saveStatus.textContent = data.message || "No se pudo guardar la configuracion.";
      return false;
    }

    elements.webhookUrl.value = data.config.webhook_url;
    elements.externalProjectUrl.value = data.config.external_project_url || "";
    elements.token.value = data.config.webhook_auth_token || "";
    elements.secret.value = data.config.webhook_secret || "";
    elements.saveStatus.textContent = message;
    return true;
  } catch {
    elements.saveStatus.textContent = "No fue posible conectar con el servidor.";
    return false;
  }
}

function formatTimestamp(value) {
  if (!value) return "Sin registros";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("es-CO");
}

function renderLastEvent(data) {
  elements.receivedStatus.textContent = data?.status ?? "-";
  elements.receivedDate.textContent = formatTimestamp(data?.received_at);
  elements.receivedMessage.textContent = data?.message || "Esperando datos";
  elements.receivedPayload.textContent = data?.payload
    ? JSON.stringify(data.payload, null, 2)
    : "Aun no se ha recibido ninguna insercion.";
}

function setConnectionState(state, message, status = "-", time = "-") {
  elements.connectionIndicator.className = `connection-pill ${state}`;
  elements.connectionIndicator.textContent =
    state === "success" ? "Activo" : state === "error" ? "Inactivo" : "Sin verificar";
  elements.connectionMessage.textContent = message;
  elements.connectionHttp.textContent = `HTTP: ${status}`;
  elements.connectionTime.textContent = `Tiempo: ${time}`;
}

async function fetchLastEvent() {
  try {
    const response = await fetch(lastWebhookEndpoint, { cache: "no-store" });
    if (!response.ok) return;
    renderLastEvent(await response.json());
  } catch {
    elements.receivedMessage.textContent = "No se pudo consultar la ultima insercion.";
  }
}

async function verifyConnection() {
  clearErrors();

  if (!isValidUrl(elements.externalProjectUrl.value.trim())) {
    elements.errors.externalProjectUrl.textContent = "Ingresa una URL valida del proyecto externo antes de verificar.";
    setConnectionState("error", "La URL del proyecto externo no es valida.", 400, "-");
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

function startPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(fetchLastEvent, pollIntervalMs);
}

async function loadInitialState() {
  elements.webhookUrl.value = defaultWebhookUrl();
  elements.externalProjectUrl.value = "";

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

  if (!elements.token.value) {
    elements.token.value = generateBearerToken();
  }

  setAuthView();
  await saveConfig("Configuracion lista.");
  await fetchLastEvent();
}

elements.authType.addEventListener("change", async () => {
  setAuthView();

  if (elements.authType.value === "bearer" && !elements.token.value.trim()) {
    elements.token.value = generateBearerToken();
  }

  if (elements.authType.value === "hmac" && !elements.secret.value.trim()) {
    elements.secret.value = generateHmacSecret();
  }

  await saveConfig("Autenticacion guardada.");
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

buttons.verifyConnection.addEventListener("click", async () => {
  await verifyConnection();
});

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

loadInitialState();
startPolling();

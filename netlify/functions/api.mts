import type { Config } from "@netlify/functions";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { webhookConfigs, webhookEvents } from "../../db/schema.js";

const webhookPath = "/api/webhooks/interop";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Webhook-Signature",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Cache-Control": "no-store",
};

function json(payload: unknown, init: ResponseInit = {}) {
  return Response.json(payload, {
    ...init,
    headers: {
      ...corsHeaders,
      "X-Content-Type-Options": "nosniff",
      ...init.headers,
    },
  });
}

function defaultWebhookUrl(req: Request) {
  return `${new URL(req.url).origin}${webhookPath}`;
}

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function publicConfig(row: typeof webhookConfigs.$inferSelect | undefined, req: Request) {
  const authType = row?.webhookAuthType === "hmac" ? "hmac" : "bearer";
  return {
    webhook_enabled: row?.webhookEnabled !== "false",
    webhook_url: row?.webhookUrl || defaultWebhookUrl(req),
    external_project_url: row?.externalProjectUrl || "",
    webhook_auth_type: authType,
    webhook_auth_token: authType === "bearer" ? row?.webhookAuthToken || "" : "",
    webhook_secret: authType === "hmac" ? row?.webhookSecret || "" : "",
  };
}

async function getConfigRow() {
  const [row] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.id, 1)).limit(1);
  return row;
}

async function readJson(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("El body debe enviarse como JSON.");
  }

  return req.json();
}

function normalizeConfig(input: Record<string, unknown>, req: Request) {
  const authType = input.webhook_auth_type === "hmac" ? "hmac" : "bearer";
  return {
    webhookEnabled: input.webhook_enabled === false ? "false" : "true",
    webhookUrl: String(input.webhook_url || "").trim() || defaultWebhookUrl(req),
    externalProjectUrl: String(input.external_project_url || "").trim(),
    webhookAuthType: authType,
    webhookAuthToken: authType === "bearer" ? String(input.webhook_auth_token || "").trim() : "",
    webhookSecret: authType === "hmac" ? String(input.webhook_secret || "").trim() : "",
  };
}

function validateConfig(config: ReturnType<typeof normalizeConfig>) {
  if (!isValidHttpUrl(config.webhookUrl)) return "Ingresa una URL webhook valida con http:// o https://.";
  if (config.externalProjectUrl && !isValidHttpUrl(config.externalProjectUrl)) {
    return "Ingresa una URL valida para el proyecto externo.";
  }
  if (config.webhookAuthType === "bearer" && !config.webhookAuthToken) return "Debes generar un token Bearer.";
  if (config.webhookAuthType === "hmac" && !config.webhookSecret) return "Debes generar un secreto HMAC.";
  return null;
}

async function handleConfig(req: Request) {
  if (req.method === "GET") return json({ config: publicConfig(await getConfigRow(), req) });
  if (req.method !== "POST") return json({ message: "Metodo no permitido." }, { status: 405 });

  try {
    const normalized = normalizeConfig((await readJson(req)) as Record<string, unknown>, req);
    const error = validateConfig(normalized);
    if (error) return json({ message: error }, { status: 400 });

    await db
      .insert(webhookConfigs)
      .values({ id: 1, ...normalized, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: webhookConfigs.id,
        set: { ...normalized, updatedAt: new Date() },
      });

    return json({ message: "Configuracion guardada.", config: publicConfig(await getConfigRow(), req) });
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "El body no contiene un JSON valido." }, { status: 400 });
  }
}

async function handleIncomingWebhook(req: Request) {
  if (req.method === "DELETE") return handleClearWebhookData(req);
  if (req.method !== "POST") return json({ message: "Metodo no permitido." }, { status: 405 });

  try {
    const payload = await readJson(req);
    const [event] = await db
      .insert(webhookEvents)
      .values({
        status: "200",
        message: "Datos recibidos correctamente.",
        payload,
      })
      .returning();

    return json({
      status: 200,
      message: event.message,
      received_at: event.receivedAt,
      payload: event.payload,
    });
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "El body no contiene un JSON valido." }, { status: 400 });
  }
}

async function handleLastWebhook() {
  const [event] = await db.select().from(webhookEvents).orderBy(desc(webhookEvents.receivedAt)).limit(1);
  if (!event) {
    return json({
      status: "-",
      message: "Esperando datos",
      received_at: null,
      payload: null,
    });
  }

  return json({
    status: Number(event.status),
    message: event.message,
    received_at: event.receivedAt,
    payload: event.payload,
  });
}

async function handleClearWebhookData(req: Request) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return json({ message: "Metodo no permitido." }, { status: 405 });
  }

  await db.delete(webhookEvents);

  return json({
    status: "-",
    message: "Datos limpiados correctamente",
    received_at: null,
    payload: null,
  });
}

async function handleConnectionCheck(req: Request) {
  if (req.method !== "POST") return json({ success: false, status: 405, message: "Metodo no permitido." }, { status: 405 });

  try {
    const body = (await readJson(req)) as Record<string, unknown>;
    const targetUrl = String(body.url || "").trim();
    if (!isValidHttpUrl(targetUrl)) {
      return json({ success: false, status: 400, message: "La URL del proyecto externo no es valida." }, { status: 400 });
    }

    const startedAt = Date.now();
    const upstreamResponse = await fetch(targetUrl, { method: "GET", redirect: "follow" });
    return json({
      success: true,
      status: upstreamResponse.status,
      message: "Activo",
      response_time_ms: Date.now() - startedAt,
    });
  } catch {
    return json({ success: false, status: 0, message: "Inactivo", response_time_ms: null });
  }
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const { pathname } = new URL(req.url);
  if (pathname === "/api/config") return handleConfig(req);
  if (pathname === webhookPath) return handleIncomingWebhook(req);
  if (pathname === "/api/webhooks/last") return handleLastWebhook();
  if (pathname === "/api/webhooks/clear") return handleClearWebhookData(req);
  if (pathname === "/api/connection-check") return handleConnectionCheck(req);

  return json({ message: "No encontrado." }, { status: 404 });
};

export const config: Config = {
  path: ["/api/config", "/api/webhooks/interop", "/api/webhooks/last", "/api/webhooks/clear", "/api/connection-check"],
};

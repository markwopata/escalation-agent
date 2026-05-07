import process from "node:process";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let sessionId = null;
let initializePromise = null;
let requestCounter = 1;
const DEFAULT_FROSTY_TIMEOUT_MS = Number(process.env.FROSTY_REQUEST_TIMEOUT_MS ?? "30000");
const selectedWarehouseByBaseUrl = new Map();

export class FrostyError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.name = "FrostyError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function nextRequestId() {
  requestCounter += 1;
  return requestCounter;
}

function buildJsonRpc(method, params) {
  return {
    jsonrpc: "2.0",
    id: nextRequestId(),
    method,
    ...(params ? { params } : {}),
  };
}

function parseSsePayload(bodyText) {
  for (const line of bodyText.split("\n")) {
    if (line.startsWith("data: ")) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new FrostyError("Frosty returned an SSE response without a JSON payload.");
}

async function parseResponseEnvelope(response) {
  const bodyText = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    throw new FrostyError(
      `Frosty request failed with HTTP ${response.status}.`,
      response.status,
      bodyText,
    );
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(bodyText);
  }

  return parseSsePayload(bodyText);
}

async function fetchWithTimeout(input, init, timeoutMs = DEFAULT_FROSTY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new FrostyError(`Frosty request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function initializeSession(baseUrl) {
  if (sessionId) {
    return sessionId;
  }

  if (!initializePromise) {
    initializePromise = (async () => {
      const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify(
          buildJsonRpc("initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: {
              name: "equipmentshare-domain-bridge",
              version: "0.1.0",
            },
          }),
        ),
      });

      await parseResponseEnvelope(response);
      const freshSessionId = response.headers.get("mcp-session-id");
      if (!freshSessionId) {
        throw new FrostyError("Frosty did not return an MCP session id.");
      }
      sessionId = freshSessionId;
      return freshSessionId;
    })().finally(() => {
      initializePromise = null;
    });
  }

  return initializePromise;
}

async function requestWithSession(baseUrl, method, params, attempt = 1) {
  const activeSessionId = await initializeSession(baseUrl);

  let response;
  try {
    response = await fetchWithTimeout(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "Mcp-Session-Id": activeSessionId,
      },
      body: JSON.stringify(buildJsonRpc(method, params)),
    });
  } catch (error) {
    if (attempt === 1) {
      sessionId = null;
      return requestWithSession(baseUrl, method, params, attempt + 1);
    }
    throw error;
  }

  if (response.status === 404 && attempt === 1) {
    sessionId = null;
    return requestWithSession(baseUrl, method, params, attempt + 1);
  }

  if (response.status === 202) {
    try {
      response = await fetchWithTimeout(
        `${baseUrl}/mcp`,
        {
          method: "GET",
          headers: {
            ...MCP_HEADERS,
            "Mcp-Session-Id": activeSessionId,
          },
        },
        DEFAULT_FROSTY_TIMEOUT_MS,
      );
    } catch (error) {
      if (attempt === 1) {
        sessionId = null;
        return requestWithSession(baseUrl, method, params, attempt + 1);
      }
      throw error;
    }
  }

  return parseResponseEnvelope(response);
}

function extractToolJson(result) {
  const textBlock = result.content?.find((entry) => typeof entry.text === "string")?.text;
  if (!textBlock) {
    throw new FrostyError("Frosty tool response did not include text content.");
  }
  return JSON.parse(textBlock);
}

export async function executeSqlThroughFrosty(
  query,
  baseUrl = process.env.FROSTY_BASE_URL ?? "http://localhost:8888",
) {
  const envelope = await requestWithSession(baseUrl, "tools/call", {
    name: "sql_execute",
    arguments: {
      query,
    },
  });

  const result = envelope.result;
  if (!result) {
    throw new FrostyError("Frosty returned no result payload for sql_execute.", undefined, JSON.stringify(envelope));
  }

  return extractToolJson(result);
}

export async function ensureFrostyWarehouse(
  warehouse,
  baseUrl = process.env.FROSTY_BASE_URL ?? "http://localhost:8888",
) {
  const trimmedWarehouse = warehouse.trim();
  if (!trimmedWarehouse) {
    return;
  }

  if (selectedWarehouseByBaseUrl.get(baseUrl) === trimmedWarehouse) {
    return;
  }

  const useResult = await executeSqlThroughFrosty(`use warehouse ${trimmedWarehouse}`, baseUrl);
  if (useResult.success === false) {
    throw new FrostyError(
      `Frosty could not select warehouse ${trimmedWarehouse}.`,
      undefined,
      useResult.error ?? undefined,
    );
  }

  selectedWarehouseByBaseUrl.set(baseUrl, trimmedWarehouse);
}

export async function executeSqlThroughFrostyWithWarehouse(
  query,
  warehouse = process.env.FROSTY_SQL_WAREHOUSE ?? "AD_HOC_WH",
  baseUrl = process.env.FROSTY_BASE_URL ?? "http://localhost:8888",
) {
  await ensureFrostyWarehouse(warehouse, baseUrl);
  return executeSqlThroughFrosty(query, baseUrl);
}

export async function getFrostyStatus(baseUrl = process.env.FROSTY_BASE_URL ?? "http://localhost:8888") {
  const [healthResponse, authResponse] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/auth/status`),
  ]);

  if (!healthResponse.ok) {
    throw new FrostyError(`Frosty health check failed with HTTP ${healthResponse.status}.`);
  }

  if (!authResponse.ok) {
    throw new FrostyError(`Frosty auth check failed with HTTP ${authResponse.status}.`);
  }

  return {
    health: await healthResponse.json(),
    auth: await authResponse.json(),
  };
}

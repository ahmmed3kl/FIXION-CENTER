const config = require("../config");

class ZadxSmsError extends Error {
  constructor(category, message, options = {}) {
    super(message);
    this.name = "ZadxSmsError";
    this.category = category;
    this.httpStatus = options.httpStatus || null;
    this.retryable = Boolean(options.retryable);
    this.ambiguous = Boolean(options.ambiguous);
    this.providerMessageId = options.providerMessageId || null;
  }
}

function isConfigured() {
  return config.sms.provider === "zadx" && Boolean(config.sms.apiKey && config.sms.apiSecret);
}

function getMessageId(body) {
  return body?.messageId || body?.message_id || body?.id || body?.data?.messageId || body?.data?.message_id || body?.data?.id || null;
}

function providerMessage(body) {
  if (!body) return "ZADX returned an empty response.";
  return String(body.message || body.error || body.detail || body.data?.message || "ZADX request failed.");
}

async function request(path, options = {}) {
  if (!isConfigured()) {
    throw new ZadxSmsError("not_configured", "SMS provider is not configured.", {
      retryable: false,
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.sms.timeoutMs);
  try {
    const response = await fetch(`${config.sms.apiUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Api-Key": config.sms.apiKey,
        "X-Api-Secret": config.sms.apiSecret,
        ...(options.headers || {}),
      },
    });
    let body = null;
    try { body = await response.json(); } catch { /* provider may return an empty body */ }
    if (!response.ok) {
      // Only explicit provider responses that prove the request was temporarily
      // rejected before acceptance (429 Too Many Requests, 503 Service Unavailable)
      // are safe for automatic retry without risking duplicate SMS delivery.
      const retryable = response.status === 429 || response.status === 503;
      let category = "provider_error";
      if (response.status === 401) category = "authentication_failed";
      else if (response.status === 403) category = "provider_rejected";
      else if (response.status === 422) category = "invalid_phone";
      else if (response.status === 402) category = "insufficient_credits";
      else if (response.status === 429) category = "rate_limited";
      else if (response.status === 503) category = "service_unavailable";
      throw new ZadxSmsError(category, providerMessage(body), {
        httpStatus: response.status,
        retryable,
        ambiguous: false,
        providerMessageId: getMessageId(body),
      });
    }
    return { body, status: response.status };
  } catch (error) {
    if (error instanceof ZadxSmsError) throw error;
    if (error?.name === "AbortError") {
      throw new ZadxSmsError(
        "timeout_ambiguous",
        "ZADX request timed out after dispatch; delivery outcome is ambiguous.",
        { retryable: false, ambiguous: true },
      );
    }
    throw new ZadxSmsError(
      "network_failure_ambiguous",
      "ZADX network request failed after dispatch; delivery outcome is ambiguous.",
      { retryable: false, ambiguous: true },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function send({ to, message, idempotencyKey }) {
  if (!to || !message || !idempotencyKey) {
    throw new ZadxSmsError(
      "validation_error",
      "SMS recipient, message, and idempotency key are required.",
      { retryable: false },
    );
  }
  const result = await request("/api/v1/sms/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ to: String(to), message: String(message) }),
  });
  return {
    accepted: true,
    httpStatus: result.status,
    providerMessageId: getMessageId(result.body),
    response: result.body,
  };
}

async function getBalance() {
  const result = await request("/api/v1/sms/balance");
  return result.body;
}

async function getSenderIds() {
  const result = await request("/api/v1/sms/sender-ids");
  return result.body;
}

module.exports = { ZadxSmsError, isConfigured, send, getBalance, getSenderIds };

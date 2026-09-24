const config = require("../config");

class ZadxSmsError extends Error {
  constructor(category, message, options = {}) {
    super(message);
    this.name = "ZadxSmsError";
    this.category = category;
    this.httpStatus = options.httpStatus || null;
    this.retryable = Boolean(options.retryable);
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
    throw new ZadxSmsError("not_configured", "SMS provider is not configured.");
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
      const retryable = response.status === 429 || response.status >= 500;
      let category = "provider_error";
      if (response.status === 401) category = "authentication_failed";
      else if (response.status === 403) category = "provider_rejected";
      else if (response.status === 422) category = "invalid_phone";
      else if (response.status === 402) category = "insufficient_credits";
      throw new ZadxSmsError(category, providerMessage(body), { httpStatus: response.status, retryable, providerMessageId: getMessageId(body) });
    }
    return { body, status: response.status };
  } catch (error) {
    if (error instanceof ZadxSmsError) throw error;
    if (error?.name === "AbortError") throw new ZadxSmsError("timeout", "ZADX request timed out.", { retryable: true });
    throw new ZadxSmsError("network_failure", "ZADX network request failed.", { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

async function send({ to, message, idempotencyKey }) {
  if (!to || !message || !idempotencyKey) {
    throw new ZadxSmsError("validation_error", "SMS recipient, message, and idempotency key are required.");
  }
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await request("/api/v1/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ to: String(to), message: String(message) }),
      });
      return { accepted: true, httpStatus: result.status, providerMessageId: getMessageId(result.body), response: result.body };
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === 1) throw error;
    }
  }
  throw lastError;
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

const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/(api[_-]?key|api[_-]?secret|password|authorization|token|credential|secret)/i.test(key)) return [key, "[REDACTED]"];
    return [key, redact(item)];
  }));
}

async function main() {
  const provider = String(process.env.SMS_PROVIDER || "").trim().toLowerCase();
  if (provider !== "zadx") {
    console.error("Real SMS test stopped: SMS_PROVIDER must be set to zadx.");
    process.exitCode = 1;
    return;
  }

  const apiUrl = String(process.env.SMS_API_URL || "").trim().replace(/\/$/, "");
  const apiKey = String(process.env.SMS_API_KEY || "").trim();
  const apiSecret = String(process.env.SMS_API_SECRET || "").trim();
  if (!apiUrl || !apiKey || !apiSecret) {
    console.error("Real SMS test stopped: SMS_API_URL, SMS_API_KEY, and SMS_API_SECRET are required in backend/.env.");
    process.exitCode = 1;
    return;
  }

  const phone = await ask("Phone number to send the real SMS to: ");
  if (!phone) {
    console.error("Real SMS test stopped: phone number is required.");
    process.exitCode = 1;
    return;
  }

  const confirmation = await ask("SEND REAL SMS? Type YES to continue: ");
  if (confirmation !== "YES") {
    console.log("Real SMS test cancelled. No request was sent.");
    return;
  }

  const idempotencyKey = `fixion-real-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const endpoint = `${apiUrl}/api/v1/sms/send`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SMS_TIMEOUT_MS || 15000));

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "X-Api-Secret": apiSecret,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ to: phone, message: "اختبار SMS من FIXION" }),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = rawBody; }
    const providerMessageId = body && typeof body === "object"
      ? body.messageId || body.message_id || body.id || body.data?.messageId || body.data?.message_id || body.data?.id || null
      : null;
    console.log(JSON.stringify({
      httpStatus: response.status,
      accepted: response.ok,
      success: response.ok,
      providerMessageId,
      responseBody: redact(body),
    }, null, 2));
    if (!response.ok) process.exitCode = 1;
  } catch (error) {
    const category = error?.name === "AbortError" ? "timeout" : "network_failure";
    console.error(JSON.stringify({ category, message: "Real SMS request failed safely." }));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(() => {
  console.error("Real SMS test failed safely.");
  process.exitCode = 1;
});

const assert = require("assert");

process.env.SMS_PROVIDER = "zadx";
process.env.SMS_API_URL = "https://smsapi.zadx.net";
process.env.SMS_API_KEY = "test-key";
process.env.SMS_API_SECRET = "test-secret";

const provider = require("../src/services/zadxSmsProvider");

async function run() {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 202, json: async () => ({ message_id: "msg-1" }) };
  };
  const unicode = "غياب الطالب أحمد";
  const result = await provider.send({ to: "01012345678", message: unicode, idempotencyKey: "fixion-sms-delivery-1" });
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(calls[0].url, "https://smsapi.zadx.net/api/v1/sms/send");
  assert.strictEqual(calls[0].options.headers["X-Api-Key"], "test-key");
  assert.strictEqual(calls[0].options.headers["X-Api-Secret"], "test-secret");
  assert.strictEqual(calls[0].options.headers["Idempotency-Key"], "fixion-sms-delivery-1");
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), { to: "01012345678", message: unicode });
  assert.strictEqual(result.providerMessageId, "msg-1");

  let attempt = 0;
  global.fetch = async (_url, options) => {
    attempt += 1;
    calls.push({ options });
    if (attempt === 1) return { ok: false, status: 503, json: async () => ({ error: "temporary" }) };
    return { ok: true, status: 202, json: async () => ({ id: "msg-2" }) };
  };
  await provider.send({ to: "01012345678", message: unicode, idempotencyKey: "fixion-sms-delivery-2" });
  assert.strictEqual(attempt, 2);
  assert.strictEqual(calls[calls.length - 1].options.headers["Idempotency-Key"], "fixion-sms-delivery-2");

  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) });
  await assert.rejects(() => provider.send({ to: "01012345678", message: unicode, idempotencyKey: "fixion-sms-delivery-3" }), (error) => error.category === "authentication_failed" && error.retryable === false);
  console.log("ZADX SMS provider tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });

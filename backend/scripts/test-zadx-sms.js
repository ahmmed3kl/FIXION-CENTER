// Explicit manual smoke test. This script never sends unless the operator
// opts in and supplies all values through environment variables.
if (process.env.CONFIRM_ZADX_SMS !== "YES") {
  console.error("Refusing to send. Set CONFIRM_ZADX_SMS=YES to run the manual test.");
  process.exit(1);
}
if (!process.env.SMS_TEST_PHONE || !process.env.SMS_TEST_MESSAGE || !process.env.SMS_TEST_IDEMPOTENCY_KEY) {
  console.error("Set SMS_TEST_PHONE, SMS_TEST_MESSAGE, and SMS_TEST_IDEMPOTENCY_KEY.");
  process.exit(1);
}

const provider = require("../src/services/zadxSmsProvider");
provider.send({
  to: process.env.SMS_TEST_PHONE,
  message: process.env.SMS_TEST_MESSAGE,
  idempotencyKey: process.env.SMS_TEST_IDEMPOTENCY_KEY,
}).then((result) => {
  console.log(JSON.stringify({ accepted: result.accepted, httpStatus: result.httpStatus, providerMessageId: result.providerMessageId || null }));
}).catch((error) => {
  console.error(JSON.stringify({ category: error.category || "provider_error", httpStatus: error.httpStatus || null, retryable: Boolean(error.retryable) }));
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const { validateCardCode } = require("../src/services/cardRangeValidation");

async function run() {
  const rows = [{ start_code: "10051000", end_code: "10051500" }];
  const client = {
    async query(sql, parameters) {
      assert.match(sql, /center_id = \$1 AND status = 'active'/);
      assert.deepEqual(parameters, ["center-1"]);
      return { rows };
    },
  };

  await validateCardCode(client, "center-1", "10051000");
  await validateCardCode(client, "center-1", "10051500");

  for (const code of ["10050999", "10051501", "0010051000", "invalid"]) {
    await assert.rejects(
      validateCardCode(client, "center-1", code),
      (error) => error.code === (code === "invalid" ? "INVALID_CARD_CODE" : "CARD_OUTSIDE_ALLOWED_RANGE"),
    );
  }

  await assert.rejects(
    validateCardCode({ query: async () => ({ rows: [] }) }, "center-1", "10051000"),
    (error) => error.code === "CARD_RANGE_NOT_CONFIGURED" && error.statusCode === 403,
  );

  console.log("card_range_validation: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

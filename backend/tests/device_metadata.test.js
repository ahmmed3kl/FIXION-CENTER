const assert = require("node:assert/strict");
const { normalizeDeviceModelName } = require("../src/services/deviceMetadata");

assert.equal(normalizeDeviceModelName(" iPhone 15 Pro Max "), "iPhone 15 Pro Max");
assert.equal(normalizeDeviceModelName("POCO F3"), "POCO F3");

for (const value of [
  null,
  "",
  "موديل غير معروف",
  "ANDROID-Device-b3bb",
  "Mobile Tablet/Phone",
  "dev-123e4567-e89b-12d3-a456-426614174000",
  "user-123e4567-e89b-12d3-a456-426614174000",
  "123e4567-e89b-12d3-a456-426614174000",
]) {
  assert.equal(normalizeDeviceModelName(value), null, `expected ${value} to be ignored`);
}

console.log("device_metadata: all assertions passed");

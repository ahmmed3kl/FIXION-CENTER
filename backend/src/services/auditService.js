const crypto = require("crypto");
const db = require("../db");

const SENSITIVE = /password|token|secret|api[_-]?key|private[_-]?key|database[_-]?url|connection[_-]?string|authorization/i;
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE.test(key)).map(([key, item]) => [key, sanitize(item)]));
}
async function record({ actor, centerId = null, action, entityType, entityId, before = null, after = null, metadata = null, client = db }) {
  if (!actor?.id || !action || !entityType || !entityId) return;
  await client.query(`INSERT INTO audit_logs (id, operation_id, center_id, user_id, entity_type, entity_id, action, timestamp, payload, actor_type, actor_id, before_state, after_state, metadata) VALUES ($1,$2,$3,NULL,$4,$5,$6,NOW(),NULL,'platform_admin',$7,$8,$9,$10)`, [`aud-${crypto.randomUUID()}`, `platform-${crypto.randomUUID()}`, centerId, entityType, entityId, action, actor.id, JSON.stringify(sanitize(before)), JSON.stringify(sanitize(after)), JSON.stringify(sanitize(metadata))]);
}
module.exports = { record, sanitize };

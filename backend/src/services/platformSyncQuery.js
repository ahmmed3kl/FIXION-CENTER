const db = require("../db");

const STATUSES = new Set(["applied", "rejected", "conflict"]);
const SORTS = { newest: "o.created_at DESC, o.server_seq DESC", oldest: "o.created_at ASC, o.server_seq ASC", retries: "o.retry_count DESC NULLS LAST, o.created_at DESC" };

function makeFilters(query, centerId) {
  const values = [];
  const where = [];
  const add = (value, clause) => { values.push(value); where.push(clause.replace("$N", `$${values.length}`)); };
  if (centerId) add(centerId, "o.center_id=$N");
  if (query.centerId) add(String(query.centerId), "o.center_id=$N");
  if (query.deviceId) add(String(query.deviceId), "o.device_id=$N");
  if (query.status && STATUSES.has(String(query.status))) add(String(query.status), "o.status=$N");
  if (query.operationType) add(String(query.operationType), "o.operation_type=$N");
  if (query.operationId) add(String(query.operationId), "o.operation_id=$N");
  if (query.from) add(String(query.from), "o.created_at >= $N");
  if (query.to) add(String(query.to), "o.created_at <= $N");
  return { values, where: where.length ? where.join(" AND ") : "TRUE" };
}

async function listOperations(query = {}, centerId) {
  const { values, where } = makeFilters(query, centerId);
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize, 10) || 20));
  const count = await db.query(`SELECT COUNT(*)::int AS total FROM server_sync_operations o WHERE ${where}`, values);
  const total = count.rows[0]?.total || 0;
  const dataValues = values.concat([pageSize, (page - 1) * pageSize]);
  const rows = await db.query(`SELECT o.server_seq,o.operation_id,o.center_id,c.name AS center_name,o.device_id,d.device_name,d.status AS device_status,o.user_id,u.full_name AS user_name,o.operation_type,o.entity_type,o.entity_id,o.status,o.created_at,o.applied_at AS synced_at,0::int AS retry_count,NULL::text AS last_error FROM server_sync_operations o LEFT JOIN centers c ON c.id=o.center_id LEFT JOIN devices d ON d.id=o.device_id LEFT JOIN users u ON u.id=o.user_id AND u.center_id=o.center_id WHERE ${where} ORDER BY ${SORTS[query.sort] || SORTS.newest} LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`, dataValues);
  return { items: rows.rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

async function summary(query = {}, centerId) {
  const { values, where } = makeFilters(query, centerId);
  const result = await db.query(`SELECT COUNT(*) FILTER (WHERE o.status='rejected' OR o.status='conflict')::int AS failed, COUNT(*) FILTER (WHERE o.status='applied')::int AS successful, COUNT(*) FILTER (WHERE o.status='pending')::int AS pending, COUNT(*) FILTER (WHERE o.created_at >= NOW()-INTERVAL '24 hours')::int AS recent_activity, MAX(o.applied_at) FILTER (WHERE o.status='applied') AS last_successful_sync, MIN(o.created_at) FILTER (WHERE o.status='pending') AS oldest_pending, MIN(o.created_at) FILTER (WHERE o.status='rejected' OR o.status='conflict') AS oldest_failed FROM server_sync_operations o WHERE ${where}`, values);
  const devices = await db.query(`SELECT COUNT(DISTINCT o.device_id) FILTER (WHERE d.status='active' AND o.created_at >= NOW()-INTERVAL '24 hours')::int AS active_syncing_devices, COUNT(*) FILTER (WHERE d.status='revoked' AND o.status='pending')::int AS revoked_pending_operations FROM server_sync_operations o JOIN devices d ON d.id=o.device_id WHERE ${where}`, values);
  return { ...result.rows[0], ...devices.rows[0] };
}

module.exports = { listOperations, summary, STATUSES };

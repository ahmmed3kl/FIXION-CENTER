# Platform audit logs

`audit_logs` remains the existing server audit table used by sync ingestion and is extended with platform actor and safe before/after fields. Platform mutations write records server-side through `auditService.record`; there is no audit creation, update, or delete endpoint.

The read-only API is `GET /v1/platform/audit-logs` and `GET /v1/platform/audit-logs/:auditId`. It requires a Platform Admin token and supports center, actor, action, entity type, date range, server pagination, and the whitelisted `newest`/`oldest` sort values. Passwords, hashes, tokens, secrets, credentials, and authorization data are recursively removed before storage.

The retention policy is intentionally undefined; no cleanup or export job is implemented.

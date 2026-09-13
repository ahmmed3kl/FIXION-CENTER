# Sync monitoring

The protected `/sync` screen reads `GET /v1/platform/sync` and `/v1/platform/sync/summary`. It supports center, device, status, operation-type filters, server-side pagination, and the fixed sorting whitelist `newest`, `oldest`, `retries`.

The center-scoped endpoint reuses the same read-only query service. Current database statuses are `applied`, `rejected`, and `conflict`. Monitoring does not retry, replay, edit, delete, resolve, or force operations, and never changes cursors or server sequences.

Responses omit operation payloads, tokens, credentials, and phone data. Revoked devices and their historical operations remain visible; monitoring never reactivates or retries them. Platform authentication is required, so center-user tokens and forged center headers cannot authorize these endpoints.

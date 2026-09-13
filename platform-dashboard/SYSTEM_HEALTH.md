# System health

Platform Admins can read `GET /v1/platform/health`. The endpoint reuses the existing database pool, performs a lightweight `SELECT 1`, and summarizes sync from the real `server_sync_operations` statuses (`rejected`/`conflict` make sync degraded). It returns safe component statuses and a server timestamp only.

The dashboard route is `/health` with manual refresh and loading/error/empty states. Health endpoints require Platform scope; Center User tokens are rejected. No credentials, connection strings, SQL, stack traces, tokens, or invented sync fields are returned. There is no automatic polling or background monitoring.

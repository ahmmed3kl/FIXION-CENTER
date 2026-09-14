# Security and production readiness audit

The backend now fails fast in production when `DATABASE_URL`, `JWT_SECRET`, or `CORS_ORIGIN` is missing; development keeps the existing local defaults. Responses receive `nosniff`, clickjacking, and strict referrer headers. Authentication derives platform and center identity from verified JWTs and production error responses remain sanitized.

Before deployment, configure an explicit production CORS origin and strong JWT secret. `npm audit --omit=dev` currently reports two moderate `qs` advisories transitively required by Express 4; no compatible automatic fix was available, so this remains a dependency-review item rather than an untested mass upgrade.

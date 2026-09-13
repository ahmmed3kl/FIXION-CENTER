# FIXION Platform Dashboard

Standalone React/Vite web application for Platform Administrators. It is separate from the Expo mobile app and communicates only with the central Backend API; it never connects to Neon/PostgreSQL directly.

## Local development

```bash
npm install
copy .env.example .env
npm run dev
```

Set `VITE_API_BASE_URL` to the public Backend API base URL. Only public browser configuration belongs in this file. Never add database URLs, JWT secrets, private keys, or service credentials.

## Commands

`npm run dev` (development), `npm run build` (strict type check + production build), `npm run lint` (TypeScript), `npm test` (foundation tests).

## Authentication contract

The dashboard uses `POST /v1/platform/auth/login` with `{ email, password }`, returning a short response containing the JWT and Platform Admin identity. The overview uses authenticated `GET /v1/platform/overview`. Platform authentication is backed by the separate `platform_admins` table and a JWT with `scope: platform`; Center User tokens are rejected. The dashboard never accepts a client-selected center ID and does not treat Center Admin permissions as Platform Admin permissions.

## Structure

`src/api` is the centralized API client, `src/auth` is the platform session boundary, `src/pages` contains the login, overview, and future placeholders, and `src/App.tsx` contains protected routing and the application shell.

## First Platform Admin

Apply the authoritative `backend/neon_schema.sql` to the target Neon database, configure `DATABASE_URL` and `JWT_SECRET` in `backend/.env`, then run:

```bash
cd backend
npm run platform:bootstrap-admin
```

The command prompts for an email and masked password, or accepts `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` only from the process environment. It validates and hashes the password, refuses to create a second active admin, and never prints credentials or hashes. Do not put these variables in source control.

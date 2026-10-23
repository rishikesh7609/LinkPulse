# LinkPulse

LinkPulse is a URL-shortening MVP built with React, TypeScript, Vite, Express, PostgreSQL, and Drizzle ORM.

## What works

- Create short URLs with generated codes or custom aliases.
- Set an optional expiration time.
- List links from PostgreSQL with page and limit parameters and retrieve one by ID.
- Redirect active, unexpired codes to HTTP or HTTPS destinations.
- Edit destinations/expiration, deactivate/reactivate, or delete links.
- Cache short-code lookups in Redis with a 60-second maximum TTL and expiry-aware TTLs.
- Record successful redirects as timestamped PostgreSQL click events without storing IP addresses or user agents.
- Query all-time click totals, daily click trends, top links, and per-link analytics from stored events.
- Register and sign in with Argon2id password hashes and PostgreSQL-backed, server-managed sessions.
- Keep link management and analytics private to the signed-in owner while short-link redirects stay public.
- Protect state-changing requests with a session-bound CSRF token and apply Redis-backed distributed request limits.
- Receive consistent JSON errors for invalid, missing, expired, inactive, and duplicate links.

The web app provides a live dashboard backed by the link and analytics APIs, including link management, click trends, top links, and per-link click totals. A short-code cache command failure falls back to PostgreSQL; the API also requires Redis for distributed rate limits, so redirects and protected requests fail closed with `503` if Redis is unavailable.

## Requirements

- Node.js 20 or newer and npm
- PostgreSQL 15 or newer
- Docker Desktop if you want to use the included local PostgreSQL/Redis Compose services

Redis is used for short-code lookup caching and distributed rate limits. Redirect caching is optional and falls back to PostgreSQL; the API's request protection requires Redis.

## Local setup

1. Copy `.env.example` to `.env`, set a local PostgreSQL password in `POSTGRES_PASSWORD` and `DATABASE_URL`, and generate a unique `SESSION_SECRET`. Do not commit `.env`.
2. Install the locked workspace dependencies with `npm ci`.
3. Start PostgreSQL and Redis with `docker compose up -d postgres redis`, or use your own services. Redis caching can fall back to PostgreSQL, but request rate limiting requires Redis.
4. Apply the checked-in migrations with `npm run db:migrate --workspace @linkpulse/api`.
5. Start the API and web app with `npm run dev`.
6. Open <http://localhost:5173>. The dashboard reads live data from the API at <http://localhost:3001>; generated short URLs use `PUBLIC_BASE_URL` (default: <http://localhost:3001>).

To stop Compose services, run `docker compose down`. Named-volume data remains unless you explicitly remove volumes.

## Database and migrations

The schema is in `apps/api/src/db/schema.ts`. Drizzle Kit configuration is in `apps/api/drizzle.config.ts`, and SQL migrations live in `apps/api/drizzle/`.

```sh
# Generate a migration after editing the Drizzle schema
npm run db:generate --workspace @linkpulse/api -- --name=describe_change

# Apply checked-in migrations (requires DATABASE_URL)
npm run db:migrate --workspace @linkpulse/api
```

The `links` table has a UUID primary key, unique short code, destination URL, creation timestamp, optional expiry, and active flag. PostgreSQL enforces unique short codes, a 3–32 character short-code pattern, and a non-empty destination. Indexes support created-time and expiry lookups.

## API

The `click_events` table stores an event ID, link ID, and click timestamp. It has a foreign key to `links` with cascading deletion, an index on timestamp, and a composite index on link ID and timestamp. It deliberately stores no IP address, user agent, or other visitor identity.

### `POST /api/links`

```json
{
  "destinationUrl": "https://example.com/a-long-path",
  "alias": "launch-day",
  "expiresAt": "2030-01-01T00:00:00.000Z"
}
```

`alias` and `expiresAt` are optional. Destinations must be valid HTTP or HTTPS URLs without embedded credentials. Aliases use 3–32 letters, numbers, hyphens, or underscores. Duplicate aliases return `409`.

Success returns `201` with `{ "data": { "id", "shortCode", "shortUrl", "destinationUrl", "createdAt", "expiresAt", "isActive" } }`.

### `GET /api/links?page=1&limit=20`

Returns `{ "data": [...], "pagination": { "page", "limit", "total", "totalPages" } }`. `limit` can be from 1 to 100.

### `GET /api/links/:id`

Returns one link by UUID or a JSON `404` error.

### Link management

- `PATCH /api/links/:id` accepts `destinationUrl`, `expiresAt`, or both. Set `expiresAt` to `null` to remove expiration.
- `PATCH /api/links/:id/status` accepts `{ "isActive": false }` to deactivate or `true` to reactivate.
- `DELETE /api/links/:id` deletes the link and its associated click events.

These operations invalidate the short-code cache entry. If Redis is down, PostgreSQL remains authoritative and stale cache entries expire within at most 60 seconds.

### `GET /:shortCode`

Redirects to the saved destination with HTTP `302` and records a click event only after the code is found, active, unexpired, and its destination passes validation. Missing codes return JSON `404`; expired and inactive links return JSON `410` and are never recorded as clicks.

### Analytics

- `GET /api/analytics/total` returns all-time `{ "data": { "totalClicks": number } }`.
- `GET /api/analytics/timeseries?days=30` returns actual daily click buckets in the requested rolling window (1–365 days). Days with no events are omitted.
- `GET /api/analytics/top?limit=10&days=30` returns links ranked by actual clicks in the requested window (limit 1–50, days 1–365).
- `GET /api/analytics/links/:id?days=30` returns a link's all-time total and daily click buckets for the requested window.

All analytics values are queried from PostgreSQL click events; the API does not synthesize activity or fill missing days with fabricated counts.

API errors use a consistent shape:

```json
{ "error": { "code": "ALIAS_TAKEN", "message": "That custom alias is already in use." } }
```

`GET /api/health` checks process liveness. `GET /api/health/ready` checks PostgreSQL and Redis readiness.

## Development checks

| Command                | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | Run the API and web development servers |
| `npm test`             | Run API and frontend tests              |
| `npm run typecheck`    | Check both TypeScript workspaces        |
| `npm run build`        | Build API and web production artifacts  |
| `npm run lint`         | Run ESLint                              |
| `npm run format:check` | Check Prettier formatting               |

The API route tests use test-only repository and cache doubles for deterministic cases. Runtime requests always use PostgreSQL for link data and click events; there is no in-memory production fallback. Redis errors are handled as cache misses/write failures, with PostgreSQL used for redirects.

### PostgreSQL and Redis integration test

The normal test command skips the opt-in integration test. To run it, start PostgreSQL and Redis, set `DATABASE_URL` and `REDIS_URL` in the environment (the API loads them from the root `.env` during workspace commands), and apply the migrations first. Use a local or dedicated test database. The test creates uniquely named temporary users, sessions, links, and Redis keys, then removes them during cleanup.

In Windows PowerShell, run:

```powershell
$env:LINKPULSE_INTEGRATION = '1'
npm.cmd run test --workspace @linkpulse/api -- src/security.integration.test.ts
$integrationExitCode = $LASTEXITCODE
Remove-Item Env:LINKPULSE_INTEGRATION
if ($integrationExitCode -ne 0) { throw "Integration test failed with exit code $integrationExitCode." }
```

`LINKPULSE_INTEGRATION` enables the integration test for that PowerShell session. The test supplies its own temporary session secret; it reads `DATABASE_URL` and `REDIS_URL` from the process environment or root `.env`.

## Production deployment preparation

The API has account sessions, owner-scoped management and analytics, and Redis-backed rate limits. Public launch still requires managed service setup, proxy-hop verification, monitoring, and an operational abuse-report process.

The repository has no production hosting manifest or reverse proxy configuration. The frontend build output is `apps/web/dist`; the API build output is `apps/api/dist`. The API can be started from the repository root with `npm run start --workspace @linkpulse/api`. It binds to `0.0.0.0` and uses the host-provided `PORT`; `API_PORT` remains a local fallback. Production startup requires `PUBLIC_BASE_URL` so generated short links cannot silently point at localhost.

Use a same-origin proxy for the dashboard's relative `/api/...` requests, or add and test explicit cross-origin API configuration and CORS allowlisting. A compatible split-host arrangement is a static frontend host that rewrites `/api/:path*` to a Node web service, with short-link URLs pointing directly to that API service or a dedicated redirect domain. For example, Vercel supports external rewrites as a reverse proxy. [Vercel rewrites](https://vercel.com/docs/routing/rewrites)

Set production values in the hosting provider's secret environment settings. These are placeholders; never put real values in this file or in frontend `VITE_` variables:

```dotenv
NODE_ENV=production
PORT=<provided-by-host>
PUBLIC_BASE_URL=https://<short-link-domain>
DATABASE_URL=postgresql://<db-user>:<db-password>@<db-host>:5432/<db-name>?sslmode=verify-full
REDIS_URL=rediss://<redis-user>:<redis-password>@<redis-host>:<redis-port>
SESSION_SECRET=<unique-random-value-at-least-32-bytes>
TRUST_PROXY_HOPS=<exact-trusted-proxy-hop-count>
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_AUTH_MAX=10
RATE_LIMIT_CREATE_MAX=30
RATE_LIMIT_REDIRECT_MAX=120
RATE_LIMIT_ANALYTICS_MAX=120
```

The current API uses node-redis over the Redis protocol, so configure a TLS-enabled `rediss://` endpoint when required by the managed Redis provider; an HTTP/REST Redis token is not compatible with this adapter. For managed PostgreSQL, use the provider's TLS connection string and review its pooled versus direct URL guidance for application connections and migrations. [Upstash Redis protocol compatibility and TLS](https://upstash.com/docs/redis/overall/compatibility), [Neon connection strings](https://neon.com/docs/get-started/connect-neon)

Apply schema changes with `npm run db:migrate --workspace @linkpulse/api` as a controlled release step before routing traffic to a new version. `/api/health` checks process liveness; `/api/health/ready` checks PostgreSQL and Redis readiness. Redis is required for request limiting and optional for short-code caching; PostgreSQL remains authoritative for links and analytics.

`VITE_API_BASE_URL` only configures the Vite development proxy. Production frontend calls are relative `/api/...` requests and need the same-origin proxy described above. `WEB_ORIGIN` is present in the local example file but is not currently consumed by the API; CORS is not configured. Keep the API and dashboard on one browser origin unless explicit CORS policy is implemented and tested.

## Project structure

```text
apps/api/src/auth/        Registration, login, PostgreSQL sessions, and authorization middleware
apps/api/src/analytics/   Owner-scoped click analytics queries and response shaping
apps/api/src/cache/       Redis short-code cache with PostgreSQL fallback
apps/api/src/config/      Environment loading and runtime configuration checks
apps/api/src/db/          Drizzle schema and PostgreSQL connection pool
apps/api/src/links/       Link validation, service logic, and PostgreSQL repository
apps/api/src/routes/      Express authentication, link, and analytics routes
apps/api/src/security/    Redis-backed distributed rate limits
apps/api/drizzle/         SQL migrations and Drizzle snapshots
apps/web/src/api/         Typed frontend API requests and CSRF handling
apps/web/src/components/AuthScreen.tsx          Registration and login form
apps/web/src/components/ClickTrendChart.tsx     Click activity chart
apps/web/src/components/DashboardAnalytics.tsx  Dashboard analytics display
apps/web/src/components/LinkCreateForm.tsx     Short-link creation form
apps/web/src/components/SavedLinksSection.tsx   Saved links and link actions
apps/web/src/                                  React dashboard and application styles
docker-compose.yml        Local PostgreSQL and Redis services
```

## Authentication and public service controls

Authentication routes are `GET /api/auth/csrf`, `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, and `POST /api/auth/logout`. Passwords must be 12 to 128 characters. Login errors are generic; registration does not reveal whether an email is already registered. Successful registration and login rotate the session ID.

The `linkpulse.sid` cookie is HttpOnly, SameSite=Lax, and Secure in production. Sessions last 12 hours and are stored in PostgreSQL so they can be shared by API instances and are not lost on an API process restart. The session ID is SHA-256 hashed for the database key. Mutating API requests require the session-bound `X-CSRF-Token`; only token hashes are stored in session data. Keep the dashboard and API same-origin. CORS is not enabled. Authentication and all `/api/links` and `/api/analytics` operations require a session; public redirects remain unauthenticated.

Redis has separate roles. Short-code caching is best-effort: cache misses or cache failures fall back to PostgreSQL, which remains authoritative for links. Rate limits require Redis because their counters must be shared across API instances; protected routes and redirects fail closed with `503` if the rate-limit store is unavailable.

The `links.owner_id` migration adds a nullable owner without assigning existing links to a new account. Public redirects resolve by short code regardless of ownership, while management and analytics queries filter by the authenticated user's ID. This keeps legacy short URLs working without exposing their links or click data to newly registered accounts. After registering the intended account, review and run a one-time SQL update in a maintenance window to assign only the legacy links that account should own. The migration does not alter existing link or click data.

Separate Redis-backed fixed-window limits protect authentication, link creation, analytics, and redirects. Defaults are 10 authentication attempts, 30 creations, and 120 analytics or redirect requests per 15-minute window per client IP. Set `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_CREATE_MAX`, `RATE_LIMIT_ANALYTICS_MAX`, and `RATE_LIMIT_REDIRECT_MAX` to tune them. If Redis is unavailable, rate-limited routes fail closed with a temporary service error; the API does not fall back to process-local counters.

`TRUST_PROXY_HOPS` defaults to `0`, which ignores `X-Forwarded-For`. Set it only to the exact trusted proxy hop count for the selected hosting path, never to trust every proxy. Before public traffic, verify the provider's forwarding behavior and test that a client-supplied forwarded address cannot change the IP used by the limits.

Destinations may include localhost or private network hosts; the API never fetches destinations, so this is not server-side request forgery. Visitors can still be sent to harmful sites. A public operator should publish an abuse-report address, review reports promptly, deactivate confirmed malicious links, preserve only evidence needed for review, and provide an appeal path. Email verification, account suspension, and automated abuse review remain important operational controls before high-volume use.

The root `.env.example` leaves `SESSION_SECRET` blank. Populate it in `.env` with a unique random secret of at least 32 bytes. Do not commit `.env`.

The latest `npm audit` and `npm audit --omit=dev` runs each reported zero vulnerabilities. These checks report advisories known to npm when they run; they do not establish that the application has no possible security issues.

# Printer log service implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Build a deployable Hono service for remote printer logs with a live browser console.

**Architecture:** One Node process serves ingestion, authenticated queries, a SQLite-backed SSE stream and static UI. Independent UI and documentation work run alongside backend work against the shared API contract below.

**Tech Stack:** Hono, TypeScript, better-sqlite3, Zod, Node test runner, plain browser JavaScript, Docker Compose.

## API contract

- POST `/api/logs`: Bearer INGEST_TOKEN; one log object or `{logs: [objects]}`; return 201 `{accepted: number, ids: number[]}`.
- Log input: required `deviceId` and `message`; optional `level` default info, `tag` default printer, `jobId`, `sessionId`, `timestamp` ISO string, `data` JSON. Output adds numeric `id`, `receivedAt` ISO; missing optional strings are null; timestamp defaults to receivedAt.
- GET `/api/logs`: Bearer VIEW_TOKEN; filters `deviceId`, `level`, `tag`, `jobId`, `q`, `from`, `to`; time range uses receivedAt. `limit` defaults 100 (max 200), `beforeId` positive integer; return `{logs: Log[], hasMore: boolean, nextBeforeId: number|null, latestId: number}` in descending ID order. latestId is global max ID for initial SSE handoff.
- GET `/api/logs/stream`: same read auth and filters; `afterId` nonnegative integer, defaults current latest; emits `event: ready` then `event: log`, ID is numeric log ID, data is one full log object; periodic `event: heartbeat`. Client reconnects with afterId from last log. Replay is ascending and bounded per fetch. Fetch streaming keeps token out of URL.
- Error responses: `{error: string}` with 400/401/413/500 as appropriate. Health GET `/healthz` returns `{status:'ok'}`.

## Task 1: Backend scaffold and behavior tests

Files: package.json, tsconfig.json, src/config.ts, src/types.ts, tests/service.test.ts.

- [x] Add dependencies and scripts for `npm run dev`, `npm run build`, `npm test`, `npm run typecheck`, `npm start`.
- [x] Write integration tests using app.request and temporary on-disk SQLite, assert ingestion returns 201 then GET returns persisted log, and missing credentials return 401. Run `npm test` and confirm expected missing implementation failure.
- [x] Extend tests for malformed body, invalid batch rollback, filters/pagination, literal keyword search, restart persistence, retention/max rows and invalid config.

## Task 2: Store, validation, API and SSE

Files: src/store.ts, src/validation.ts, src/app.ts, src/index.ts.

- [x] Implement schema validation, prepared SQL with bound parameters, transactional batches and bounded storage. Run `npm test` until storage/API tests pass.
- [x] Add SSE test that reads ready, inserts a log, receives its event, disconnects, then reconnects after an older ID and checks replay.
- [x] Implement SSE database polling with sequential writes, bounded batches, heartbeat, disconnect cleanup and shutdown. Run tests and `npm run typecheck`.

## Task 3: Live console (delegate)

Files: public/index.html, public/styles.css, public/app.js.

- [x] Build responsive Chinese operator console for the API contract, with in-memory token, filters, history, streamed updates, reconnect, pause/resume, detail and export. Render log text via textContent.
- [x] Manually validate browser connection, live event, filters, reconnect and narrow viewport against the running server.

## Task 4: Deployment and terminal example (delegate)

Files: Dockerfile, compose.yaml, .dockerignore, .gitignore, .env.example, README.md, examples/remote-logger.ts, examples/nginx.conf.

- [x] Provide non-root multi-stage image, named SQLite volume, required environment keys, healthcheck and restart policy.
- [x] Provide standalone uni.request reporting example with timeout and bounded queue; never reuse business auth or swallow application errors. Document exact copy/integration points from terminal inspection.
- [x] Document local development, server deployment, cross-architecture image build/export, curl checks and reverse proxy SSE settings.

## Task 5: Review and delivery

- [x] Run `npm test`, `npm run typecheck`, `npm run build` and actual HTTP smoke against compiled service.
- [x] Review requirements and security/correctness using an independent agent; resolve actionable findings and rerun affected checks.
- [x] Complete Linux Docker build, container smoke and deployment archive export. Verified non-root UID, assets, authentication, ingestion, SSE, volume persistence across restart and clean shutdown; Compose configuration is valid. Exported and inspected printer-logcat-deploy-amd64.tar.gz (linux/amd64, current image, no actual secrets).

Deployment correction: The archive workflow above is historical and has been superseded by 2026-10-27-registry-compose-deployment.md at the user's request. Current delivery is standalone docker-compose.yaml with a GHCR image; the archive and packaging script were removed.

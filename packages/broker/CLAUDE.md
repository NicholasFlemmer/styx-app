# @styx/broker

The local grant broker agents talk to. Two faces: a Unix socket / named pipe NDJSON JSON-RPC protocol (`protocol.ts`) and a stdio MCP server (`mcp-stdio.ts`) exposing `request_access`, `check_grant`, `get_credential`, `list_targets`, `ask_user`, `report_status`.

- Messages are zod-validated and versioned (`v: 1`). Reject unknown versions.
- The broker never holds secrets; main mints credentials and hands the broker only env bundles / socket paths with expiry.
- Every request carries `sessionId` (from `STYX_TOKEN` auth) and, for shims, the triggering `argv` for audit.
- One requested grant per session at a time; further requests queue (spec §1). Expiry timers live in main.
- Tests: protocol round-trip, queueing, revoke propagation with a fake main. Never test against real providers.

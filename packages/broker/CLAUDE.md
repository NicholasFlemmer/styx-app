# @styx/broker

The local broker agents talk to. Two faces: a Unix socket / named pipe NDJSON JSON-RPC protocol (`protocol.ts`,
`server.ts`, `client.ts`) and a stdio MCP server (`mcp-stdio.ts`, run as `styx mcp`) exposing `request_access`,
`check_grant`, `get_credential`, `list_targets`, `ask_user`, `report_status`, `list_sessions`, `project_activity`,
`send_message`, `remember_command` and `land`. Main answers every call in `apps/desktop/src/main/broker/host.ts`.

- Messages are zod-validated and versioned (`v: PROTOCOL_VERSION`). Reject unknown versions.
- The broker never holds secrets; main mints credentials and hands over only env bundles / socket paths with expiry.
- Clients authenticate from `STYX_BROKER` / `STYX_SESSION_ID` / `STYX_TOKEN`; a connection is bound to one session
  after `hello`. Shims send the triggering `argv` for audit (`exec_authorize`).
- Grant-creating calls and `ask_user` are rate-limited per session; expiry timers live in main.
- Tests: protocol round-trip, queueing, rate limits, revoke propagation with a fake main. Never test against real
  providers.

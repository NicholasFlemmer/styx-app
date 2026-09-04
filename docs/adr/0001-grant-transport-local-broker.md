# ADR-0001 Grant transport is a local broker (MCP + CLI shims)

Status: accepted · 2026-09-04

The UX memo left open how agents request access. Decision: main runs a JSON-RPC broker on a per-user Unix socket / named pipe. Agents reach it through (a) a `styx mcp` stdio MCP server auto-injected into each CLI's MCP config (Claude Code `--mcp-config`, Codex `-c mcp_servers…`, Gemini `.gemini/settings.json`, cursor-agent `.cursor/mcp.json`) and (b) the `styx` CLI plus provider shims (`vercel gh aws gcloud supabase ssh`) prepended to the session PATH, which call `exec_authorize` and exec the real binary with injected credentials. Output-sniffing of failed auth is not implemented in v1.
Consequences: deterministic, auditable (captures the triggering command), works for shell sessions; agents that bypass the shims simply get "not logged in".

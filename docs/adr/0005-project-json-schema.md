# ADR-0005 `.styx/project.json` v1 schema

Status: accepted · 2026-09-04
Committed, secret-free, `version: 1`. Targets are identified across machines by `(provider, env, name)` with non-secret `config` and an optional `policy` override; `agents` defaults; `policies.extra`; `worktrees` base/prefix/location; `shell.windows`; `lineEndings`; `env.files`. `credentialRef`, `health`, IDE fallback and window state are machine-local (SQLite). Unknown keys are preserved on rewrite; validated by zod (`packages/core/src/project-file.ts`); keys present in the file win over app settings and are marked `source: 'project'`.

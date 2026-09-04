# ADR-0007 Secrets live only in the OS keychain

Status: accepted · 2026-09-04
`@napi-rs/keyring` (N-API; macOS Keychain / Windows Credential Manager). SQLite stores `credential_ref = styx:v1:<provider>:<targetId>:<kind>` only. Electron `safeStorage` rejected (stores blobs in our files). `MemoryVault` in tests/dev (`STYX_KEYCHAIN=memory`).

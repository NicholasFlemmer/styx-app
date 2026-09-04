# ADR-0004 WSL is optional on Windows

Status: accepted · 2026-09-04
Windows sessions default to PowerShell; `.styx/project.json` `shell.windows: "wsl"` switches the pty shell only. No WSL path translation guarantees in v1.

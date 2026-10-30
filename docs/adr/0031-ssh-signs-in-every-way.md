# ADR-0031: SSH targets sign in every way ssh does

- Status: accepted (owner, 2026-10-30: "ssh must allow for passphrases and anything else. it must be the most flexible")
- Context: people could not reach their servers through Styx. Two causes, from a customer's verbose ssh log: the
  shim ran the agent's `ssh <host>` unchanged, so ssh used the local login name and port 22 instead of the target's
  saved user and port; and SSH targets only signed in with a key file, while many hosting accounts (cPanel and
  similar) take a password.

## Decision

1. **Every grant carries an ssh_config.** The SSH adapter writes one per grant (0600, beside the agent socket,
   removed when the grant ends): a `Host <host>` block with the target's `User`, `Port`, `StrictHostKeyChecking
accept-new`, the jump host when there is one, and the way it signs in; then `Match all` and the person's own
   `~/.ssh/config` and `/etc/ssh/ssh_config`, so every other host behaves as before. The shim passes it as `-F` to
   `ssh`, `scp` and `sftp`; git and rsync get it through `GIT_SSH_COMMAND` and `RSYNC_RSH`. Anything the agent passes
   itself (`-p`, `user@`) still wins. `scp`, `sftp` and `rsync` get shims of their own: before, they bypassed Styx.
   Host, user and jump host must be plain names (a repo-authored target could otherwise add `ProxyCommand`).
2. **Three ways to sign in**, chosen on the connect form:
   - **Key file** (with a passphrase when the key has one): unchanged. The key is served by an in-process agent on a
     socket for the grant's lifetime; the agent never gets the key file or the passphrase.
   - **Password**, kept in the keychain with the address it was saved for (`user@host:port via jump`). When a grant
     is issued, Styx signs in itself: main runs the system ssh by absolute path as an OpenSSH master (`-M`) in a
     terminal only main can see, with no config files (`-F none`; an agent can edit `~/.ssh/config`), no keys, no
     banners (`LogLevel ERROR`) and `ProxyCommand none`. It types the password once, and only at the target's exact
     prompt (`user@host's password:` or `(user@host) Password:`; a bare `Password:` only without a jump host), so a
     jump host or banner cannot word its way into receiving it. The server's host key is pinned in the keychain on the
     first sign-in and required after it. Sign-in counts as done when `ssh -O check` says so. The grant's config points
     every agent command at that connection (`ControlPath`, `ControlMaster no`, password sign-in off,
     `IdentityAgent none`), so the agent's `ssh`, `scp`, `sftp`, `rsync` and git ride it and never meet the password.
     Revoke runs `ssh -O exit` and kills the terminal. A target whose address no longer matches the saved one (an
     accepted project.json, an edited database) refuses to sign in until the person reconnects. A grant revoked or
     denied while its sign-in runs stays ended; the new connection is closed.
     (A first version handed ssh a one-time code redeemable through `SSH_ASKPASS`; review showed the agent, which
     holds its own session's broker credentials, could redeem it itself or aim ssh at a server it chose.)
   - **My SSH setup**: nothing is stored. ssh uses the person's own agent and config (1Password, hardware keys,
     certificates, keys already in `~/.ssh`). The grant still gates and audits every command through the shim.
3. **Jump host** (`ProxyJump`, one or more `user@host:port`) works with all three.
4. **Test connection** runs the same path an agent will: it issues a throwaway grant (for a password, its master
   connection) and runs `ssh -F <config> -o BatchMode=yes <host> 'exit 0'`. A server that offers only passwords to a
   key target says so, with how to add the key.
5. **Address changes are re-points.** An accepted `.styx/project.json` that changes a connected SSH target's user,
   host, port or jump host is audited and ends its grants; a jump host the connect form did not show never survives a
   reconnect.

## Trade-offs

- A password is weaker than a key only in where it lives: the keychain and, briefly, main's memory while it signs in.
  The agent can use the connection for the grant's lifetime, as it can a key's socket, but never learns the
  password. SSH grants are unscoped (`issuesScoped` false), so production SSH always needs the OS check first.
- The first password sign-in trusts the server's host key (usually while the person watches Test connection);
  someone in the network path at that moment could take the password. Every later sign-in requires that key.
- Accepted: agents run as the person's own user, so any agent, in any lane, can connect to any open grant's socket
  (key agent or control socket) in the private 0700 directory. This was already true of key sockets; a real fix
  needs agents under another user or a sandbox.
- "My SSH setup" gives the agent nothing it could not already reach by running the real ssh by its full path; it
  adds the gate and the audit trail.
- `accept-new` trusts a host's key the first time, as an agent cannot answer the prompt; a changed key still fails.

## Not in this decision

- Prompts other than the password (one-time codes, "Verification code:"): Styx stops the sign-in and says what the
  server asked. Answering them from Styx's UI needs a prompt that never lands in the transcript.
- Password sign-in on Windows: its OpenSSH has no ControlMaster, so the form does not offer it there and connect
  refuses it. Key files and own setup work on every platform.

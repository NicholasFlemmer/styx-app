# Security policy

Styx holds the keys to people's deploy targets and servers, so security reports get priority over everything
else.

## Reporting a vulnerability

Please report it privately, not in a public issue:

- **GitHub:** use **Report a vulnerability** on the repository's Security tab, or
- **Email:** hello@heystyx.com, with "Security" in the subject.

Include what you found, how to reproduce it, and what an attacker could do with it. A proof of concept helps but
isn't required.

What to expect:

- an acknowledgement within 3 working days;
- an assessment, and a fix plan for anything confirmed, within 14 days;
- credit in the release notes once a fix ships, if you'd like it.

Please give us a reasonable chance to release a fix before disclosing publicly.

## What's in scope

Anything that breaks the promises Styx makes about access and secrets, for example:

- an agent getting a credential, token or SSH key without an approved grant, or keeping it after the grant ends;
- secrets reaching the SQLite database, logs, IPC messages, renderer state or project files;
- a way to bypass Touch ID or Windows Hello for production deploys, writes or deletes;
- editing or deleting audit log entries without detection;
- the renderer gaining file system, process, network or keychain access;
- weaknesses in the access broker (`packages/broker`), the `styx` CLI shims, or sign-in.

Out of scope: problems in the agent CLIs or cloud providers themselves (report those to their vendors), attacks
that need someone already running code as you on your machine, and missing hardening headers on heystyx.com
with no demonstrated impact.

## Supported versions

Fixes go into the latest release. Styx updates itself, so please check you are on the newest version before
reporting.

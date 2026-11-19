# Aider approval investigation (issue 18)

Research for [issue 18](https://github.com/NicholasFlemmer/styx-app/issues/18), following
[the maintainer's request](https://github.com/NicholasFlemmer/styx-app/issues/18#issuecomment-6346960433).
This contains an offline reproduction and requirements for further discussion. It does not register
Aider as a Styx agent or change any permission mode.

## Constraint

The [agent contribution guide](../../contributing/adding-an-agent.md#security-rules) requires
Styx's Default mode to ask before edits and commands. Aider's confirmation when adding a file to chat
does not provide approval for each subsequent edit. Disabling automatic answers alone therefore
cannot establish this guarantee.

These are observations about Aider's existing configuration and editing semantics, not a claim that
Aider promises Styx's permission model. Styx needs an adapter or upstream capability that can enforce
its own contract.

## Run the reproduction

Use Python 3.11 and an isolated environment with the released package. From the repository root, with
[uv](https://docs.astral.sh/uv/) installed:

```sh
uv run --isolated --no-project --python 3.11 --with aider-chat==0.86.2 python -I docs/research/aider-approval/reproduce.py
uv run --isolated --no-project --python 3.11 --with aider-chat==0.86.0 python -I docs/research/aider-approval/reproduce.py
```

Alternatively install either exact `aider-chat` version into a fresh Python 3.11 virtual environment
with pip, and run the same script using that environment's Python. Aider pins its dependencies; the
script also checks ConfigArgParse 1.7.1 and prints the package versions. Dependency installation needs
network access. The reproduction supplies no provider credentials and makes no model calls.
Run it separately from `pnpm test`; the existing Styx test scripts and CI do not execute this Python file.

The script uses a temporary home and working directory, clears inherited environment variables except
OS executable lookup settings, and rejects Python socket `connect`/`connect_ex` calls. Config files
and edited files are disposable fixtures. Existing user and project configuration is not modified.

Passing tests mean the documented behaviors were reproduced, **not** that an integration meets Default's
approval guarantees. Unexpected behavior or an unsupported Aider/ConfigArgParse version exits nonzero.

### Recorded runs

Verified on 2026-10-22, Windows, CPython 3.11.9:

| Aider  | ConfigArgParse | python-dotenv | Result          |
| ------ | -------------- | ------------- | --------------- |
| 0.86.0 | 1.7.1          | 1.1.1         | 11 tests passed |
| 0.86.2 | 1.7.1          | 1.2.1         | 11 tests passed |

Each run includes all six configuration cases and all five file-edit cases below. No live model or
provider authentication was exercised. Other operating systems have not been checked locally.

## Configuration cases

The tests use Aider's real argument parser and dotenv-loading function. `None` below is the parser's
unset/default value for `yes_always`; it does not enable automatic confirmation.

| Case                                                                                   | Observed `yes_always`     |
| -------------------------------------------------------------------------------------- | ------------------------- |
| No configuration or environment override                                               | `None`                    |
| `AIDER_YES_ALWAYS=false`, no YAML setting                                              | `None`                    |
| Launch environment says false, then Aider loads a dotenv file saying true and reparses | `True`                    |
| YAML `yes-always: true` plus environment false                                         | `True`                    |
| The preceding case plus explicit `--config private.yml` containing `yes-always: false` | `True`                    |
| Explicit `--no-yes-always`                                                             | Argument rejected, exit 2 |

The false environment value is represented by no command-line argument for this `store_true` option;
it does not pin a negative value against another loaded true setting. The dotenv test uses an explicit
`--env-file project.env` fixture through the same loader used by normal startup, then repeats the
startup parse. It does not run Aider's complete CLI startup or reproduce every configuration search path.

## Files already in chat

The tests instantiate the real `EditBlockCoder` and `InputOutput`, supply a deterministic
SEARCH/REPLACE response, and call `apply_updates()`. This exercises response parsing, the preflight,
`prepare_to_edit()`, `allowed_to_edit()`, and the actual file write. Model metadata, analytics and the
unused summarizer are substitutes; permission checks and editing functions are not replaced.

`InputOutput.yes` is `None`, so automatic confirmation is not enabled. Only interactive keyboard input
is supplied by the test, answering `n` except for the explicit admission-approval control.

| Case                                                                                        | Confirmation calls               | Actual result       |
| ------------------------------------------------------------------------------------------- | -------------------------------- | ------------------- |
| Existing file supplied in `fnames` (already in chat), input prepared to answer `n`          | 0                                | File changes        |
| Existing file outside chat, answer `n`                                                      | 1                                | File unchanged      |
| Existing file outside chat, answer `y`; then another edit with input prepared to answer `n` | 1 initially, 0 for the next edit | Both edits apply    |
| New file, answer `n`                                                                        | 1                                | File is not created |
| Already-in-chat file with dry-run on both coder and IO                                      | 0                                | File unchanged      |

The early return for an already-in-chat file happens before the confirmation branch. The admission
prompt for a file outside chat adds it to the editable set, so another edit gets the early return too.
This is independent of the configuration precedence finding: it reproduces with `yes=None`.

Dry-run prevents this write, but also prevents approved edits from being applied. It is a useful
control, not a working Default-mode adapter.

## Evidence and limits

The source locations to review in each exact release are:

- [Aider 0.86.0 argument definition](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/args.py),
  [startup/dotenv handling](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/main.py),
  [edit approval and update pipeline](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/coders/base_coder.py),
  [SEARCH/REPLACE writes](https://github.com/Aider-AI/aider/blob/v0.86.0/aider/coders/editblock_coder.py).
- [Aider 0.86.2 argument definition](https://github.com/Aider-AI/aider/blob/v0.86.2/aider/args.py),
  [startup/dotenv handling](https://github.com/Aider-AI/aider/blob/v0.86.2/aider/main.py),
  [edit approval and update pipeline](https://github.com/Aider-AI/aider/blob/v0.86.2/aider/coders/base_coder.py),
  [SEARCH/REPLACE writes](https://github.com/Aider-AI/aider/blob/v0.86.2/aider/coders/editblock_coder.py).

The harness isolates the edit pipeline without a Git repository, a live model, a terminal session or
Styx. It does not cover other edit formats, architect mode, shell execution, provider authentication,
concurrent edits, or runtime configuration changes. No conclusion about command approval is derived
from these file-edit tests.

## Requirements to explore together

Before implementing Default, an adapter or upstream change needs to support:

1. A supported way to enforce per-session approval policy despite saved YAML/dotenv configuration.
   A negative `yes-always` flag could address part of the configuration problem, but would not add
   per-edit confirmation for already-in-chat files.
2. A blocking decision before each proposed write, including files already in chat and repeated
   edits after a file-admission approval. Denial must leave the file unchanged. Approval should apply
   only to the operation presented, with stale-content handling defined.
3. A supported machine-readable request/response or equivalent enforceable interception point so
   Styx can present the decision and wait before writes. Prompt text and filesystem watchers do not
   establish that ordering; detecting a completed write is too late.
4. Separate investigation and tests for command execution, additional edit formats and mode changes.

The proposed next step is to agree on that boundary with the maintainer and Aider upstream, then add
contract tests for a candidate approach. This draft does not relax Default or choose an implementation.

# User simulation · design-deploy

Run 2026-09-22T07:40:12.869Z · 52/52 steps passed · 35 s · fixture `demo`, STYX_NOW 1773308580000, fake CLIs on PATH, no STYX_E2E.

## Findings

### 1. [minor] Reconnect / Edit of a key target cannot test the stored credential without retyping name, key and secret

- Repro: Settings › Targets · AWS acme-prod · Edit
- Expected: Test connection works on the saved credential (the row exists; the vault has the key); Save only needs what changed
- Observed: Advanced (IAM / key) opens with empty Name / Access key / Secret; Test connection disabled=true, Save disabled=true
- Where: apps/desktop/src/renderer/features/modals/ConnectModal.tsx canSaveKey = keyFormValid(key) gates both buttons

## Steps

| # | Step | Result | Note |
| --- | --- | --- | --- |
| 1 | Design tab opens on the empty state | ok (136 ms) | browser intercept armed |
| 2 | a non-local URL is refused with the local-only copy | ok (50 ms) | refused; nothing saved; field keeps the text |
| 3 | localhost:3999 with nothing listening shows the waiting notice (no Run locally yet) | ok (122 ms) | Waiting for http://localhost:3999/… · The page opens as soon as the server answers. |
| 4 | a non-local URL typed over a saved local one: what does the person see? | ok (669 ms) | notice shown |
| 5 | Open in browser hands the URL to the OS (intercepted) | ok (32 ms) | http://localhost:3999/ |
| 6 | agents detected; Codex is the project default | ok (1568 ms) | codex 0.154.0 (fake) |
| 7 | first time: the run row has a hint and a button, no command field | ok (19 ms) | Set up and start this project locally. Codex works out how. |
| 8 | clicking Run locally hands the job to a hidden task; the row and the dialog say so | ok (135 ms) | dialog "Run locally · acme-shop" · status "Starting…" |
| 9 | the fake agent finishes without teaching Styx: what the person is told | ok (263 ms) | Finished, but nothing was learned · asked for approval: yes (fake artefact) · learned: null |
| 10 | Stop task ends a running learn-run cleanly | ok (299 ms) | status "Stopped" |
| 11 | a learned command fills the field; the waiting notice now offers Run locally | ok (34 ms) |  |
| 12 | Run locally from the notice: strip, phase, URL, status bar, the page renders, strip folds | ok (1365 ms) | Running · http://localhost:3999 · view 440×471 |
| 13 | Output toggle reopens the strip and shows the process output | ok (119 ms) | server line visible in the strip |
| 14 | Reload keeps the page | ok (41 ms) |  |
| 15 | Phone preset: 393px viewport inside a drawn frame; Rotate swaps; Tablet 834; Desktop frees it | ok (295 ms) | phone 393@0.47 · landscape 852 · tablet 834@0.37 · desktop 440@1.00 |
| 16 | the native view leaves the screen under the palette and comes back | ok (27 ms) |  |
| 17 | the deploy picker (a DOM menu) is not covered by the native design view | ok (43 ms) | clear |
| 18 | Stop ends the run: Exited, status bar clears, port free; Dismiss removes the strip | ok (947 ms) | Exited · code 0 |
| 19 | a failing command: Exited · code 1, "Ask Codex to fix it" starts a fix task | ok (643 ms) | Exited · code 1 → "Ask Codex to fix it" → task started and stopped |
| 20 | a command with a port flag is kept as typed (`npm run dev -- -p 3999`) | ok (54 ms) | settings + .styx/project.json agree |
| 21 | blog-v2 keeps its own URL and run state; acme-shop keeps its own | ok (176 ms) | independent |
| 22 | an Expo repo: Runs on chips (iOS · Android · Web), iOS remembered, the fake simulator listed | ok (448 ms) | chips iOS · Android · Web · devices Any device \| iPhone 17 Pro · iOS 26.5 |
| 23 | Run on iOS: Booting iPhone 17 Pro… → Mirroring · screenshots; frames arrive; status bar; no-input row | ok (3122 ms) | Booting iPhone 17 Pro… → "Mirroring · iPhone 17 Pro · no picture" · mirror=screenshots · run "Running · iOS" · Install idb (brew install idb-companion) to tap and type here; until then, open the simulator. · (no screen-access row) |
| 24 | Open the simulator is a no-op on this Mac (fake `open`) and stays honest | ok (340 ms) |  |
| 25 | Stop simulator leaves the run alive; the run row still says Running · iOS | ok (341 ms) | simulator booted · run "Running · iOS" |
| 26 | Run again then Shut down: the simulator is shut down; Stop ends the run | ok (2669 ms) | shutdown; run stopped |
| 27 | Android reads as not installed, with the hint | ok (197 ms) | android hint ok; back to Web |
| 28 | the mode strip deploy button names the prod targets; the picker lists all three | ok (30 ms) | Vercel prod · Supabase prod (learn) · AWS acme-prod prod (learn) |
| 29 | Deploy · Vercel prod (policy ask-mfa, MFA auto): the modal, the phase, the outcome, the audit | ok (176 ms) | failed · "Deploy · Vercel prod Deploy failed vercel not found on PATH Close" · audit granted(you, Deploy from Styx), requested(system, Deploy from Styx), used(agent, $ vercel deploy --prod), granted(you, grant sheet) · app grants active |
| 30 | the failure is reported outside the modal too (toast / status bar) | ok (3117 ms) | toast none · status bar "fix/checkout · Vercel prod · open 58m · Supabase · locked · Monaco · LF · TS · Ln 1, Col 1" |
| 31 | Targets: policy select Always allow on Vercel prod, then deploy again — how the grant honours it | ok (461 ms) | failed · "Deploy · Vercel prod Deploy failed vercel not found on PATH Close" · new audit used, granted |
| 32 | Deploy · Supabase prod (no command): the first deploy goes to a task; the button reports it | ok (375 ms) | Finished, but nothing was learned · learned deployCommand null · approval asked yes (fake artefact) |
| 33 | Deploy setup: per-target commands, built-in Vercel, save, reset | ok (355 ms) | placeholders supabase db push \| aws deploy … or sam deploy \| gh workflow run deploy.yml |
| 34 | a remembered custom command is shown in the Deploy modal before it runs (Supabase, policy ask) | ok (163 ms) | Deploy command supabase db push · failed · "Deploy · Supabase prod Deploy command supabase db push Deploy failed exit 127 Close" |
| 35 | palette: deploy rows carry the lock state in their meta | ok (413 ms) | Deploy acme-shop → Vercel prod \| open · 58m \| Deploy acme-shop → Vercel preview \| Deploy acme-shop → Supabase prod \| locked \| Deploy acme-shop → AWS acme-prod prod \| locked \| Deploy acme-shop → GitHub acme/shop scm |
| 36 | Targets table: name / env / policy / state / action for the five fixture targets | ok (101 ms) | 000001: Vercel / prod / Ask · MFA / Ask each time / Always allow / open · 58m left / Revoke / Remove [policy ask-mfa] \|\| 000002: Vercel / preview / Ask · MFA / Ask each time / Always allow / persistent / Edit / Remove [policy always] \|\| 000003: Supabase / prod / Ask · MFA / Ask each time / Always allow / locked / Edit / Remove [policy ask] \|\| 000004: AWS acme-prod / prod / Ask · MFA / Ask each time / Always allow / locked / Edit / Remove [policy ask-mfa] \|\| 000005: GitHub acme/shop / scm / Ask · MFA / Ask each time / Always allow / persistent / Edit / Remove [policy always] |
| 37 | Revoke on Vercel prod locks it and is audited | ok (11373 ms) | locked · audited |
| 38 | Edit on the AWS key target reopens the key form — and Test / Save need the key retyped | ok (157 ms) | Connect target · IAM / key · Test disabled=true · Save disabled=true |
| 39 | Escape in the Connect target modal: does it close (handoff: Escape closes any overlay)? | ok (444 ms) | closes |
| 40 | provider grid: six tiles with their method labels; Tab stays inside the modal | ok (70 ms) | Vercel OAuth · AWS IAM / key · GCP IAM / key · Supabase OAuth · GitHub OAuth · SSH host SSH |
| 41 | Connect · vercel: CLI-first step without the CLI, env chips, Advanced form and its validation | ok (1073 ms) | Connect target · vercel CLI · vercel · not found on PATH · installed=false · advanced=oauth · Open browser → opened 2 · placeholder target none |
| 42 | Connect · aws: CLI-first step without the CLI, env chips, Advanced form and its validation | ok (233 ms) | Connect target · aws CLI · aws · not found on PATH Install guide · installed=false · advanced=key · key form validates (not saved: Save would call the provider) |
| 43 | Connect · gcp: CLI-first step without the CLI, env chips, Advanced form and its validation | ok (181 ms) | Connect target · gcloud CLI · gcloud · not found on PATH Install guide · installed=false · advanced=key · key form validates (not saved: Save would call the provider) |
| 44 | Connect · supabase: CLI-first step without the CLI, env chips, Advanced form and its validation | ok (166 ms) | Connect target · supabase CLI · supabase · not found on PATH Install guide · installed=false · advanced=oauth · OAuth form (not clicked: GitHub device flow / Supabase would leave the machine) |
| 45 | Connect · GitHub with the fake gh: signed-in account, name, env, Connect → a live CLI target | ok (442 ms) | refused by github.com as expected without a network fake: "provider-error Styx · now gh: fake gh: auth token --hostname github.com --user fake is not supported" · placeholder target 01M340XNQFR6RSZHBRCJYA96T8 (unconnected) |
| 46 | Refresh (health) and Edit on the CLI target: the login terminal runs `gh auth login` inline | ok (27 ms) | GitHub sim stayed a placeholder (github.com refused the fake token): Refresh / Edit not exercised here |
| 47 | Connect · SSH: validation (empty, bad port), Save to a refused loopback port, the resulting row | ok (174 ms) | 127.0.0.1 / prod / Ask · MFA / Ask each time / Always allow / expired / Edit / Remove · health "expired" · config keys host,user,port |
| 48 | Remove a target: is there a way in the UI? (falls back to the command) | ok (158 ms) | UI has Remove |
| 49 | Env & secrets: source, share with agents (change + reset), committed file | ok (138 ms) | options Per grant/Always/Never · rows: .env source Keychain \| Share with agents Per grant Always Never \| Committed file .styx/project.json |
| 50 | .styx/project.json is committed-safe: no secret-like keys, no fixture tokens | ok (0 ms) | keys $schema,version,name,agents,dev · dev {"url":"http://localhost:3999","command":"node -e \"setInterval(()=>{},1000)\"","platform":"web","device":"iPhone 17 Pro"} · 0 targets (credentialRef only) |
| 51 | 1100×680: the design bar and run row fit; nothing overflows | ok (522 ms) | fits |
| 52 | cleanup: no runs, devices or tasks left; port 3999 free | ok (637 ms) | clean |

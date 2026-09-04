---
paths: ['**/*.css', '**/*.tsx']
---

# Token rules for CSS and TSX styling

- Colours: only `var(--bg|--s1|--s2|--ln|--tx|--mu|--ac|--acx|--act|--add|--term|--termtx|--dim)`. `--act` is accent-as-text (safe on light); never use `--ac` as text on light.
- Fonts: `var(--font-ui)` / `var(--font-mono)`. Type recipes: `.t-label .t-label-strong .t-mono .t-meta .t-body .t-code` from `@styx/ui/styles/type.css`.
- Sizes: `--h-titlebar --w-rail --w-nav --w-files --w-chat --w-sheet --w-drawer --w-policies --w-settings-nav --h-tabrow --h-hunkbar --h-terminal --h-statusbar --w-palette --w-modal-connect --w-modal-spawn --w-toast`; spacing `--sp-1..--sp-10`.
- `border-radius: 0` everywhere (the only exception is macOS traffic lights, which are native). No `box-shadow`, no gradients, no hover transitions.
- Selection: `data-inv="true"` inverted (current), `data-on="true"` accent (attention/armed). Never `.active`/`.selected` classes.
- Motion: `animation: styx-sheet-in var(--motion-sheet) var(--ease-sheet)` / `styx-modal-in var(--motion-modal) ease-out` / `styx-toast-in var(--motion-toast) ease-out`; reduced-motion handled by `@styx/tokens/css/motion.css`.
- Floating surfaces: `border: 1px solid var(--tx)`; modal/palette backdrop `background: var(--dim)`.

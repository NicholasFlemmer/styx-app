# @styx/website

The marketing site for Styx. Next.js 16 (app router, static export), plain CSS Modules on top of the app's own
tokens from `@styx/tokens`. Research, design plan and the rationale for every choice are in `DESIGN.md`.

```sh
pnpm -F @styx/website dev        # http://localhost:3100
pnpm -F @styx/website build      # static export to apps/website/out
pnpm -F @styx/website typecheck  # next typegen + tsc
pnpm test --project website      # lib + component tests
```

## Configuration

Links that do not exist yet default to page anchors. Set these when the artefacts exist:

| Variable                   | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`     | Canonical origin for metadata, sitemap and robots.   |
| `NEXT_PUBLIC_DOWNLOAD_MAC` | macOS build URL (dmg / zip). Windows is shown as coming soon. |

The version shown in the download section is read from `apps/desktop/package.json` at build time.

## Rules

- Colors, sizes and motion come from `@styx/tokens/css/tokens.css` and `motion.css`, verbatim. No raw hex.
- Product strings match `packages/core/src/copy.ts` so the site and the app say the same things.
- The accent is a state, not decoration: it marks what asks for the visitor (the primary call to action, needs-you
  dots, the grant button).
- Global classes (`btn`, `tag`, `sq`, `label`, `mono`, `wrap`, `section`) live in `app/globals.css`; inside CSS
  Modules reference them with `:global(...)`.

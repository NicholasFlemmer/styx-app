# Handoff discrepancies

Log of places where `Styx.dc.html` (visuals win) and `Styx Spec.dc.html` (behaviour wins) disagree, and how they were resolved.

| #   | Where             | Prototype       | Spec                 | Resolution        |
| --- | ----------------- | --------------- | -------------------- | ----------------- |
| 1   | `data-theme` host | set on `<body>` | README says `<html>` | `<html>` (README) |
| 2 | Settings nav items | weight 400 | inventory says "font-weight 500" for NavItem | `NavItem dense` uses 400 (prototype wins) |
| 3 | Modal footer buttons | content-sized `14px 20px` / CTA `14px 24px` | Button `footer` size is `flex:1; padding:14px` | Modal overrides direct button children; Sheet/Drawer keep `flex:1` |
| 4 | `LabelValueRow` reset affordance | not shown anywhere | spec §4.6 "project values that override app defaults show a reset affordance" | ghost compact `Reset` button (spec wins) |
| 5 | Info banner | only the error banner exists | spec §8 lists `info` tone with `--ln` square | implemented per spec |
| 6 | Composer `Model ▾` | plain span | UI rule: chevrons are SVG | button with `aria-haspopup=menu` + chevron Icon |
| 7 | Board column label | 700/10px/.1em, transparent border, `data-on` when hot | inventory Tag tones don't include "transparent border" | `Tag tone="strong" size="md"` + screen-level transparent border |
| 8 | "+ Spawn agent" button | `padding:10px` dashed | Button sizes are compact/regular/hunk/footer | screen-level padding override |
| 9 | Card text baseline | fractional line boxes (13px × 1.4) | — | Electron vs Chromium rounding gives a 1px offset; not fixable without inventing line-heights |

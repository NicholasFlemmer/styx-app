# ADR-0030: The Design canvas is freeform (amends ADR-0028)

- Status: accepted (owner, 2026-10-13)
- Context: owner report, "On Styx design, all the designs get laid out vertically, you can't move them around, and you
  can't zoom using a touchpad or mouse." Mockup `design/next/design-canvas-freeform.html`; discrepancy row 163.

## Decision

1. **The Design tab is a stage, not a scrolling column** (amends ADR-0028 §3). Boards sit on an unbounded canvas
   that is translated by the pan and scaled by the zoom (`screen = canvas × zoom + pan`; the geometry is pure, in
   `packages/core/src/selectors/design-canvas.ts`). Zoom goes toward the pointer: trackpad pinch (wheel + ctrlKey),
   Ctrl/⌘ + wheel, Mod+= / Mod+−, Mod+0 to fit, and Mod+1 for 100% while the canvas has focus (elsewhere Mod+1
   still opens the first lane). Range 10–400%. Pan with the wheel or two fingers (Shift + wheel sideways), Space +
   drag, middle-button drag, or a drag on empty canvas. Frames never take a pan or zoom gesture: with Select off, or
   while panning, a shield covers them; with Select on, a wheel or middle press inside a frame is handed to the canvas.
2. **Boards move by their names.** The name above a board is its handle (a button: drag it, or arrow keys 8px, Shift
   40px); positions snap to an 8px grid; Mod+Z undoes a move or Tidy up. Names keep their size on screen at every
   zoom and read "Screen Size · Fidelity"; the row headings go, since a board can leave its row.
3. **Today's rows are the default and Tidy up.** The first open lays boards out as before (one row per screen;
   desktop, tablet, phone; wireframe before hi-fi) at 33%. **Both** joins Wireframe / Hi-fi and is the default, so a
   wireframe sits beside its hi-fi; filters hide boards in place, never re-flow them.
4. **The layout is the project's; the view is the person's.** Positions are saved in `.styx/designs/canvas.json`
   (`version: 1`, `boards: { "<screen>/<file>": { x, y } }`, canvas px; zod-validated in core like
   `.styx/project.json`), written only through `design.setLayout` with the same no-link, no-hard-link write rules as
   a screen, debounced after a move. It is committed and landed with the design folder, so the layout travels with
   the repo. A missing, linked or invalid file means the default rows. Moving boards is not a design change: build
   tasks are not told. Zoom and pan live in the renderer's ui-store, keyed by worktree.
5. **Agent-added boards never land on others.** Once a layout is saved, a board with no position is placed by
   `placeBoard`: right of its screen's rightmost board, or a new row under the lowest one, then right past anything it
   would touch. The placement is saved, the view does not jump, and a notice offers **Show it**.

## Consequences

- Select and area select read positions inside a frame in the page's own pixels, so a pick is the same at any zoom
  or pan; the picture sent to the agent is cut to the visible canvas.
- Board heights come from each frame's page, so a saved layout can overlap when a screen grows taller; Tidy up
  restores the rows.
- Zoom and fit change at once: there is no animated zoom, so reduced motion needs nothing more.
- Keyboard: a board's name is a button (Tab to it; the canvas pans it into view; arrows move it and a polite live
  region says where to). Picking an element or an area inside a screen is still pointer-only, and V stays a
  single-key toggle while the Design tab is up, both as before this decision.

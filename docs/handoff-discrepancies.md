# Handoff discrepancies

Log of places where `Styx.dc.html` (visuals win) and `Styx Spec.dc.html` (behaviour wins) disagree, and how they were resolved.

| #   | Where             | Prototype       | Spec                 | Resolution        |
| --- | ----------------- | --------------- | -------------------- | ----------------- |
| 1   | `data-theme` host | set on `<body>` | README says `<html>` | `<html>` (README) |

-- Agent connections (Settings › App › Agents): each CLI is verified once — who it is signed in as, when that was
-- checked and why a check failed — and spawned per project from that connection. Never a token: the CLI keeps
-- its own credentials. Plain ADD COLUMN, since none of these carry a CHECK.
ALTER TABLE cli_installs ADD COLUMN account TEXT;
ALTER TABLE cli_installs ADD COLUMN verified_at INTEGER;
ALTER TABLE cli_installs ADD COLUMN verify_error TEXT;

-- Two more editors Styx can detect and hand files to: Windsurf (a VS Code fork, same config layout) and Zed.
-- SQLite cannot widen a CHECK in place, so the table is rebuilt (same recipe as 0002).
CREATE TABLE ide_installs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('vscode','cursor','windsurf','zed','jetbrains','neovim')),
  product TEXT,
  version TEXT,
  location TEXT NOT NULL,
  launcher TEXT,
  config_dir TEXT,
  is_fallback INTEGER NOT NULL DEFAULT 0,
  imported_json TEXT NOT NULL DEFAULT '{}',
  detected_at INTEGER NOT NULL,
  UNIQUE (kind, product)
);
INSERT INTO ide_installs_new (id, kind, product, version, location, launcher, config_dir, is_fallback, imported_json, detected_at)
  SELECT id, kind, product, version, location, launcher, config_dir, is_fallback, imported_json, detected_at
  FROM ide_installs ORDER BY rowid;
DROP TABLE ide_installs;
ALTER TABLE ide_installs_new RENAME TO ide_installs;

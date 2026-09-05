-- targets.auth_method gains 'cli' (connect with the provider's own CLI: gcloud / aws / gh / vercel / supabase).
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt (sqlite.org/lang_altertable.html §7):
-- migrate() runs with foreign_keys=OFF so the DROP does not cascade into `grants`, then runs foreign_key_check.
-- The inline UNIQUE (project_id, provider, env, name) is recreated with the table; no standalone index exists.
CREATE TABLE targets_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('vercel','aws','gcp','supabase','github','ssh')),
  name TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('prod','staging','preview','scm')),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('oauth','key','ssh','cli')),
  policy TEXT NOT NULL DEFAULT 'ask' CHECK (policy IN ('ask-mfa','ask','always')),
  policy_source TEXT NOT NULL DEFAULT 'app' CHECK (policy_source IN ('app','project')),
  credential_ref TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  health TEXT NOT NULL DEFAULT 'unconnected' CHECK (health IN ('ok','expired','unconnected')),
  health_checked_at INTEGER,
  expired_at INTEGER,
  from_project_file INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, provider, env, name)
);
INSERT INTO targets_new (id, project_id, provider, name, env, auth_method, policy, policy_source, credential_ref, config_json, health, health_checked_at, expired_at, from_project_file, created_at)
  SELECT id, project_id, provider, name, env, auth_method, policy, policy_source, credential_ref, config_json, health, health_checked_at, expired_at, from_project_file, created_at
  FROM targets ORDER BY rowid;
DROP TABLE targets;
ALTER TABLE targets_new RENAME TO targets;

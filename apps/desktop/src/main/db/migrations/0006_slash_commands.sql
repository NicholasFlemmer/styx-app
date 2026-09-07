-- Slash commands the CLI advertised at session init (`system/init.slash_commands`), for the composer's `/` popup.
ALTER TABLE sessions ADD COLUMN slash_commands_json TEXT NOT NULL DEFAULT '[]';

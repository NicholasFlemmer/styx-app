-- Why a session was started, when Styx started it for a job of its own (the Run locally / Deploy buttons hand the
-- first attempt to the agent). The broker accepts `remember_command` only from a session with the matching
-- purpose, so an ordinary session cannot plant a command Styx would later run. Plain ADD COLUMN, no CHECK.
ALTER TABLE sessions ADD COLUMN purpose TEXT;

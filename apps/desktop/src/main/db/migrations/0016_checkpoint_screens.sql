-- Screenshots of the running app around a turn (the design window's page or the mirrored simulator), captured
-- at turn start and settle; the files live under userData, this lists which exist ('before' / 'after').
ALTER TABLE checkpoints ADD COLUMN screens_json TEXT NOT NULL DEFAULT '[]';

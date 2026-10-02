-- One row per install per completed day. No id, no address, no time finer
-- than the day it was received: rows cannot be joined to each other or to a
-- person, which is the point.
CREATE TABLE IF NOT EXISTS daily (
  received            TEXT    NOT NULL,  -- YYYY-MM-DD, UTC
  day                 TEXT    NOT NULL,  -- the day the counts describe
  v                   TEXT    NOT NULL,  -- lethe version
  hosts               TEXT    NOT NULL,  -- JSON: {"claude-code": 3, ...}
  sessions            INTEGER NOT NULL,
  sessions_using      INTEGER NOT NULL,
  sessions_recalling  INTEGER NOT NULL,
  recalls             INTEGER NOT NULL,
  recalls_hook        INTEGER NOT NULL,
  recalls_empty       INTEGER NOT NULL,
  notes               INTEGER NOT NULL,
  confirms            INTEGER NOT NULL,
  corrections         INTEGER NOT NULL,
  forgets             INTEGER NOT NULL,
  learns              INTEGER NOT NULL,
  briefed             INTEGER NOT NULL,
  compactions         INTEGER NOT NULL,
  claims_kept         INTEGER NOT NULL,
  claims_rejected     INTEGER NOT NULL,
  distiller_failures  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS daily_day ON daily (day);

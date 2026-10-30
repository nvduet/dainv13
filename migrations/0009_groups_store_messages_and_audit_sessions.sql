CREATE TABLE member_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE member_group_members (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES member_groups(id) ON DELETE CASCADE
);

CREATE INDEX member_group_members_group_idx ON member_group_members(group_id);

ALTER TABLE history_points ADD COLUMN message TEXT NOT NULL DEFAULT '';

CREATE TABLE audit_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  admin_seen INTEGER NOT NULL DEFAULT 0,
  guest_seen INTEGER NOT NULL DEFAULT 0,
  after_json TEXT NOT NULL
);

CREATE INDEX audit_sessions_activity_idx ON audit_sessions(last_activity DESC);

CREATE TABLE audit_session_anchor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_json TEXT NOT NULL
);

CREATE TABLE admin_session_store_auth (
  session_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER audit_log_keep_latest_999
AFTER INSERT ON audit_log
BEGIN
  DELETE FROM audit_log
  WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 999);
END;

DROP TRIGGER IF EXISTS audit_log_keep_latest_999;
CREATE TRIGGER audit_log_keep_latest_999
AFTER INSERT ON audit_log
BEGIN
  DELETE FROM audit_log WHERE id <= NEW.id - 999;
END;
DROP INDEX IF EXISTS audit_log_created_idx;
ALTER TABLE ledgers ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0;
UPDATE ledgers SET schema_version = 1 WHERE id = 'default';

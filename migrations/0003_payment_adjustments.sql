CREATE TABLE IF NOT EXISTS payment_adjustments (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount_delta_vnd INTEGER NOT NULL CHECK (amount_delta_vnd <> 0),
  created_by TEXT NOT NULL CHECK (created_by = 'admin'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payment_adjustments_member_idx
  ON payment_adjustments(member_id, created_at);

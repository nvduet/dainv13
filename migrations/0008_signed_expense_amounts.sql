CREATE TABLE expense_participants_backup (
  expense_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

INSERT INTO expense_participants_backup (expense_id, member_id)
SELECT expense_id, member_id FROM expense_participants;

CREATE TABLE expenses_new (
  id TEXT PRIMARY KEY,
  payer_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  amount_vnd INTEGER NOT NULL DEFAULT 0
    CHECK (amount_vnd BETWEEN -1000000000000 AND 1000000000000),
  expense_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO expenses_new (
  id, payer_id, description, amount_vnd, expense_date, position, created_at, updated_at
)
SELECT id, payer_id, description, amount_vnd, expense_date, position, created_at, updated_at
FROM expenses;

DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX expenses_payer_idx ON expenses(payer_id);

DELETE FROM expense_participants;
INSERT INTO expense_participants (expense_id, member_id)
SELECT expense_id, member_id FROM expense_participants_backup;
DROP TABLE expense_participants_backup;

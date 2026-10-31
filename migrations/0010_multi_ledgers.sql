CREATE TABLE ledgers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ledgers (id, slug, name)
VALUES ('default', 'chill-guys', 'Chill guys');

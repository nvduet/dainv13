CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

INSERT INTO app_settings (key, value_json)
VALUES (
  'column-widths',
  '{"expense":{"payer":110,"description":145,"amount":100,"member":80,"count":52,"avg":94,"actions":68},"summary":{"label":120,"member":130}}'
)
ON CONFLICT (key) DO NOTHING;

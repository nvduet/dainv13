CREATE TABLE global_app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

INSERT INTO global_app_settings (key, value_json) VALUES
  ('column-widths', '{"expense":{"payer":100,"date":110,"description":180,"amount":60,"member":60,"count":70,"avg":80,"actions":68},"summary":{"label":120,"member":100}}'),
  ('font-size', '90'),
  ('qr-size', '250');

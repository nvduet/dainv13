INSERT INTO app_settings (key, value_json)
VALUES ('font-size', '100')
ON CONFLICT (key) DO NOTHING;

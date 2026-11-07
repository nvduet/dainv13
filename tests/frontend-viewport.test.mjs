import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BASE_VIEWPORT, isAppleTouchDevice, viewportContent } from "../public/js/viewport.js";
import { FONT_SIZE } from "../public/shared/constants.mjs";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_MODE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

test("iPhone, iPad and iPadOS in desktop mode are Apple touch devices; Android, Mac and Windows are not", () => {
  assert.equal(isAppleTouchDevice({ userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 }), true);
  assert.equal(isAppleTouchDevice({ userAgent: IPHONE_CHROME, platform: "iPhone", maxTouchPoints: 5 }), true);
  assert.equal(isAppleTouchDevice({ userAgent: IPAD_DESKTOP_MODE, platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(isAppleTouchDevice({ userAgent: IPAD_DESKTOP_MODE, platform: "MacIntel", maxTouchPoints: 0 }), false, "a real Mac");
  assert.equal(isAppleTouchDevice({ userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 }), false);
  assert.equal(isAppleTouchDevice({ userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 10 }), false, "a Windows touch laptop");
  assert.equal(isAppleTouchDevice({}), false);
});

test("phone inputs follow the Admin font size below the default, relative to FONT_SIZE.default", () => {
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const scale = FONT_SIZE.default / 100;
  assert.match(css, new RegExp(`--font-scale: ${scale};`), "default --font-scale token");
  assert.match(css, new RegExp(`font-size: max\\(1em, min\\(16px, 16px \\* var\\(--font-scale\\) / ${scale}\\)\\);`), "phone input rule");
  assert.doesNotMatch(css, /max\(16px, 1em\)/, "no fixed 16 px floor left");
});

test("only Apple touch devices get maximum-scale=1; the base viewport equals index.html's", () => {
  assert.equal(viewportContent(true), "width=device-width, initial-scale=1, maximum-scale=1");
  assert.equal(viewportContent(false), BASE_VIEWPORT);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, new RegExp(`<meta name="viewport" content="${BASE_VIEWPORT}">`));
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  DEFAULT_THEME,
  MODES,
  PAGE_COLORS,
  SKINS,
  STORAGE_KEYS,
  applyTheme,
  effectiveMode,
  normalizeTheme,
  readTheme,
  saveTheme,
  themeAttributes,
  themeColors,
} from "../public/js/theme.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const bootSource = read("../public/js/theme-boot.js");
const html = read("../public/index.html");
const css = read("../public/styles.css");

function memoryStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    data,
  };
}
const blockedStorage = {
  getItem() { throw new Error("SecurityError: storage is blocked"); },
  setItem() { throw new Error("SecurityError: storage is blocked"); },
};

// A stand-in for the bits of the document theme-boot.js and applyTheme touch: <html> attributes and the two theme-color
// tags of index.html, with the static default (data-skin="nga" data-mode="light", Ngà & Vàng light page colour).
function fakeDocument() {
  const attributes = new Map([["lang", "vi"], ["data-skin", "nga"], ["data-mode", "light"]]);
  const meta = (media, content) => {
    const values = new Map([["name", "theme-color"], ["media", media], ["content", content]]);
    return { getAttribute: (name) => values.get(name) ?? null, setAttribute: (name, value) => values.set(name, String(value)), values };
  };
  const metas = [meta("(prefers-color-scheme: light)", "#f2eee6"), meta("(prefers-color-scheme: dark)", "#f2eee6")];
  return {
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: (name) => attributes.delete(name),
    },
    querySelectorAll: (selector) => {
      assert.equal(selector, 'meta[name="theme-color"]');
      return metas;
    },
    snapshot: () => ({
      skin: attributes.get("data-skin") ?? null,
      mode: attributes.get("data-mode") ?? null,
      colors: metas.map((item) => item.values.get("content")),
    }),
  };
}

// Runs the classic boot script the way the browser does (global scope, its own localStorage).
function runBoot(storage) {
  const document = fakeDocument();
  const context = { document };
  if (storage === blockedStorage) {
    Object.defineProperty(context, "localStorage", { get() { throw new Error("SecurityError: storage is blocked"); } });
  } else {
    context.localStorage = storage;
  }
  vm.runInNewContext(bootSource, context);
  return document.snapshot();
}

test("stored skin and mode are read back; anything else falls back to Ngà & Vàng, Sáng", () => {
  assert.deepEqual(DEFAULT_THEME, { skin: "nga", mode: "light" }, "the owner's default (2026-11-05)");
  assert.deepEqual(readTheme(memoryStorage({ [STORAGE_KEYS.skin]: "graphite", [STORAGE_KEYS.mode]: "auto" })), { skin: "graphite", mode: "auto" });
  assert.deepEqual(readTheme(memoryStorage({ [STORAGE_KEYS.skin]: "rung" })), { skin: "rung", mode: "light" });
  assert.deepEqual(readTheme(memoryStorage()), DEFAULT_THEME);
  for (const [skin, mode] of [["Than chì", "night"], ["", ""], ["constructor", "toString"], ["__proto__", "AUTO"], ["NAVY", "Dark"]]) {
    assert.deepEqual(readTheme(memoryStorage({ [STORAGE_KEYS.skin]: skin, [STORAGE_KEYS.mode]: mode })), DEFAULT_THEME, `${skin}/${mode}`);
  }
  assert.deepEqual(readTheme(blockedStorage), DEFAULT_THEME);
  assert.deepEqual(readTheme(null), DEFAULT_THEME, "window.localStorage itself threw");
  assert.deepEqual(normalizeTheme("navy", "light"), { skin: "navy", mode: "light" });
  assert.deepEqual(SKINS, ["graphite", "rung", "nga", "navy"], "picker order: Than chì, Rừng xanh, Ngà & Vàng, Navy & Đồng");
  assert.deepEqual(MODES, ["auto", "light", "dark"]);
});

test("saving writes both keys, and reports a blocked storage instead of throwing", () => {
  const storage = memoryStorage();
  assert.equal(saveTheme(storage, { skin: "navy", mode: "light" }), true);
  assert.deepEqual(Object.fromEntries(storage.data), { "so-chi-skin": "navy", "so-chi-mode": "light" });
  assert.deepEqual(readTheme(storage), { skin: "navy", mode: "light" });
  assert.equal(saveTheme(blockedStorage, { skin: "nga", mode: "dark" }), false);
  assert.equal(saveTheme(null, { skin: "nga", mode: "dark" }), false);
});

test("the effective mode follows the device only in Tự động", () => {
  assert.equal(effectiveMode("auto", false), "light");
  assert.equal(effectiveMode("auto", true), "dark");
  for (const prefersDark of [false, true]) {
    assert.equal(effectiveMode("light", prefersDark), "light");
    assert.equal(effectiveMode("dark", prefersDark), "dark");
  }
});

test("data-mode is set only for a forced mode; theme-color follows the effective page colour", () => {
  assert.deepEqual(themeAttributes({ skin: "graphite", mode: "auto" }), { "data-skin": "graphite", "data-mode": null });
  assert.deepEqual(themeAttributes({ skin: "nga", mode: "dark" }), { "data-skin": "nga", "data-mode": "dark" });
  assert.deepEqual(themeColors({ skin: "graphite", mode: "auto" }), ["#f4f4f3", "#0c0c0d"]);
  assert.deepEqual(themeColors({ skin: "navy", mode: "auto" }), ["#edf0f5", "#0a0f1a"]);
  assert.deepEqual(themeColors({ skin: "rung", mode: "light" }), ["#f3f4f6", "#f3f4f6"]);
  assert.deepEqual(themeColors({ skin: "nga", mode: "dark" }), ["#12100c", "#12100c"]);
});

test("applyTheme sets and clears the <html> attributes and both theme-color tags", () => {
  const document = fakeDocument();
  applyTheme(document, { skin: "nga", mode: "dark" });
  assert.deepEqual(document.snapshot(), { skin: "nga", mode: "dark", colors: ["#12100c", "#12100c"] });
  applyTheme(document, { skin: "graphite", mode: "auto" });
  assert.deepEqual(document.snapshot(), { skin: "graphite", mode: null, colors: ["#f4f4f3", "#0c0c0d"] });
});

test("theme-boot.js applies exactly what theme.js would, for every stored value and a blocked storage", () => {
  const cases = [];
  for (const skin of [...SKINS, null, "", "x", "constructor", "__proto__", "hasOwnProperty"]) {
    for (const mode of [...MODES, null, "", "night", "constructor"]) cases.push({ skin, mode });
  }
  for (const { skin, mode } of cases) {
    const entries = {};
    if (skin !== null) entries[STORAGE_KEYS.skin] = skin;
    if (mode !== null) entries[STORAGE_KEYS.mode] = mode;
    const storage = memoryStorage(entries);
    const expected = fakeDocument();
    applyTheme(expected, readTheme(storage));
    assert.deepEqual(runBoot(storage), expected.snapshot(), `${skin}/${mode}`);
  }
  const defaults = fakeDocument();
  applyTheme(defaults, readTheme(blockedStorage));
  assert.deepEqual(runBoot(blockedStorage), defaults.snapshot());
  assert.deepEqual(runBoot(blockedStorage), { skin: "nga", mode: "light", colors: ["#f2eee6", "#f2eee6"] }, "the static default stays");
  // A saved "Tự động" removes the static data-mode="light", so CSS follows the device again.
  assert.deepEqual(runBoot(memoryStorage({ [STORAGE_KEYS.skin]: "graphite", [STORAGE_KEYS.mode]: "auto" })),
    { skin: "graphite", mode: null, colors: ["#f4f4f3", "#0c0c0d"] });
});

test("theme-boot.js is a small classic script loaded before the stylesheet, with no inline script", () => {
  assert.ok(Buffer.byteLength(bootSource) < 2048, "tiny");
  assert.doesNotMatch(bootSource, /\b(import|export)\b/, "classic script, not a module");
  const head = html.slice(0, html.indexOf("</head>"));
  const boot = head.indexOf('<script src="/js/theme-boot.js"></script>');
  assert.ok(boot > head.indexOf('<meta name="theme-color"'), "after the theme-color tags it updates");
  assert.ok(boot < head.indexOf('<link rel="stylesheet" href="/styles.css">'), "before the stylesheet: no flash");
  assert.equal([...html.matchAll(/<script\b[^>]*>/g)].filter(([tag]) => !/\bsrc=/.test(tag)).length, 0, "no inline <script>");
});

test("index.html carries the default theme and the picker in the approved order and wording", () => {
  assert.match(html, /<html lang="vi" data-skin="nga" data-mode="light">/);
  // Forced Sáng: the browser bar is Ngà & Vàng's light page colour whatever the device's mode.
  assert.ok(html.includes(`<meta name="theme-color" content="${PAGE_COLORS.nga[0]}" media="(prefers-color-scheme: light)">`));
  assert.ok(html.includes(`<meta name="theme-color" content="${PAGE_COLORS.nga[0]}" media="(prefers-color-scheme: dark)">`));
  const checked = [...html.matchAll(/role="radio" aria-checked="true" data-(skin|mode)="([a-z]+)"/g)].map(([, kind, key]) => `${kind}:${key}`);
  assert.deepEqual(checked, ["skin:nga", "mode:light"], "the picker starts on the default");
  assert.match(html, /<button id="theme-button"[^>]*aria-label="Đổi giao diện"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="theme-panel"/);
  const skins = [...html.matchAll(/role="radio"[^>]*data-skin="([a-z]+)"><span class="theme-dots"><\/span>([^<]+)</g)].map(([, key, name]) => [key, name]);
  assert.deepEqual(skins, [["graphite", "Than chì"], ["rung", "Rừng xanh"], ["nga", "Ngà &amp; Vàng"], ["navy", "Navy &amp; Đồng"]]);
  const modes = [...html.matchAll(/role="radio"[^>]*data-mode="([a-z]+)">([^<]+)</g)].map(([, key, name]) => [key, name]);
  assert.deepEqual(modes, [["auto", "Tự động"], ["light", "Sáng"], ["dark", "Tối"]]);
  assert.match(html, /role="radiogroup" aria-labelledby="theme-skin-label"/);
  assert.match(html, /role="radiogroup" aria-labelledby="theme-mode-label"/);
});

// Every colour token of Rừng xanh (the base) must be set again by each new theme (its palette or the shared derived
// rule), otherwise a green Rừng xanh value would leak into it; only these mode-wide tokens are shared on purpose.
const SHARED = new Set(["backdrop", "qr-frame", "qr-pad", "qr-radius", "shadow-xs", "shadow-sm", "shadow-md", "shadow-lg"]);
const tokensOf = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start !== -1, `missing ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  return new Map([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
};

test("each new theme overrides every Rừng xanh colour token, light and dark", () => {
  const rung = tokensOf(':root, [data-skin="rung"]');
  const derived = tokensOf(':where([data-skin]):not([data-skin="rung"])');
  for (const skin of ["graphite", "nga", "navy"]) {
    const palette = tokensOf(`[data-skin="${skin}"]`);
    const missing = [...rung.keys()].filter((name) => !SHARED.has(name) && !palette.has(name) && !derived.has(name));
    assert.deepEqual(missing, [], skin);
    // Page colours in the stylesheet match the theme-color values (light, dark).
    assert.equal(palette.get("page"), `var(--s, ${PAGE_COLORS[skin][0]}) var(--t, ${PAGE_COLORS[skin][1]})`, skin);
  }
  assert.equal(rung.get("page"), `var(--s, ${PAGE_COLORS.rung[0]}) var(--t, ${PAGE_COLORS.rung[1]})`);
});

test("light and dark are switched by the device, or by data-mode when the viewer forces one", () => {
  assert.match(css, /:root \{[^}]*--s: initial; --t: ;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\r?\n {2}:root:not\(\[data-mode="light"\]\) \{ --s: ; --t: initial; \}\r?\n\}/);
  assert.match(css, /:root\[data-mode="dark"\] \{ --s: ; --t: initial; color-scheme: dark; \}/);
  assert.match(css, /:root\[data-mode="light"\] \{ color-scheme: light; \}/);
  // Status colours have their own tokens, so an accent never recolours money.
  assert.match(css, /\.balance-positive \{ color: var\(--owe\);/);
  assert.match(css, /\.balance-negative \{ color: var\(--refund\);/);
});

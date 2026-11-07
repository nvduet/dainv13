import assert from "node:assert/strict";
import test from "node:test";
import { crc32 as zlibCrc32 } from "node:zlib";
import { calculateBalances } from "../public/accounting.mjs";
import { buildLedgerXlsx, columnName, crc32, excelDateSerial, XLSX_MIME, xlsxFileName, zipFiles } from "../public/js/xlsx.js";

const members = [
  { id: "a", name: "An", groupId: "g1" },
  { id: "b", name: "Bình", groupId: "g1" },
  { id: "c", name: "Chi", groupId: null },
];
const groups = [{ id: "g1", name: "Nhà Vải", memberIds: ["a", "b"] }];
const expenses = [
  { id: "e1", payerId: "a", date: "2026-10-01", description: "Ăn trưa", amountVnd: 100_000, participantIds: ["a", "b", "c"] },
  { id: "e2", payerId: "c", date: null, description: "Hoàn tiền vé", amountVnd: -90_001, participantIds: ["c", "b"] },
  { id: "e3", payerId: null, date: null, description: "", amountVnd: 0, participantIds: [] },
];
const payments = [
  { memberId: "a", direction: "member_to_admin", amountVnd: 20_000, status: "confirmed" },
  { memberId: "c", direction: "member_to_admin", amountVnd: 5_000, status: "pending" },
];
const PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/styles.xml",
  "xl/worksheets/sheet1.xml",
  "xl/worksheets/sheet2.xml",
];

// Independent ZIP reader: end record → central directory → local headers. Checks the signatures, the UTF-8 name flag,
// STORE, that both headers agree, sizes, and every entry's CRC-32 with node:zlib.
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new TextDecoder("utf-8", { fatal: true });
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "end of central directory record, no comment");
  const count = view.getUint16(end + 10, true);
  assert.equal(view.getUint16(end + 8, true), count, "entries on this disk = total");
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  assert.equal(centralStart + centralSize, end, "the central directory ends at the end record");
  const entries = [];
  let at = centralStart;
  let localEnd = 0;
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, `central header ${index}`);
    const central = {
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      compressed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
    };
    const nameLength = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + skip;
    assert.equal(offset, localEnd, `${name}: local entries are contiguous`);
    assert.equal(view.getUint32(offset, true), 0x04034b50, `${name}: local header`);
    const local = {
      flags: view.getUint16(offset + 6, true),
      method: view.getUint16(offset + 8, true),
      time: view.getUint16(offset + 10, true),
      date: view.getUint16(offset + 12, true),
      crc: view.getUint32(offset + 14, true),
      compressed: view.getUint32(offset + 18, true),
      size: view.getUint32(offset + 22, true),
    };
    assert.deepEqual(local, central, `${name}: local and central headers agree`);
    const localNameLength = view.getUint16(offset + 26, true);
    assert.equal(names.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)), name);
    const start = offset + 30 + localNameLength + view.getUint16(offset + 28, true);
    const data = bytes.subarray(start, start + central.compressed);
    assert.equal(central.flags, 0x0800, `${name}: UTF-8 file name flag`);
    assert.equal(central.method, 0, `${name}: stored`);
    assert.equal(central.compressed, central.size);
    assert.equal(zlibCrc32(data), central.crc, `${name}: CRC-32`);
    localEnd = start + central.compressed;
    entries.push({ name, data, time: central.time, date: central.date });
  }
  assert.equal(localEnd, centralStart, "the central directory follows the last entry");
  assert.equal(at, end);
  return entries;
}

function readParts(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true });
  return new Map(readZip(bytes).map((entry) => [entry.name, text.decode(entry.data)]));
}

// Minimal XML well-formedness check: declaration, balanced tags, quoted attributes, only known entities, no characters
// XML 1.0 forbids.
function assertWellFormed(xml, label) {
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  assert.ok(xml.startsWith(declaration), `${label}: XML declaration`);
  assert.doesNotMatch(xml, /[\0-\x08\x0B\x0C\x0E-\x1F￾￿]/, `${label}: no forbidden characters`);
  const entity = /&(?!(?:amp|lt|gt|quot|apos);)/;
  const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/y;
  const stack = [];
  let roots = 0;
  token.lastIndex = declaration.length;
  while (token.lastIndex < xml.length) {
    const start = token.lastIndex;
    const match = token.exec(xml);
    assert.ok(match, `${label}: unexpected markup at ${start}: ${xml.slice(start, start + 60)}`);
    const [, closing, name, attributes, selfClosing, text] = match;
    if (text !== undefined) {
      assert.doesNotMatch(text, entity, `${label}: bare & in text`);
      assert.ok(stack.length || !text.trim(), `${label}: text outside the root`);
      continue;
    }
    assert.doesNotMatch(attributes, entity, `${label}: bare & in an attribute`);
    if (closing) {
      assert.equal(stack.pop(), name, `${label}: </${name}> closes the open element`);
    } else {
      if (!stack.length) roots += 1;
      if (!selfClosing) stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `${label}: every element is closed`);
  assert.equal(roots, 1, `${label}: one root element`);
}

const unescape = (text) => text
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&")
  .replace(/_x([0-9A-Fa-f]{4})_/g, (all, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

// Styles: cellXfs index → { format, bold, color, fill, border, align, quotePrefix }.
function readStyles(xml) {
  const formats = new Map([[0, "General"], [3, "#,##0"]]);
  for (const [, id, code] of xml.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)) formats.set(Number(id), unescape(code));
  const fontsBlock = /<fonts count="(\d+)">(.*?)<\/fonts>/.exec(xml);
  const fonts = [...fontsBlock[2].matchAll(/<font>(.*?)<\/font>/g)].map(([, inner]) => ({
    bold: inner.includes("<b/>"),
    color: /<color rgb="(\w+)"\/>/.exec(inner)?.[1] ?? null,
  }));
  assert.equal(fonts.length, Number(fontsBlock[1]));
  const xfsBlock = /<cellXfs count="(\d+)">(.*?)<\/cellXfs>/.exec(xml);
  const xfs = [...xfsBlock[2].matchAll(/<xf ([^>]*?)(?:\/>|>(.*?)<\/xf>)/g)].map(([, attributes, inner = ""]) => {
    const attribute = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
    const font = fonts[Number(attribute("fontId"))];
    return {
      format: formats.get(Number(attribute("numFmtId"))),
      bold: font.bold,
      color: font.color,
      fill: attribute("fillId") === "2",
      border: attribute("borderId") === "1",
      align: /horizontal="(\w+)"/.exec(inner)?.[1] ?? null,
      quotePrefix: attribute("quotePrefix") === "1",
    };
  });
  assert.equal(xfs.length, Number(xfsBlock[1]));
  return xfs;
}

// Cells of a sheet: ref → { value, type, style }.
function readCells(xml, styles) {
  const cells = new Map();
  for (const [, ref, styleId = "0", type, inner] of xml.matchAll(/<c r="([A-Z]+\d+)"(?: s="(\d+)")?(?: t="(\w+)")?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    let value = null;
    if (type === "inlineStr") {
      value = unescape(/^<is><t xml:space="preserve">([\s\S]*)<\/t><\/is>$/.exec(inner)[1]);
    } else if (inner !== undefined) {
      value = Number(/^<v>(-?\d+)<\/v>$/.exec(inner)[1]);
    }
    cells.set(ref, { value, type: type ?? (inner === undefined ? "empty" : "n"), style: styles[Number(styleId)] });
  }
  return cells;
}

function workbook(bytes) {
  const parts = readParts(bytes);
  assert.deepEqual([...parts.keys()], PARTS);
  for (const [name, xml] of parts) assertWellFormed(xml, name);
  const styles = readStyles(parts.get("xl/styles.xml"));
  const sheet = (name) => {
    const xml = parts.get(name);
    return { xml, cells: readCells(xml, styles), row: (number) => [...readCells(xml, styles)].filter(([ref]) => ref.replace(/^[A-Z]+/, "") === String(number)) };
  };
  return { parts, styles, detail: sheet("xl/worksheets/sheet1.xml"), summary: sheet("xl/worksheets/sheet2.xml") };
}

const values = (cells, refs) => refs.map((ref) => cells.get(ref)?.value ?? null);
const refsOf = (columns, row) => columns.map((column) => `${column}${row}`);

test("the file is a ZIP the reader accepts: STORE, UTF-8 names, CRC-32 and sizes, DOS date of the export", () => {
  const bytes = buildLedgerXlsx({ members, groups, expenses, payments, date: new Date(2026, 10, 5, 13, 45, 31) });
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "starts with PK\\3\\4");
  const entries = readZip(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), PARTS);
  for (const entry of entries) {
    assert.equal(entry.time, (13 << 11) | (45 << 5) | 15, `${entry.name}: 13:45:30`);
    assert.equal(entry.date, ((2026 - 1980) << 9) | (11 << 5) | 5, `${entry.name}: 2026-11-05`);
  }
  // The writer on its own: a UTF-8 name and binary data survive; crc32 matches zlib.
  const data = Uint8Array.from({ length: 1000 }, (_, index) => (index * 37) % 256);
  const zipped = readZip(zipFiles([{ name: "thư mục/tệp.bin", data }, { name: "a.txt", data: "Đ & đ" }], new Date(1975, 0, 1)));
  assert.equal(zipped[0].name, "thư mục/tệp.bin");
  assert.deepEqual([...zipped[0].data], [...data]);
  assert.equal(new TextDecoder().decode(zipped[1].data), "Đ & đ");
  assert.equal(zipped[0].date, (0 << 9) | (1 << 5) | 1, "dates before 1980 are clamped to 1980");
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(data), zlibCrc32(data));
  assert.equal(crc32(new Uint8Array()), 0);
});

test("package parts: content types, relationships, the sheets 'Detail' then 'Summary'", () => {
  const { parts } = workbook(buildLedgerXlsx({ members, groups, expenses, payments }));
  const types = parts.get("[Content_Types].xml");
  assert.match(types, /<Default Extension="rels" ContentType="application\/vnd.openxmlformats-package.relationships\+xml"\/>/);
  assert.match(types, /<Override PartName="\/xl\/workbook.xml" ContentType="application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main\+xml"\/>/);
  assert.match(types, /<Override PartName="\/xl\/styles.xml" ContentType="application\/vnd.openxmlformats-officedocument.spreadsheetml.styles\+xml"\/>/);
  for (const number of [1, 2]) {
    assert.match(types, new RegExp(`<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet\\+xml"/>`));
  }
  assert.match(parts.get("_rels/.rels"), /<Relationship Id="rId1" Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/officeDocument" Target="xl\/workbook.xml"\/>/);
  const sheets = [...parts.get("xl/workbook.xml").matchAll(/<sheet name="([^"]+)" sheetId="(\d+)" r:id="(\w+)"\/>/g)].map((match) => match.slice(1));
  assert.deepEqual(sheets, [["Detail", "1", "rId1"], ["Summary", "2", "rId2"]]);
  const rels = new Map([...parts.get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship Id="(\w+)" Type="[^"]+\/(\w+)" Target="([^"]+)"\/>/g)].map(([, id, type, target]) => [id, `${type} ${target}`]));
  assert.deepEqual([...rels], [["rId1", "worksheet worksheets/sheet1.xml"], ["rId2", "worksheet worksheets/sheet2.xml"], ["rId3", "styles styles.xml"]]);
  assert.match(parts.get("xl/worksheets/sheet1.xml"), /<sheetView tabSelected="1" workbookViewId="0">/, "Detail opens first");
  assert.doesNotMatch(parts.get("xl/worksheets/sheet2.xml"), /tabSelected/);
  assert.equal(XLSX_MIME, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("Detail: bold frozen header, every row in the given order, real numbers #,##0, real dates dd/mm/yyyy, 'x' marks", () => {
  const { detail } = workbook(buildLedgerXlsx({ members, groups, expenses, payments }));
  const columns = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  assert.deepEqual(values(detail.cells, refsOf(columns, 1)), ["Người chi", "Ngày", "Nội dung", "Chi phí (đ)", "An", "Bình", "Chi", "Số người", "Số tiền/người (đ)"]);
  for (const ref of refsOf(columns, 1)) {
    assert.ok(detail.cells.get(ref).style.bold && detail.cells.get(ref).style.fill, `${ref} is a bold header`);
  }
  assert.match(detail.xml, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(detail.xml, /<dimension ref="A1:I4"\/>/);
  assert.equal([...detail.xml.matchAll(/<col min="(\d+)" max="\1" width="\d+" customWidth="1"\/>/g)].length, 9, "one width per column");
  assert.deepEqual(values(detail.cells, refsOf(columns, 2)), ["An", 46296, "Ăn trưa", 100_000, "x", "x", "x", 3, 33_333]);
  assert.deepEqual(values(detail.cells, refsOf(columns, 3)), ["Chi", null, "Hoàn tiền vé", -90_001, null, "x", "x", 2, -45_001]);
  assert.deepEqual(values(detail.cells, refsOf(columns, 4)), [null, null, null, 0, null, null, null, null, null]);
  assert.equal(detail.cells.get("B2").style.format, "dd/mm/yyyy");
  for (const ref of ["D2", "I2", "D3", "I3", "D4"]) assert.equal(detail.cells.get(ref).style.format, "#,##0", ref);
  assert.equal(detail.cells.get("H2").type, "n");
  assert.equal(detail.cells.get("A2").type, "inlineStr");
  // Missing payer/date/amount cells are empty but keep the table border; nothing is a formula.
  for (const ref of ["A4", "B3", "B4", "C4", "E3", "H4", "I4"]) {
    assert.equal(detail.cells.get(ref).type, "empty", ref);
    assert.ok(detail.cells.get(ref).style.border, `${ref} has a border`);
  }
  assert.doesNotMatch(detail.xml, /<f[ >]/);
});

test("Summary mirrors the page: labels, members as columns in page order, calculateBalances numbers, merged group balances", () => {
  const people = [
    { id: "a", name: "An", groupId: "g1" },
    { id: "b", name: "Bình", groupId: "g1" },
    { id: "c", name: "Chi", groupId: null },
    { id: "d", name: "Dũng", groupId: "g2" },
    { id: "e", name: "Em", groupId: "g2" },
  ];
  const teams = [{ id: "g1", name: "Nhà Vải" }, { id: "g2", name: "Team B" }];
  const items = [
    ...expenses,
    { id: "e4", payerId: "d", date: "2026-10-03", description: "Taxi", amountVnd: 100_000, participantIds: ["d", "e", "a"] },
  ];
  const paid = [...payments, { memberId: "e", direction: "admin_to_member", amountVnd: 7_000, status: "confirmed" },
    { memberId: "d", direction: "member_to_admin", amountVnd: -30_000, status: "confirmed" }];
  const { summary } = workbook(buildLedgerXlsx({ members: people, groups: teams, expenses: items, payments: paid }));
  const balances = calculateBalances(people, items, paid);
  const columns = ["A", "B", "C", "D", "E", "F"];
  assert.deepEqual(values(summary.cells, refsOf(columns, 1)), ["Tên thành viên", "An", "Bình", "Chi", "Dũng", "Em"]);
  const rows = [["Tiền phải chịu", "shareVnd"], ["Đã chi", "paidExpenseVnd"], ["Đã chuyển khoản", "paidToAdminVnd"], ["Số dư", "balanceVnd"]];
  rows.forEach(([label, key], index) => {
    assert.deepEqual(values(summary.cells, refsOf(columns, index + 2)), [label, ...balances.map((member) => member[key])], label);
    for (const ref of refsOf(columns.slice(1), index + 2)) assert.equal(summary.cells.get(ref).style.format, "#,##0", ref);
  });
  for (const row of [1, 2, 3, 4, 5, 6, 7]) assert.ok(summary.cells.get(`A${row}`).style.bold, `label A${row} is bold`);
  // "Số dư nhóm": one merged cell per group with the sum of its balances; a member without a group stands alone.
  const sum = (ids) => balances.filter((member) => ids.includes(member.id)).reduce((total, member) => total + member.balanceVnd, 0);
  assert.deepEqual(values(summary.cells, refsOf(columns, 6)), ["Số dư nhóm", sum(["a", "b"]), null, sum(["c"]), sum(["d", "e"]), null]);
  assert.deepEqual(values(summary.cells, refsOf(columns, 7)), ["Nhóm", "Nhà Vải", null, null, "Team B", null]);
  assert.deepEqual([...summary.xml.matchAll(/<mergeCell ref="([A-Z0-9:]+)"\/>/g)].map((match) => match[1]), ["B6:C6", "B7:C7", "E6:F6", "E7:F7"]);
  assert.match(summary.xml, /<mergeCells count="4">/);
  for (const ref of ["C6", "F6", "C7", "F7"]) assert.ok(summary.cells.get(ref).style.border, `${ref} (inside a merge) keeps the border`);
  // Frozen first row and label column, like the sticky header and column on the page.
  assert.match(summary.xml, /<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/);
  // Balance colours keep their meaning: red = still owes Admin, green = Admin refunds; zero is plain.
  const balanceCells = refsOf(["B", "C", "D", "E", "F"], 5).map((ref) => summary.cells.get(ref));
  balanceCells.forEach((cell, index) => {
    const amount = balances[index].balanceVnd;
    assert.equal(cell.style.color, amount > 0 ? "FFC00000" : amount < 0 ? "FF2E7D32" : null, `balance ${amount}`);
    assert.equal(cell.style.bold, amount !== 0);
  });
  assert.ok(balances.some((member) => member.balanceVnd > 0) && balances.some((member) => member.balanceVnd < 0));
  assert.equal(summary.cells.get("B6").style.align, "center");
  assert.doesNotMatch(summary.xml, /Done/);
});

test("Summary of a ledger without groups: every member is their own 'Số dư nhóm' cell, no merges, no 'Nhóm' row", () => {
  const { summary } = workbook(buildLedgerXlsx({ members: members.map((member) => ({ ...member, groupId: null })), expenses, payments }));
  const balances = calculateBalances(members, expenses, payments);
  assert.deepEqual(values(summary.cells, ["A6", "B6", "C6", "D6"]), ["Số dư nhóm", ...balances.map((member) => member.balanceVnd)]);
  assert.equal(summary.cells.get("A7"), undefined);
  assert.doesNotMatch(summary.xml, /mergeCell/);
  assert.match(summary.xml, /<dimension ref="A1:D6"\/>/);
});

test("text is escaped and never a formula; text Excel would treat as a formula is marked quotePrefix", () => {
  const evil = ["=HYPERLINK(\"http://x\";\"y\")", "+1+1", "-2+3", "@SUM(A1)"];
  const safe = ["Phở & <b>\"bún\"</b> 'x' ]]>", "Một\rHai", "Ba\nBốn", "Tab\there", "ctl\u0001\u001f", "_x0041_ giữ nguyên", "Ăn = 3 món", "😀 emoji"];
  const texts = [...evil, ...safe];
  const people = texts.map((name, index) => ({ id: `m${index}`, name, groupId: "g" }));
  const bytes = buildLedgerXlsx({
    members: people,
    groups: [{ id: "g", name: "=cmd|' /C calc'!A0" }],
    expenses: texts.map((description, index) => ({ payerId: `m${index}`, date: null, description, amountVnd: -5_000, participantIds: [`m${index}`] })),
  });
  const { detail, summary, parts } = workbook(bytes);
  for (const xml of parts.values()) assert.doesNotMatch(xml, /<f[ >]/, "no formula element anywhere");
  texts.forEach((text, index) => {
    const row = index + 2;
    const formulaLike = index < evil.length;
    // Payer and description in Detail, the member's column header in Detail and in Summary.
    const cells = [
      ["Detail", `A${row}`], ["Detail", `C${row}`], ["Detail", `${columnName(4 + index)}1`], ["Summary", `${columnName(1 + index)}1`],
    ];
    for (const [sheet, ref] of cells) {
      const cell = (sheet === "Detail" ? detail : summary).cells.get(ref);
      assert.equal(cell.value, text, `${sheet}!${ref} keeps the text exactly`);
      assert.equal(cell.type, "inlineStr", `${sheet}!${ref}`);
      assert.equal(cell.style.quotePrefix, formulaLike, `${sheet}!${ref} quotePrefix`);
    }
    assert.equal(detail.cells.get(`D${row}`).value, -5_000, "negative amounts stay numbers");
    assert.equal(detail.cells.get(`${columnName(4 + texts.length + 1)}${row}`).value, -5_000, "per person");
  });
  // The raw XML: entities, Excel's _xHHHH_ escapes for CR and control characters, and the literal "_x0041_" protected.
  assert.ok(detail.xml.includes("Phở &amp; &lt;b&gt;&quot;bún&quot;&lt;/b&gt; 'x' ]]&gt;"));
  assert.ok(detail.xml.includes("Một_x000D_Hai"));
  assert.ok(detail.xml.includes("Ba\nBốn"));
  assert.ok(detail.xml.includes("ctl_x0001__x001F_"));
  assert.ok(detail.xml.includes("_x005F_x0041_ giữ nguyên"));
  const groupName = summary.cells.get("B7");
  assert.equal(groupName.value, "=cmd|' /C calc'!A0");
  assert.equal(groupName.style.quotePrefix, true);
});

test("an empty ledger: Detail is just the header, Summary the labels and the page's hint over the member area", () => {
  const bytes = buildLedgerXlsx({ members: [], expenses: [] });
  const { detail, summary } = workbook(bytes);
  assert.deepEqual([...detail.cells.keys()], ["A1", "B1", "C1", "D1", "E1", "F1"]);
  assert.deepEqual(values(detail.cells, ["A1", "B1", "C1", "D1", "E1", "F1"]), ["Người chi", "Ngày", "Nội dung", "Chi phí (đ)", "Số người", "Số tiền/người (đ)"]);
  assert.match(detail.xml, /<dimension ref="A1:F1"\/>/);
  assert.match(detail.xml, /state="frozen"/);
  assert.deepEqual(values(summary.cells, ["A1", "A2", "A3", "A4", "A5", "B1"]), ["Tên thành viên", "Tiền phải chịu", "Đã chi", "Đã chuyển khoản", "Số dư", "Thêm thành viên để bắt đầu sổ chi nhé."]);
  assert.deepEqual(values(summary.cells, ["B2", "B3", "B4", "B5"]), [null, null, null, null]);
  assert.deepEqual([...summary.xml.matchAll(/<mergeCell ref="([A-Z0-9:]+)"\/>/g)].map((match) => match[1]), ["B1:B5"]);
  assert.equal(summary.cells.get("A6"), undefined, "no group row without members");
});

test("per-person amounts round to whole đồng away from zero; empty when nobody shares or the amount is 0", () => {
  const { detail } = workbook(buildLedgerXlsx({
    members,
    expenses: [
      { amountVnd: 100_000, participantIds: ["a", "b", "c"] },
      { amountVnd: 200_000, participantIds: ["a", "b", "c"] },
      { amountVnd: -200_000, participantIds: ["a", "b", "c"] },
      { amountVnd: 5, participantIds: ["a", "b"] },
      { amountVnd: -5, participantIds: ["a", "b"] },
      { amountVnd: 1_000, participantIds: [] },
      { amountVnd: 0, participantIds: ["a"] },
      { amountVnd: 1_000, participantIds: ["a", "gone"] },
      { payerId: "gone", amountVnd: Number.NaN, participantIds: ["a"] },
    ],
  }));
  const pairs = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((row) => values(detail.cells, [`H${row}`, `I${row}`]));
  assert.deepEqual(pairs, [[3, 33_333], [3, 66_667], [3, -66_667], [2, 3], [2, -3], [null, null], [1, null], [1, 1_000], [1, null]]);
  assert.deepEqual(values(detail.cells, ["A10", "D10"]), [null, null], "unknown payer and a non-integer amount are empty");
});

test("dates are real Excel dates from 01/03/1900 to 31/12/9999; anything else stays as text, a missing date is empty", () => {
  assert.equal(excelDateSerial("1970-01-01"), 25_569);
  assert.equal(excelDateSerial("2026-10-01"), 46_296);
  assert.equal(excelDateSerial("1900-03-01"), 61);
  assert.equal(excelDateSerial("9999-12-31"), 2_958_465);
  assert.equal(excelDateSerial("2028-02-29"), 46_812);
  for (const value of ["1900-02-28", "1899-12-31", "2026-02-29", "2026-13-01", "2026-1-01", "0050-01-01", "", null, undefined]) {
    assert.equal(excelDateSerial(value), null, String(value));
  }
  const { detail } = workbook(buildLedgerXlsx({
    members,
    expenses: [{ date: "2028-02-29", amountVnd: 1 }, { date: "1899-12-31", amountVnd: 1 }, { date: null, amountVnd: 1 }],
  }));
  assert.deepEqual(values(detail.cells, ["B2", "B3", "B4"]), [46_812, "1899-12-31", null]);
  assert.equal(detail.cells.get("B2").style.format, "dd/mm/yyyy");
  assert.equal(detail.cells.get("B3").type, "inlineStr");
});

test("column letters past Z, and a ledger with 50 members", () => {
  assert.deepEqual([0, 25, 26, 51, 52, 55, 701, 702].map(columnName), ["A", "Z", "AA", "AZ", "BA", "BD", "ZZ", "AAA"]);
  const people = Array.from({ length: 50 }, (_, index) => ({ id: `m${index}`, name: `Người ${index + 1}`, groupId: index < 10 ? "g" : null }));
  const { detail, summary } = workbook(buildLedgerXlsx({
    members: people,
    groups: [{ id: "g", name: "Mười" }],
    expenses: [{ payerId: "m0", date: "2026-01-02", description: "Cả nhóm", amountVnd: 50_000, participantIds: people.map((member) => member.id) }],
  }));
  assert.match(detail.xml, /<dimension ref="A1:BD2"\/>/);
  assert.deepEqual(values(detail.cells, ["E1", "BB1", "BC1", "BD1", "BB2", "BC2", "BD2"]), ["Người 1", "Người 50", "Số người", "Số tiền/người (đ)", "x", 50, 1_000]);
  assert.match(summary.xml, /<dimension ref="A1:AY7"\/>/);
  assert.deepEqual([...summary.xml.matchAll(/<mergeCell ref="([A-Z0-9:]+)"\/>/g)].map((match) => match[1]), ["B6:K6", "B7:K7"]);
  // The group: ten shares of 1.000đ, and Người 1 paid 50.000đ.
  assert.equal(summary.cells.get("B6").value, 10 * 1_000 - 50_000);
});

test("the file name has the slug and the viewer's local date", () => {
  assert.equal(xlsxFileName("chill-guys", new Date(2026, 9, 5, 23, 59)), "so-chi-chill-guys-2026-10-05.xlsx");
  assert.equal(xlsxFileName("da-lat-2026", new Date(2027, 0, 1, 0, 0)), "so-chi-da-lat-2026-2027-01-01.xlsx");
});

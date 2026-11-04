import assert from "node:assert/strict";
import test from "node:test";
import { calculateBalances } from "../public/accounting.mjs";
import { buildLedgerCsv, csvFileName, csvSeparator } from "../public/js/csv.js";

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

// RFC 4180 reader (quotes, doubled quotes, separators and line breaks inside quotes) to check what Excel would see.
function readCsv(text, separator) {
  assert.ok(text.startsWith("\uFEFF"), "UTF-8 BOM");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === separator) { row.push(cell); cell = ""; } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""; index += 1;
    } else cell += character;
  }
  assert.equal(cell, "", "the file ends with CRLF");
  return rows;
}

test("the CSV has a Detail section, a blank line and a Summary section (BOM, CRLF, plain integers)", () => {
  const csv = buildLedgerCsv({ members, groups, expenses, payments, separator: "," });
  assert.equal(csv, "\uFEFF" + [
    "Người chi,Ngày,Nội dung,Chi phí (đ),An,Bình,Chi,Số người,Số tiền/người (đ)",
    "An,2026-10-01,Ăn trưa,100000,x,x,x,3,33333",
    "Chi,,Hoàn tiền vé,-90001,,x,x,2,-45001",
    ",,,0,,,,,",
    "",
    "Thành viên,Tiền phải chịu (đ),Đã chi (đ),Đã chuyển khoản (đ),Số dư (đ),Nhóm",
    "An,33334,100000,20000,-86666,Nhà Vải",
    "Bình,-11668,0,0,-11668,Nhà Vải",
    "Chi,-11667,-90001,0,78334,",
  ].join("\r\n") + "\r\n");
  // Summary numbers are calculateBalances' (pending payments ignored).
  const balances = calculateBalances(members, expenses, payments);
  const summary = readCsv(csv, ",").slice(6);
  assert.deepEqual(summary.map((row) => row.slice(1, 5).map(Number)), balances.map((member) => [member.shareVnd, member.paidExpenseVnd, member.paidToAdminVnd, member.balanceVnd]));
});

test("with a decimal-comma locale the separator is ';' and only fields that need it are quoted", () => {
  const csv = buildLedgerCsv({
    members: [{ id: "a", name: "An; Bình" }],
    expenses: [{ payerId: "a", date: "2026-10-01", description: 'Phở, "đặc biệt"\nbàn 2', amountVnd: 120_500, participantIds: ["a"] }],
    separator: ";",
  });
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], 'Người chi;Ngày;Nội dung;Chi phí (đ);"An; Bình";Số người;Số tiền/người (đ)');
  assert.equal(lines[1], '"An; Bình";2026-10-01;"Phở, ""đặc biệt""\nbàn 2";120500;x;1;120500');
  const rows = readCsv(csv, ";");
  assert.deepEqual(rows[1], ["An; Bình", "2026-10-01", 'Phở, "đặc biệt"\nbàn 2', "120500", "x", "1", "120500"]);
  // With "," as separator the comma forces quotes too.
  assert.match(buildLedgerCsv({ members: [], expenses: [{ description: "a,b", amountVnd: 1 }], separator: "," }), /\r\n,,"a,b",1,,\r\n/);
});

test("text that Excel would run as a formula gets a leading apostrophe; numbers keep their minus", () => {
  const evil = ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tTab", "\rCR"];
  const csv = buildLedgerCsv({
    members: evil.map((name, index) => ({ id: `m${index}`, name, groupId: "g" })),
    groups: [{ id: "g", name: "=cmd|' /C calc'!A0" }],
    expenses: evil.map((description, index) => ({ payerId: `m${index}`, date: null, description, amountVnd: -5_000, participantIds: [`m${index}`] })),
    separator: ",",
  });
  const rows = readCsv(csv, ",");
  assert.deepEqual(rows[0].slice(4, 10), evil.map((name) => `'${name}`));
  for (const [index, text] of evil.entries()) {
    const row = rows[index + 1];
    assert.equal(row[0], `'${text}`, `payer ${index}`);
    assert.equal(row[2], `'${text}`, `description ${index}`);
    assert.equal(row[3], "-5000", `amount ${index}`);
    assert.equal(row.at(-1), "-5000", `per person ${index}`);
  }
  const summary = rows.slice(evil.length + 3);
  assert.deepEqual(summary.map((row) => row[0]), evil.map((name) => `'${name}`));
  assert.equal(summary[0][5], "'=cmd|' /C calc'!A0");
  assert.equal(summary[0][1], "-5000");
  // Safe text is left alone.
  assert.match(buildLedgerCsv({ members: [], expenses: [{ description: "Ăn = 3 món", amountVnd: 1 }] }), /,Ăn = 3 món,/);
});

test("per-person amounts round to whole đồng away from zero; empty when nobody shares or the amount is 0", () => {
  const rows = readCsv(buildLedgerCsv({
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
    ],
  }), ",");
  assert.deepEqual(rows.slice(1, 9).map((row) => [row.at(-2), row.at(-1)]), [
    ["3", "33333"], ["3", "66667"], ["3", "-66667"], ["2", "3"], ["2", "-3"], ["", ""], ["1", ""], ["1", "1000"],
  ]);
});

test("the separator follows the browser's number format; the file name has the slug and the local date", () => {
  assert.equal(csvSeparator("vi-VN"), ";");
  assert.equal(csvSeparator("de-DE"), ";");
  assert.equal(csvSeparator("en-US"), ",");
  assert.equal(csvSeparator("ja-JP"), ",");
  assert.equal(csvFileName("chill-guys", new Date(2026, 9, 5, 23, 59)), "so-chi-chill-guys-2026-10-05.csv");
  assert.equal(csvFileName("da-lat-2026", new Date(2027, 0, 1, 0, 0)), "so-chi-da-lat-2026-2027-01-01.csv");
});

test("a lone carriage return or line feed inside a text field is quoted, not a row break", () => {
  for (const separator of [",", ";"]) {
    const csv = buildLedgerCsv({
      members,
      expenses: [{ id: "x", payerId: "a", date: null, description: "Một\rHai", amountVnd: 1_000, participantIds: ["a"] },
        { id: "y", payerId: "a", date: null, description: "Ba\nBốn", amountVnd: 1_000, participantIds: ["a"] }],
      separator,
    });
    assert.ok(csv.includes(`${separator}"Một\rHai"${separator}`), `bare CR quoted (${separator})`);
    assert.ok(csv.includes(`${separator}"Ba\nBốn"${separator}`), `bare LF quoted (${separator})`);
  }
});

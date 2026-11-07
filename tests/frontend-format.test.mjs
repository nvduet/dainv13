import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseThousandInput } from "../public/accounting.mjs";
import {
  balanceClass,
  escapeHtml,
  formatAverageThousand,
  formatLocalDate,
  formatLocalDateTime,
  formatThousandInput,
  formatTransferInput,
  formatVnd,
  formatVndInput,
  groupColorClass,
  parseAmountInput,
  parseAmountOrZero,
  parseTransferInput,
  toggleAmountSign,
  unbreakable,
} from "../public/js/format.js";
import { MAX_AMOUNT_VND } from "../public/shared/constants.mjs";

// Mô phỏng trình duyệt: thay vùng chọn bằng ký tự gõ rồi chạy bộ định dạng như sự kiện input.
function typeInto(value, selectionStart, selectionEnd, text) {
  let current = value;
  let start = selectionStart;
  let end = selectionEnd;
  for (const character of text) {
    current = current.slice(0, start) + character + current.slice(end);
    const formatted = formatTransferInput(current, start + 1);
    current = formatted.value;
    start = formatted.cursor;
    end = formatted.cursor;
  }
  return { value: current, cursor: start };
}

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(escapeHtml(`Cà phê <b>sáng</b> & "bánh" 'x'`), "Cà phê &lt;b&gt;sáng&lt;/b&gt; &amp; &quot;bánh&quot; &#39;x&#39;");
  assert.equal(escapeHtml(42), "42");
});

test("formatVnd uses Vietnamese grouping", () => {
  assert.equal(formatVnd(445_500), "445.500đ");
  assert.equal(formatVnd(-326_666), "-326.666đ");
  assert.equal(formatVnd(0), "0đ");
});

test("formatVndInput keeps the sign and a lone minus", () => {
  assert.equal(formatVndInput(120_000), "120.000đ");
  assert.equal(formatVndInput(-30_000), "-30.000đ");
  assert.equal(formatVndInput(0), "0đ");
  assert.equal(formatVndInput("1.200.000đ"), "1.200.000đ");
  assert.equal(formatVndInput(" -5a0"), "-50đ");
  assert.equal(formatVndInput(""), "");
  assert.equal(formatVndInput("-"), "-");
  assert.equal(formatVndInput("đ"), "");
});

test("transfer input formatting keeps the caret after the digits and the minus sign", () => {
  assert.deepEqual(typeInto("", 0, 0, "120000"), { value: "120.000đ", cursor: 7 });
  assert.deepEqual(typeInto("0đ", 0, 2, "-200000"), { value: "-200.000đ", cursor: 8 });
  assert.deepEqual(typeInto("0đ", 0, 2, "-"), { value: "-", cursor: 1 });
  assert.deepEqual(typeInto("", 0, 0, "-"), { value: "-", cursor: 1 });
  assert.deepEqual(typeInto("5.000đ", 0, 0, "-"), { value: "-5.000đ", cursor: 1 });
  assert.deepEqual(typeInto("5.000đ", 0, 0, "-1"), { value: "-15.000đ", cursor: 2 });
  assert.deepEqual(typeInto("5.000đ", 5, 5, "0"), { value: "50.000đ", cursor: 6 });
  assert.deepEqual(formatTransferInput("12.3456đ", 4), { value: "123.456đ", cursor: 3 });
});

test("parseTransferInput reads digits with an optional leading minus", () => {
  assert.equal(parseTransferInput("120.000đ"), 120_000n);
  assert.equal(parseTransferInput("-30.000đ"), -30_000n);
  assert.equal(parseTransferInput("-"), 0n);
  assert.equal(parseTransferInput(""), 0n);
  assert.equal(parseTransferInput("1-2"), 12n);
  assert.equal(parseTransferInput("-1.000.000.000.001đ") < -BigInt(MAX_AMOUNT_VND), true);
});

test("thousand inputs round-trip through parseThousandInput", () => {
  const amounts = [1, -1, 999, 1000, 1001, 75_500, 360_500, -90_000, 671_238, 123_456_789_012, MAX_AMOUNT_VND, -MAX_AMOUNT_VND];
  for (let seed = 1; seed <= 200; seed += 1) {
    amounts.push(((seed * 2_654_435_761) % 999_999_999_989) * (seed % 2 ? 1 : -1) || 7);
  }
  for (const amount of amounts) {
    assert.equal(parseThousandInput(formatThousandInput(amount)), amount, `round-trip ${amount}`);
  }
  assert.equal(formatThousandInput(360_500), "360.5");
  assert.equal(formatThousandInput(-90_000), "-90");
  assert.equal(formatThousandInput(1), "0.001");
});

test("formatAverageThousand never shows negative zero", () => {
  assert.equal(formatAverageThousand(360_000, 3), "120");
  assert.equal(formatAverageThousand(-90_000, 2), "-45");
  assert.equal(formatAverageThousand(100_000, 3), "33");
  assert.equal(formatAverageThousand(-1000, 3), "0");
  assert.equal(formatAverageThousand(-1, 2), "0");
  assert.equal(formatAverageThousand(1, 2), "0");
});

test("parseAmountOrZero treats empty and invalid text as zero", () => {
  assert.equal(parseAmountOrZero(""), 0);
  assert.equal(parseAmountOrZero("   "), 0);
  assert.equal(parseAmountOrZero("abc"), 0);
  assert.equal(parseAmountOrZero("0"), 0);
  assert.equal(parseAmountOrZero("360,5"), 360_500);
  assert.equal(parseAmountOrZero(" -90 "), -90_000);
  for (const zero of ["-0", "0,0", "0.0004"]) assert.ok(Object.is(parseAmountOrZero(zero), 0), zero);
  assert.equal(parseAmountOrZero("0.0005"), 1);
});

test("the amount cell saves empty text and amounts that round to 0 đồng as 0, and rejects invalid text", () => {
  for (const zero of ["", "   ", "0", "-0", "0,0", "0.0004"]) {
    assert.ok(Object.is(parseAmountInput(zero), 0), JSON.stringify(zero));
  }
  assert.equal(parseAmountInput(" 360,5 "), 360_500);
  assert.equal(parseAmountInput("-165"), -165_000);
  for (const invalid of ["abc", "1.2.3", String(MAX_AMOUNT_VND / 1000 + 1)]) {
    assert.throws(() => parseAmountInput(invalid), invalid);
  }
});

test("the ± button adds or removes a leading minus and keeps the caret next to the same digits", () => {
  assert.deepEqual(toggleAmountSign("90"), { value: "-90", selectionStart: 3, selectionEnd: 3 });
  assert.deepEqual(toggleAmountSign("-90"), { value: "90", selectionStart: 2, selectionEnd: 2 });
  assert.deepEqual(toggleAmountSign("360,5", 1, 3), { value: "-360,5", selectionStart: 2, selectionEnd: 4 });
  assert.deepEqual(toggleAmountSign("-360,5", 0, 0), { value: "360,5", selectionStart: 0, selectionEnd: 0 });
  assert.deepEqual(toggleAmountSign(" 75.5"), { value: "-75.5", selectionStart: 5, selectionEnd: 5 });
  assert.deepEqual(toggleAmountSign(""), { value: "-", selectionStart: 1, selectionEnd: 1 });
  assert.deepEqual(toggleAmountSign("-"), { value: "", selectionStart: 0, selectionEnd: 0 });
  // Kết quả lưu giống hệt khi gõ dấu trừ.
  assert.equal(parseAmountInput(toggleAmountSign("90").value), -90_000);
  assert.equal(parseAmountInput(toggleAmountSign(toggleAmountSign("90").value).value), 90_000);
});

test("the ± button negates a whole arithmetic expression and undoes it on the second tap", () => {
  assert.deepEqual(toggleAmountSign("120+45"), { value: "-(120+45)", selectionStart: 8, selectionEnd: 8 });
  assert.deepEqual(toggleAmountSign("-(120+45)"), { value: "120+45", selectionStart: 6, selectionEnd: 6 });
  assert.deepEqual(toggleAmountSign("120+45", 2, 4), { value: "-(120+45)", selectionStart: 4, selectionEnd: 6 });
  assert.deepEqual(toggleAmountSign("-(120+45)", 0, 9), { value: "120+45", selectionStart: 0, selectionEnd: 6 });
  // A leading minus inside an expression is negated, not just removed; a "-(…)" that does not wrap everything is wrapped.
  assert.equal(toggleAmountSign("-90+10").value, "-(-90+10)");
  assert.equal(toggleAmountSign("-(1)+(2)").value, "-(-(1)+(2))");
  assert.equal(toggleAmountSign(" 300/2").value, "-(300/2)");
  for (const text of ["120+45", "-90+10", "300/2", "1,5*3", "-(1)+(2)", "(5)", "6×7"]) {
    const once = toggleAmountSign(text).value;
    assert.equal(parseAmountInput(once), -parseAmountInput(text), `${text} -> ${once}`);
    assert.equal(parseAmountInput(toggleAmountSign(once).value), parseAmountInput(text), `${text} twice`);
  }
});

test("the amount cell previews and saves the result of an expression", () => {
  assert.equal(parseAmountInput("120+45"), 165_000);
  assert.equal(parseAmountInput(" 300/2 "), 150_000);
  assert.equal(parseAmountOrZero("1,5*3"), 4_500);
  assert.equal(parseAmountOrZero("120+"), 0);
  assert.equal(parseAmountOrZero("1/0"), 0);
  assert.throws(() => parseAmountInput("1/0"), { message: "Không thể chia cho 0." });
  assert.throws(() => parseAmountInput("120+"), { message: "Nhập chi phí bằng nghìn đồng, có thể là số âm, ví dụ 360 hoặc -165." });
  assert.ok(Object.is(parseAmountInput("5-5"), 0));
  // The cell shows the evaluated number on blur: it reads back to the same amount.
  assert.equal(formatThousandInput(parseAmountInput("100/3")), "33.333");
  assert.equal(parseAmountInput(formatThousandInput(parseAmountInput("100/3"))), parseAmountInput("100/3"));
});

test("server UTC timestamps are shown in the viewer's local time", (t) => {
  const timeZone = process.env.TZ;
  t.after(() => {
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  });
  process.env.TZ = "Asia/Ho_Chi_Minh";
  assert.equal(formatLocalDateTime("2026-11-02 23:59:59"), "2026-11-03 06:59:59");
  assert.equal(formatLocalDateTime("2026-12-31 17:00:00"), "2027-01-01 00:00:00");
  assert.equal(formatLocalDateTime("2026-01-01 00:00:05"), "2026-01-01 07:00:05");
  process.env.TZ = "UTC";
  assert.equal(formatLocalDateTime("2026-11-02 23:59:59"), "2026-11-02 23:59:59");
  process.env.TZ = "America/New_York";
  assert.equal(formatLocalDateTime("2026-03-01 04:30:00"), "2026-02-28 23:30:00");
});

test("missing or malformed timestamps are shown as they are", () => {
  for (const empty of [null, undefined, ""]) assert.equal(formatLocalDateTime(empty), "");
  for (const malformed of ["không rõ", "2026-13-01 00:00:00", "2026-11-02 25:00:00", "2026-11-02T01:02:03Z"]) {
    assert.equal(formatLocalDateTime(malformed), malformed);
  }
});

test("every server timestamp in admin.js is shown through formatLocalDateTime", () => {
  // Năm nơi hiện giờ (danh sách điểm lưu, hộp thoại khôi phục và xóa điểm lưu, danh sách và đầu trang diff nhật ký) đều đổi sang giờ địa phương.
  const source = readFileSync(new URL("../public/js/admin.js", import.meta.url), "utf8");
  const reads = [...source.matchAll(/[\w$]+\??\.(?:createdAt|startedAt|lastActivity)\b/g)];
  assert.equal(reads.length, 6);
  for (const read of reads) {
    assert.equal(source.slice(read.index - "formatLocalDateTime(".length, read.index), "formatLocalDateTime(", read[0]);
  }
});

test("timestamps inside a sentence do not break at their hyphens or space", () => {
  assert.equal(unbreakable("2026-01-01 00:00:00"), "2026\u201101\u201101\u00a000:00:00");
  assert.equal(unbreakable(""), "");
  assert.doesNotMatch(unbreakable(formatLocalDateTime("2026-11-02 23:59:59")), /[- ]/);
});

test("balance and group colour classes", () => {
  assert.equal(balanceClass(1), "balance-positive");
  assert.equal(balanceClass(-1), "balance-negative");
  assert.equal(balanceClass(0), "balance-zero");
  assert.equal(groupColorClass(0), "group-color-0");
  assert.equal(groupColorClass(7), "group-color-1");
});

test("expense dates are shown in the browser's date format, like the Date cell of the table", () => {
  assert.equal(formatLocalDate("2026-10-01", "vi-VN"), "01/10/2026");
  assert.equal(formatLocalDate("2026-10-01", "en-US"), "10/01/2026");
  assert.equal(formatLocalDate("2026-12-31", "en-US"), "12/31/2026", "no time-zone shift around midnight");
  assert.equal(formatLocalDate(null), "");
  assert.equal(formatLocalDate("31/12/2026"), "31/12/2026", "anything else is shown as it is");
});

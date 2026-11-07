// Xuất Excel: một file .xlsx gồm hai trang tính, "Detail" (như bảng Detail) và "Summary" (như bảng Summary, mỗi thành
// viên một cột). Không phụ thuộc DOM (có kiểm thử): tự dựng các phần OOXML tối thiểu rồi gói ZIP không nén (STORE,
// CRC-32). Chữ luôn là chuỗi (inline string), không bao giờ là công thức; tiền là số nguyên đồng định dạng #,##0; ngày
// là ngày thật của Excel, hiện dd/mm/yyyy.
import { calculateBalances } from "../accounting.mjs";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ---------- ZIP (STORE) ----------

let crcTable = null;

export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Ngày giờ kiểu MS-DOS theo giờ của máy (ZIP chỉ ghi được năm 1980–2107).
function dosDateTime(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const UTF8_NAMES = 0x0800;

// files: [{ name, data: string | Uint8Array }] theo thứ tự ghi. Không nén (method 0), tên file đánh dấu UTF-8.
export function zipFiles(files, modified = new Date()) {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(modified);
  const entries = files.map(({ name, data }) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    return { name: encoder.encode(name), bytes, crc: crc32(bytes), offset: 0 };
  });
  const size = entries.reduce((total, entry) => total + 30 + 46 + 2 * entry.name.length + entry.bytes.length, 22);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  let at = 0;
  const u16 = (value) => { view.setUint16(at, value, true); at += 2; };
  const u32 = (value) => { view.setUint32(at, value, true); at += 4; };
  const put = (bytes) => { output.set(bytes, at); at += bytes.length; };
  const common = (entry) => {
    u16(20); // phiên bản cần để giải nén: 2.0
    u16(UTF8_NAMES);
    u16(0); // STORE
    u16(stamp.time);
    u16(stamp.date);
    u32(entry.crc);
    u32(entry.bytes.length);
    u32(entry.bytes.length);
    u16(entry.name.length);
    u16(0); // không có trường phụ
  };
  for (const entry of entries) {
    entry.offset = at;
    u32(0x04034b50);
    common(entry);
    put(entry.name);
    put(entry.bytes);
  }
  const centralStart = at;
  for (const entry of entries) {
    u32(0x02014b50);
    u16(20); // tạo bởi: MS-DOS, 2.0
    common(entry);
    u16(0); // chú thích
    u16(0); // đĩa
    u16(0); // thuộc tính trong
    u32(0); // thuộc tính ngoài
    u32(entry.offset);
    put(entry.name);
  }
  const centralSize = at - centralStart;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(centralSize);
  u32(centralStart);
  u16(0);
  return output;
}

// ---------- SpreadsheetML ----------

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOC_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const MONEY_FORMAT = 3; // #,##0 có sẵn trong Excel (dấu phân cách nghìn theo máy người mở)
const DATE_FORMAT = 164;
// Thứ tự phần tử như Excel tự ghi: b, sz, color, name, family.
const FONTS = [
  ["", ""],
  ["<b/>", ""],
  ["<b/>", '<color rgb="FFC00000"/>'], // số dư dương: còn phải nộp Admin (đỏ, như trang)
  ["<b/>", '<color rgb="FF2E7D32"/>'], // số dư âm: được Admin hoàn (xanh lá)
].map(([bold, color]) => `<font>${bold}<sz val="11"/>${color}<name val="Calibri"/><family val="2"/></font>`);
const FONT_ID = { regular: 0, bold: 1, owe: 2, refund: 3 };
const BORDER_SIDE = '<color rgb="FFBFBFBF"/>';

function escapeXml(text) {
  return String(text).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

// Chữ trong ô: ký tự XML không cho phép (ký tự điều khiển, CR bị XML đổi thành LF) viết thành _xHHHH_ như Excel, còn
// "_xHHHH_" có sẵn trong chữ được giữ nguyên nhờ _x005F_. Nửa cặp surrogate lẻ thành U+FFFD khi TextEncoder mã hóa.
function cellText(text) {
  return escapeXml(text
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1")
    .replace(/[\0-\x08\x0B-\x1F￾￿]/g, (character) => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`));
}

// 0 → A, 25 → Z, 26 → AA.
export function columnName(index) {
  let name = "";
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
  }
  return name;
}

// Kiểu ô ({ numFmt, font, fill, border, align, quotePrefix }) → chỉ số trong cellXfs; kiểu trùng nhau dùng chung.
function createStyles() {
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const ids = new Map();
  return {
    id(style) {
      if (!style) return 0;
      const { numFmt = 0, font = "regular", fill = false, border = false, align = "", quotePrefix = false } = style;
      const key = [numFmt, font, fill, border, align, quotePrefix].join("|");
      if (!ids.has(key)) {
        ids.set(key, xfs.length);
        const flags = [
          numFmt ? ' applyNumberFormat="1"' : "",
          font !== "regular" ? ' applyFont="1"' : "",
          fill ? ' applyFill="1"' : "",
          border ? ' applyBorder="1"' : "",
          align ? ' applyAlignment="1"' : "",
          quotePrefix ? ' quotePrefix="1"' : "",
        ].join("");
        const alignment = align ? `<alignment horizontal="${align}" vertical="center"/>` : "";
        xfs.push(`<xf numFmtId="${numFmt}" fontId="${FONT_ID[font]}" fillId="${fill ? 2 : 0}" borderId="${border ? 1 : 0}" xfId="0"${flags}${alignment ? `>${alignment}</xf>` : "/>"}`);
      }
      return ids.get(key);
    },
    xml() {
      const side = (name) => `<${name} style="thin">${BORDER_SIDE}</${name}>`;
      return `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}">` +
        `<numFmts count="1"><numFmt numFmtId="${DATE_FORMAT}" formatCode="dd/mm/yyyy"/></numFmts>` +
        `<fonts count="${FONTS.length}">${FONTS.join("")}</fonts>` +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
        `<border>${["left", "right", "top", "bottom"].map(side).join("")}<diagonal/></border></borders>` +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        "</styleSheet>";
    },
  };
}

// Ô: { value: string | number | null, style } — chuỗi rỗng hay null là ô trống (vẫn có viền nếu kiểu có).
function cellXml(cell, ref, styles) {
  if (!cell) return "";
  const id = styles.id(cell.style);
  const style = id ? ` s="${id}"` : "";
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
  if (typeof cell.value === "string" && cell.value !== "") {
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${cellText(cell.value)}</t></is></c>`;
  }
  return id ? `<c r="${ref}"${style}/>` : "";
}

// Cố định hàng tiêu đề và/hoặc cột đầu như hàng/cột dính của bảng trên trang.
function paneXml(rows, columns) {
  if (!rows && !columns) return "";
  const topLeft = `${columnName(columns)}${rows + 1}`;
  const pane = rows && columns ? "bottomRight" : rows ? "bottomLeft" : "topRight";
  const split = `${columns ? ` xSplit="${columns}"` : ""}${rows ? ` ySplit="${rows}"` : ""}`;
  const others = rows && columns ? '<selection pane="topRight"/><selection pane="bottomLeft"/>' : "";
  return `<pane${split} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/>${others}` +
    `<selection pane="${pane}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
}

function sheetXml({ rows, widths = [], merges = [], freeze = {} }, styles, selected) {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const dimension = `A1:${columnName(columnCount - 1)}${Math.max(1, rows.length)}`;
  const cols = widths.length
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const data = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${rowIndex + 1}`, styles)).join("")}</row>`).join("");
  const merged = merges.length ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : "";
  return `${XML_HEADER}<worksheet xmlns="${MAIN_NS}" xmlns:r="${DOC_RELS_NS}"><dimension ref="${dimension}"/>` +
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ""} workbookViewId="0">${paneXml(freeze.rows ?? 0, freeze.columns ?? 0)}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData>${merged}` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
}

// sheets: [{ name, rows, widths, merges, freeze: { rows, columns } }]; trang đầu là trang mở sẵn.
function buildXlsx(sheets, modified) {
  const styles = createStyles();
  const worksheets = sheets.map((sheet, index) => sheetXml(sheet, styles, index === 0));
  const worksheetType = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
  return zipFiles([
    {
      name: "[Content_Types].xml",
      data: `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        `${sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${worksheetType}"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_RELS_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_RELS_NS}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
        `${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELS_NS}">` +
        `${sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="${DOC_RELS_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}` +
        `<Relationship Id="rId${sheets.length + 1}" Type="${DOC_RELS_NS}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: styles.xml() },
    ...worksheets.map((xml, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: xml })),
  ], modified);
}

// Độ rộng cột (đơn vị ký tự của Excel) vừa nội dung dài nhất; ô gộp ngang (span) không tính.
function displayLength(cell) {
  if (!cell || cell.span) return 0;
  const { value, style = {} } = cell;
  if (typeof value === "string") return Math.max(...value.split(/\r\n|\r|\n/).map((line) => line.length));
  if (typeof value !== "number") return 0;
  if (style.numFmt === DATE_FORMAT) return 10;
  const digits = String(Math.abs(value));
  return (style.numFmt === MONEY_FORMAT ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : digits).length + (value < 0 ? 1 : 0);
}

function fitWidths(rows, { min = 6, max = 50 } = {}) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      const bold = (cell?.style?.font ?? "regular") !== "regular";
      const width = Math.min(max, Math.ceil(displayLength(cell) * (bold ? 1.15 : 1)) + 2);
      widths[index] = Math.max(widths[index] ?? min, width);
    });
  }
  return Array.from(widths, (width) => width ?? min);
}

// ---------- Sổ chi → hai trang tính ----------

const HEADER = { font: "bold", fill: true, border: true };
const HEADER_CENTER = { ...HEADER, align: "center" };
const TEXT = { border: true };
const CENTER = { border: true, align: "center" };
const MONEY = { numFmt: MONEY_FORMAT, border: true };
const DATE = { numFmt: DATE_FORMAT, border: true, align: "center" };
const GROUP_MONEY = { ...MONEY, font: "bold", align: "center" };

// Chữ bắt đầu bằng = + - @ đánh dấu quotePrefix: sửa ô trong Excel vẫn là chữ, không thành công thức.
function textCell(value, style = TEXT) {
  const text = String(value ?? "");
  return { value: text, style: /^[=+\-@]/.test(text) ? { ...style, quotePrefix: true } : style };
}

function numberCell(value, style = MONEY) {
  return { value: Number.isSafeInteger(value) ? value : null, style };
}

// Ngày "YYYY-MM-DD" → số ngày của Excel (hệ 1900); null nếu không phải ngày có thật trong 01/03/1900–31/12/9999.
export function excelDateSerial(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const serial = time / 86_400_000 + 25_569;
  return serial >= 61 && serial <= 2_958_465 ? serial : null;
}

// Ngày Excel không biểu diễn được thì giữ nguyên chữ; không có ngày thì ô trống.
function dateCell(value) {
  const serial = excelDateSerial(value);
  return serial === null ? textCell(value ?? "", CENTER) : { value: serial, style: DATE };
}

// Số tiền mỗi người (đ): trung bình làm tròn tới đồng (nửa đồng làm tròn ra xa 0), như cột "Số tiền/Ng".
function averagePerPerson(amountVnd, count) {
  if (!count || !amountVnd || !Number.isSafeInteger(amountVnd)) return null;
  return Math.sign(amountVnd) * Math.round(Math.abs(amountVnd) / count);
}

function detailSheet(members, expenses) {
  const namesById = new Map(members.map((member) => [member.id, member.name]));
  const rows = [[
    textCell("Người chi", HEADER), textCell("Ngày", HEADER_CENTER), textCell("Nội dung", HEADER), textCell("Chi phí (đ)", HEADER),
    ...members.map((member) => textCell(member.name, HEADER_CENTER)),
    textCell("Số người", HEADER_CENTER), textCell("Số tiền/người (đ)", HEADER),
  ]];
  for (const expense of expenses) {
    const participants = new Set(expense.participantIds ?? []);
    const count = members.filter((member) => participants.has(member.id)).length;
    rows.push([
      textCell(namesById.get(expense.payerId) ?? ""),
      dateCell(expense.date),
      textCell(expense.description ?? ""),
      numberCell(expense.amountVnd),
      ...members.map((member) => textCell(participants.has(member.id) ? "x" : "", CENTER)),
      numberCell(count || null, CENTER),
      numberCell(averagePerPerson(expense.amountVnd, count)),
    ]);
  }
  return { name: "Detail", rows, widths: fitWidths(rows, { max: 60 }), freeze: { rows: 1 } };
}

// Thành viên liền nhau cùng nhóm gộp thành một đoạn (như balanceSegments của summary.js); người chưa thuộc nhóm
// đứng riêng một đoạn.
function balanceSegments(summary, groups) {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const segments = [];
  for (const member of summary) {
    const group = member.groupId ? groupsById.get(member.groupId) : null;
    const previous = segments.at(-1);
    if (group && previous?.group?.id === group.id) previous.members.push(member);
    else segments.push({ group, members: [member] });
  }
  return segments;
}

function balanceStyle(amountVnd, style) {
  return amountVnd > 0 ? { ...style, font: "owe" } : amountVnd < 0 ? { ...style, font: "refund" } : style;
}

const SUMMARY_ROWS = [
  ["Tiền phải chịu", "shareVnd"],
  ["Đã chi", "paidExpenseVnd"],
  ["Đã chuyển khoản", "paidToAdminVnd"],
  ["Số dư", "balanceVnd"],
];

// Như bảng Summary trên trang: cột A là nhãn, mỗi thành viên một cột theo thứ tự của trang (cùng nhóm đứng cạnh nhau),
// hàng "Số dư nhóm" gộp ô theo nhóm; thêm hàng "Nhóm" ghi tên nhóm (trên trang tên nhóm chỉ có trong nhãn đọc màn hình).
function summarySheet(members, groups, expenses, payments) {
  const summary = calculateBalances(members, expenses, payments);
  const rows = [
    [textCell("Tên thành viên", HEADER), ...summary.map((member) => textCell(member.name, HEADER_CENTER))],
    ...SUMMARY_ROWS.map(([label, key]) => [
      textCell(label, HEADER),
      ...summary.map((member) => numberCell(member[key], key === "balanceVnd" ? balanceStyle(member[key], MONEY) : MONEY)),
    ]),
  ];
  const merges = [];
  if (!summary.length) {
    rows[0].push(textCell("Thêm thành viên để bắt đầu sổ chi nhé.", CENTER));
    for (const row of rows.slice(1)) row.push({ value: null, style: CENTER });
    merges.push(`B1:B${rows.length}`);
    return { name: "Summary", rows, widths: fitWidths(rows), merges, freeze: { rows: 1, columns: 1 } };
  }
  const segments = balanceSegments(summary, groups);
  const groupRow = [textCell("Số dư nhóm", HEADER)];
  const nameRow = [textCell("Nhóm", HEADER)];
  for (const segment of segments) {
    const start = groupRow.length;
    const amount = segment.members.reduce((total, member) => total + member.balanceVnd, 0);
    const span = segment.members.length > 1;
    const amountStyle = balanceStyle(amount, GROUP_MONEY);
    const name = textCell(segment.group?.name ?? "", CENTER);
    groupRow.push({ ...numberCell(amount, amountStyle), span });
    nameRow.push({ ...name, span });
    for (let index = 1; index < segment.members.length; index += 1) {
      groupRow.push({ value: null, style: amountStyle, span });
      nameRow.push({ value: null, style: name.style, span });
    }
    if (span) {
      const range = (row) => `${columnName(start)}${row}:${columnName(start + segment.members.length - 1)}${row}`;
      merges.push(range(rows.length + 1), range(rows.length + 2));
    }
  }
  rows.push(groupRow);
  // Sổ chưa có nhóm nào thì hàng "Nhóm" để trống, bỏ đi (khi đó cũng không có ô gộp).
  if (segments.some((segment) => segment.group)) rows.push(nameRow);
  return { name: "Summary", rows, widths: fitWidths(rows, { min: 10 }), merges, freeze: { rows: 1, columns: 1 } };
}

// expenses theo thứ tự nhập, mỗi khoản { payerId, date, description, amountVnd, participantIds } (như bảng đang hiện).
export function buildLedgerXlsx({ members, groups = [], expenses, payments = [], date = new Date() }) {
  return buildXlsx([detailSheet(members, expenses), summarySheet(members, groups, expenses, payments)], date);
}

// so-chi-<slug>-<YYYY-MM-DD>.xlsx theo ngày của máy người xem.
export function xlsxFileName(slug, date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return `so-chi-${slug}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.xlsx`;
}

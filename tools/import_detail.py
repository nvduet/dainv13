import argparse
import posixpath
import re
import zipfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from xml.etree import ElementTree


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NAMESPACES = {"m": MAIN_NS, "r": REL_NS}
MEMBER_COLUMNS = range(4, 24)


def column_number(reference):
    letters = re.match(r"[A-Z]+", reference)
    if not letters:
        raise ValueError(f"Cell reference không hợp lệ: {reference}")
    value = 0
    for letter in letters.group():
        value = value * 26 + ord(letter) - ord("A") + 1
    return value


def cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(text.text or "" for text in cell.findall(".//m:t", NAMESPACES))
    value = cell.find("m:v", NAMESPACES)
    if value is None:
        return ""
    raw = value.text or ""
    if cell_type == "s":
        return shared_strings[int(raw)]
    return raw


def worksheet_path(archive, sheet_name):
    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    relationships = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {
        item.attrib["Id"]: item.attrib["Target"]
        for item in relationships.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
    }
    for sheet in workbook.findall("m:sheets/m:sheet", NAMESPACES):
        if sheet.attrib["name"] != sheet_name:
            continue
        target = targets[sheet.attrib[f"{{{REL_NS}}}id"]]
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        if path not in archive.namelist():
            raise ValueError(f"Không tìm thấy worksheet {sheet_name!r} trong workbook.")
        return path
    raise ValueError(f"Workbook không có tab {sheet_name!r}.")


def load_detail(workbook_path):
    with zipfile.ZipFile(workbook_path) as archive:
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [
                "".join(text.text or "" for text in item.findall(".//m:t", NAMESPACES))
                for item in shared_root.findall("m:si", NAMESPACES)
            ]
        else:
            shared_strings = []

        root = ElementTree.fromstring(archive.read(worksheet_path(archive, "Detail")))
        rows = root.findall(".//m:sheetData/m:row", NAMESPACES)
        header_row = next((row for row in rows if row.attrib.get("r") == "5"), None)
        if header_row is None:
            raise ValueError("Tab Detail thiếu tiêu đề ở dòng 5.")

        headers = {}
        for cell in header_row.findall("m:c", NAMESPACES):
            column = column_number(cell.attrib.get("r", ""))
            if column in MEMBER_COLUMNS:
                name = cell_value(cell, shared_strings).strip()
                if name:
                    headers[column] = name
        if not headers:
            raise ValueError("Không tìm thấy tên thành viên ở các cột D:W.")
        if len(set(name.casefold() for name in headers.values())) != len(headers):
            raise ValueError("Tên thành viên trong tiêu đề bị trùng.")

        expenses = []
        for row in rows:
            row_number = int(row.attrib.get("r", "0"))
            if row_number < 6:
                continue
            values = {
                column_number(cell.attrib.get("r", "")): cell_value(cell, shared_strings)
                for cell in row.findall("m:c", NAMESPACES)
            }
            payer = values.get(1, "").strip()
            description = values.get(2, "").strip()
            amount_text = values.get(3, "").strip()
            if not payer and not description and not amount_text:
                continue
            if payer not in headers.values():
                raise ValueError(f"Dòng {row_number}: người chi không có trong danh sách thành viên.")
            if not description:
                raise ValueError(f"Dòng {row_number}: thiếu nội dung khoản chi.")
            try:
                amount_vnd = int(
                    (Decimal(amount_text) * 1000).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
                )
            except (InvalidOperation, ValueError):
                raise ValueError(f"Dòng {row_number}: số tiền không hợp lệ.") from None
            if amount_vnd <= 0:
                raise ValueError(f"Dòng {row_number}: số tiền sau khi làm tròn phải lớn hơn 0.")

            participants = [
                headers[column]
                for column in sorted(headers)
                if values.get(column, "").strip().casefold() == "x"
            ]
            if not participants:
                raise ValueError(f"Dòng {row_number}: khoản chi chưa chọn người tham gia.")
            expenses.append({
                "row": row_number,
                "payer": payer,
                "description": description,
                "amount_vnd": amount_vnd,
                "participants": participants,
            })
        return list(headers.values()), expenses


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


def make_sql(members, expenses):
    member_ids = {name: f"member-import-{index:02d}" for index, name in enumerate(members)}
    statements = [
        "-- Generated locally from the Detail worksheet. Keep this file out of version control.",
        "INSERT OR IGNORE INTO members (id, name, position) VALUES",
        ",\n".join(
            f"  ({sql_string(member_ids[name])}, {sql_string(name)}, {index})"
            for index, name in enumerate(members)
        ) + ";",
    ]
    if not expenses:
        return "\n\n".join(statements) + "\n"

    statements.extend([
        "INSERT OR IGNORE INTO expenses (id, payer_id, description, amount_vnd, position) VALUES",
        ",\n".join(
            "  ({}, {}, {}, {}, {})".format(
                sql_string(f"detail-import-{expense['row']:06d}"),
                sql_string(member_ids[expense["payer"]]),
                sql_string(expense["description"]),
                expense["amount_vnd"],
                index,
            )
            for index, expense in enumerate(expenses)
        ) + ";",
        "INSERT OR IGNORE INTO expense_participants (expense_id, member_id) VALUES",
        ",\n".join(
            "  ({}, {})".format(
                sql_string(f"detail-import-{expense['row']:06d}"),
                sql_string(member_ids[participant]),
            )
            for expense in expenses
            for participant in expense["participants"]
        ) + ";",
    ])
    return "\n\n".join(statements) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Import only the Detail tab into a local SQL file.")
    parser.add_argument("workbook", type=Path, help="Path to the exported .xlsx workbook")
    parser.add_argument("--output", type=Path, required=True, help="Generated SQL path, preferably under .local/")
    args = parser.parse_args()
    if not args.workbook.is_file():
        parser.error(f"Workbook not found: {args.workbook}")
    members, expenses = load_detail(args.workbook)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(make_sql(members, expenses), encoding="utf-8")
    print(f"Generated {args.output}: {len(members)} members, {len(expenses)} expenses.")


if __name__ == "__main__":
    main()

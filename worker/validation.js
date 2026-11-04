import {
  COLUMN_WIDTH,
  DEFAULT_COLUMN_WIDTHS,
  MAX_AMOUNT_VND,
  MAX_MEMBERS,
  MAX_NAME_LENGTH,
} from "../public/shared/constants.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_NAME_LENGTH;
}

export function validSignedAmount(value) {
  return Number.isSafeInteger(value) &&
    value >= -MAX_AMOUNT_VND &&
    value <= MAX_AMOUNT_VND;
}

export function validId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 80;
}

export function validIds(value, { allowEmpty = false } = {}) {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_MEMBERS &&
    value.every(validId) &&
    new Set(value).size === value.length;
}

// Every column role of DEFAULT_COLUMN_WIDTHS is required, and nothing else is accepted.
export function validColumnWidths(value) {
  return isPlainObject(value) &&
    Object.keys(value).length === Object.keys(DEFAULT_COLUMN_WIDTHS).length &&
    Object.entries(DEFAULT_COLUMN_WIDTHS).every(([group, defaults]) => {
      const widths = value[group];
      return isPlainObject(widths) &&
        Object.keys(widths).length === Object.keys(defaults).length &&
        Object.keys(defaults).every((key) =>
          Number.isSafeInteger(widths[key]) &&
          widths[key] >= COLUMN_WIDTH.min &&
          widths[key] <= COLUMN_WIDTH.max,
        );
    });
}

export function validExpenseDate(value) {
  if (value === null || value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validParticipantChanges(value) {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).some((key) => key !== "add" && key !== "remove")) return false;
  const add = value.add ?? [];
  const remove = value.remove ?? [];
  return validIds(add, { allowEmpty: true }) &&
    validIds(remove, { allowEmpty: true }) &&
    !add.some((id) => remove.includes(id));
}

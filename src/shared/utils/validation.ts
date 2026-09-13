/** Shared input and domain validation. Values are strings to preserve card-code zeros. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const ARABIC_OR_LATIN_LETTER = /[A-Za-z\u0621-\u064A\u066E\u066F\u0671-\u06D3]/;

export type InputKind = "phone" | "cardCode" | "integer" | "decimal" | "email" | "name";

export function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeDigits(value: string): string {
  return value.replace(/[\u0660-\u0669]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

/** Sanitizes every onChangeText value, including values supplied by paste. */
export function sanitizeInput(value: string, kind?: InputKind): string {
  const normalized = normalizeDigits(value);
  if (kind === "phone" || kind === "cardCode" || kind === "integer") return normalized.replace(/\D/g, "");
  if (kind === "decimal") {
    const cleaned = normalized.replace(/[^0-9.]/g, "");
    const [whole = "", ...decimal] = cleaned.split(".");
    return decimal.length ? `${whole}.${decimal.join("")}` : whole;
  }
  return normalized.replace(CONTROL_CHARS, "");
}

export function isEgyptianPhone(value: string): boolean {
  return /^(010|011|012|015)\d{8}$/.test(normalizeDigits(value));
}

export function isNumericCode(value: string): boolean {
  return /^\d+$/.test(normalizeDigits(value));
}

export function isValidName(value: string, maxLength = 120): boolean {
  const name = normalizeSpaces(value);
  return Boolean(name) && name.length <= maxLength && !CONTROL_CHARS.test(value) && ARABIC_OR_LATIN_LETTER.test(name);
}

export function isValidMoney(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const ValidationMessages = {
  required: "الحقل ده مطلوب",
  phone: "اكتب رقم موبايل صحيح من 11 رقم",
  code: "الكود لازم يكون أرقام فقط",
  name: "اكتب اسمًا صحيحًا، وليس أرقامًا فقط",
  money: "اكتب السعر بشكل صحيح",
  time: "اكتب الوقت بصيغة صحيحة مثل 09:30",
  date: "اكتب تاريخًا صحيحًا",
};

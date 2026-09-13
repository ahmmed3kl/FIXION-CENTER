/** Search-only normalization. It never changes the value persisted in SQLite. */
export function normalizeArabicForSearch(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function normalizeForSearch(value: unknown): string {
  return normalizeArabicForSearch(value);
}

function compactCompoundName(value: string): string {
  // A compact spelling is a secondary representation, so ordinary words
  // separated by spaces are never treated as one word for ranking.
  return value.replace(/\s+(?=ال)/g, "");
}

function safeArabicVariants(value: string): string[] {
  const variants = new Set<string>([value]);
  const words = value.split(" ");
  const last = words.length - 1;
  if (last >= 0 && words[last]) {
    // Common, low-risk final-letter spellings: جنى/جنا and similar names.
    if (words[last].endsWith("ا")) variants.add([...words.slice(0, last), `${words[last].slice(0, -1)}ي`].join(" "));
    if (words[last].endsWith("ي")) variants.add([...words.slice(0, last), `${words[last].slice(0, -1)}ا`].join(" "));
  }
  variants.add(compactCompoundName(value));
  return [...variants];
}

export function searchRepresentations(value: unknown): string[] {
  const normalized = normalizeForSearch(value);
  return safeArabicVariants(normalized);
}

export function smartMatch(value: unknown, query: unknown): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  const queryForms = safeArabicVariants(q);
  return searchRepresentations(value).some((candidate) =>
    queryForms.some((form) => candidate.includes(form)),
  );
}

export function rankSearchResult(value: unknown, query: unknown): number {
  const q = normalizeForSearch(query);
  if (!q) return 0;
  const forms = safeArabicVariants(q);
  const candidates = searchRepresentations(value);
  let best = -1;
  for (const candidate of candidates) {
    for (const form of forms) {
      const words = candidate.split(" ");
      const score = candidate === form
        ? 1000
        : candidate.startsWith(form)
          ? 800
          : words.some((word) => word.startsWith(form))
            ? 650
            : candidate.includes(form)
              ? 400
              : -1;
      best = Math.max(best, score);
    }
  }
  return best;
}

export interface SmartSearchField<T> {
  value?: unknown;
  weight?: number;
  get?: (item: T) => unknown;
}

export function smartSearch<T>(items: T[], query: string, fields: SmartSearchField<T>[]): T[] {
  if (!normalizeForSearch(query)) return items;
  return items
    .map((item, index) => {
      const score = fields.reduce((best, field) => {
        const value = field.get ? field.get(item) : field.value;
        return Math.max(best, rankSearchResult(value, query) * (field.weight ?? 1));
      }, -1);
      return { item, index, score };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

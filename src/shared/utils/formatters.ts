/**
 * Centralized formatting and display hygiene for FIXION.
 * Suppresses internal technical identifiers and migration prefixes (e.g. MIGRATED-LEGACY-*)
 * from user-facing screens while strictly preserving leading zeros for card and student codes.
 */

export function formatDisplayIdentifier(id?: string | null): string {
  if (!id) return "";
  const trimmed = id.trim();

  // Strip technical migration prefixes
  if (trimmed.startsWith("MIGRATED-LEGACY-")) {
    const cleaned = trimmed.replace("MIGRATED-LEGACY-", "");
    return cleaned;
  }

  // Strip internal operation/UUID prefix if ever accidentally exposed
  if (trimmed.startsWith("op-") || trimmed.startsWith("sync-") || trimmed.startsWith("tok-")) {
    return "";
  }

  // Preserve exact card code with leading zeros intact (e.g. "00126")
  return trimmed;
}

export function formatCardCode(cardCode?: string | null): string {
  if (!cardCode) return "";
  return cardCode.trim();
}

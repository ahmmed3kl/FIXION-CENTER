export const normalizeScannedBarcode = (data: unknown): string =>
  String(data || "").trim();

import { normalizeScannedBarcode } from "../src/shared/components/barcodeScannerValue";

describe("scanned barcode values", () => {
  it("trims whitespace without stripping leading zeroes", () => {
    expect(normalizeScannedBarcode(" 00125\n")).toBe("00125");
  });

  it("ignores empty scanner results", () => {
    expect(normalizeScannedBarcode("  ")).toBe("");
  });
});

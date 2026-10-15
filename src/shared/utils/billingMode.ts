export type BillingMode = "pending" | "monthly" | "per_session" | "package";

const PER_SESSION_MODES = new Set([
  "per_session",
  "persession",
  "session",
  "per_class",
  "perclass",
]);

const PACKAGE_MODES = new Set(["package", "pkg"]);

function normalizeBillingValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]/g, "_");
}

export function normalizeBillingMode(
  billingMode: unknown,
  cycleType: unknown,
  hasPackageSubscription = false,
): BillingMode {
  const normalizedMode = normalizeBillingValue(billingMode);
  const normalizedCycleType = normalizeBillingValue(cycleType);

  if (
    hasPackageSubscription ||
    PACKAGE_MODES.has(normalizedMode) ||
    PACKAGE_MODES.has(normalizedCycleType)
  ) {
    return "package";
  }
  if (PER_SESSION_MODES.has(normalizedMode)) return "per_session";
  if (normalizedMode === "pending") return "pending";
  if (normalizedMode === "monthly") return "monthly";
  if (!normalizedMode && PER_SESSION_MODES.has(normalizedCycleType)) {
    return "per_session";
  }
  return "monthly";
}

export function isPerSessionBillingMode(
  billingMode: unknown,
  cycleType: unknown,
): boolean {
  return normalizeBillingMode(billingMode, cycleType) === "per_session";
}

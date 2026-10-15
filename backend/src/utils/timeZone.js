function normalizeIanaTimeZone(value) {
  if (typeof value !== "string") return null;
  const timeZone = value.trim();
  if (!timeZone || timeZone.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

module.exports = { normalizeIanaTimeZone };

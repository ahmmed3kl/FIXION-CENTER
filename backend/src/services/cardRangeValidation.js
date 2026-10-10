const { AppError } = require("../middleware/errorHandler");

async function validateCardCode(client, centerId, cardCode) {
  if (typeof cardCode !== "string" || !/^\d+$/.test(cardCode)) {
    throw new AppError(
      "INVALID_CARD_CODE",
      "Card code must contain digits only.",
      "كود الكارت غير صحيح.",
      400,
    );
  }

  const result = await client.query(
    `SELECT start_code, end_code
     FROM card_ranges
     WHERE center_id = $1 AND status = 'active'
     ORDER BY start_code ASC`,
    [centerId],
  );
  const ranges = result.rows;
  if (!ranges.length) {
    throw new AppError(
      "CARD_RANGE_NOT_CONFIGURED",
      "No active card range is configured for this center.",
      "لا يوجد نطاق بطاقات نشط لهذا المركز. تواصل مع مسؤول المركز قبل إضافة الطالب.",
      403,
    );
  }

  if (
    ranges.some(
      ({ start_code: start, end_code: end }) =>
        cardCode.length === start.length &&
        cardCode >= start &&
        cardCode <= end,
    )
  ) {
    return;
  }

  const bounds = ranges
    .map(({ start_code: start, end_code: end }) => `${start} إلى ${end}`)
    .join("، ");
  throw new AppError(
    "CARD_OUTSIDE_ALLOWED_RANGE",
    "Card is outside the authenticated center's allowed ranges.",
    `كود الكارت خارج النطاق المسموح لهذا المركز. النطاق المسموح: ${bounds}.`,
    403,
  );
}

module.exports = { validateCardCode };

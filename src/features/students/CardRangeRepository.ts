import { DatabaseService } from "../../core/database";
import { ValidationError } from "../../core/errors";

export interface CardRangeRecord {
  id: string;
  center_id?: string;
  centerId?: string;
  start_code?: string;
  startCode?: string;
  end_code?: string;
  endCode?: string;
  status?: string;
  created_at?: string;
  createdAt?: string;
  updated_at?: string | null;
  updatedAt?: string | null;
}

export class CardRangeRepository {
  static replaceCenterRanges(centerId: string, ranges: CardRangeRecord[]): void {
    const normalizedRanges = ranges.map((range) => {
      const startCode = String(range.start_code ?? range.startCode ?? "");
      const endCode = String(range.end_code ?? range.endCode ?? "");
      if (
        !range.id ||
        (range.center_id && range.center_id !== centerId) ||
        !/^\d+$/.test(startCode) ||
        !/^\d+$/.test(endCode) ||
        startCode.length !== endCode.length ||
        startCode > endCode
      ) {
        throw new ValidationError("بيانات نطاق البطاقات المحفوظة غير صحيحة.");
      }
      return { range, startCode, endCode };
    });

    const db = DatabaseService.getDb();
    db.runSync("DELETE FROM card_ranges WHERE center_id = ?", [centerId]);
    for (const { range, startCode, endCode } of normalizedRanges) {
      db.runSync(
        `INSERT INTO card_ranges (id, center_id, start_code, end_code, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          range.id,
          centerId,
          startCode,
          endCode,
          range.status === "inactive" ? "inactive" : "active",
          range.created_at || range.createdAt || new Date().toISOString(),
          range.updated_at || range.updatedAt || null,
        ],
      );
    }
  }

  static assertCodeAllowed(centerId: string, cardCode: string): void {
    if (!/^\d+$/.test(cardCode)) {
      throw new ValidationError("كود البطاقة يجب أن يتكوّن من أرقام فقط.");
    }

    const ranges = DatabaseService.getDb().getAllSync<{
      start_code: string;
      end_code: string;
    }>(
      `SELECT start_code, end_code FROM card_ranges
       WHERE center_id = ? AND status = 'active'
       ORDER BY start_code ASC`,
      [centerId],
    );

    if (ranges.length === 0) {
      throw new ValidationError(
        "لا تتوفر إعدادات نطاق بطاقات موثوقة لهذا المركز. اتصل بالإنترنت لمزامنتها قبل إضافة الطالب.",
      );
    }

    const allowed = ranges.some(
      ({ start_code: start, end_code: end }) =>
        cardCode.length === start.length &&
        cardCode >= start &&
        cardCode <= end,
    );
    if (allowed) return;

    const bounds = ranges
      .map(({ start_code: start, end_code: end }) => `${start} إلى ${end}`)
      .join("، ");
    throw new ValidationError(
      `كود البطاقة خارج النطاق المسموح لهذا المركز. النطاق المسموح: ${bounds}.`,
    );
  }
}

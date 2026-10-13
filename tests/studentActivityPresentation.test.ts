import { getStudentActivityPresentation } from "../src/features/students/studentActivityPresentation";
import { AuditLog } from "../src/shared/types";

const makeLog = (action: string, payload?: unknown, userId = "actor-1"): AuditLog => ({
  id: "audit-1",
  operationId: "operation-1",
  centerId: "center-1",
  userId,
  deviceId: "device-1",
  entityType: "student",
  entityId: "student-1",
  action,
  timestamp: "2026-10-12T12:34:56.000Z",
  payload: payload === undefined ? undefined : JSON.stringify(payload),
});

describe("student activity presentation", () => {
  it.each([
    ["student.color.update", "تعديل لون بطاقة الطالب"],
    ["absence.note.upsert", "إضافة أو تحديث ملاحظة غياب"],
    ["grade.score.save", "حفظ الدرجة"],
    ["attendance.record", "تسجيل الحضور"],
    ["payment.record", "تسجيل دفعة"],
  ])("translates %s into Arabic", (action, title) => {
    expect(getStudentActivityPresentation(makeLog(action)).title).toBe(title);
  });

  it("shows the saved actor name and a useful event description", () => {
    const presentation = getStudentActivityPresentation(
      makeLog("payment.record", { amount: 100, actorName: "أحمد محمد" }),
    );

    expect(presentation.actorName).toBe("أحمد محمد");
    expect(presentation.description).toBe("المبلغ: 100 جنيه");
  });

  it("uses the current user's name only when the activity user id matches", () => {
    const currentUser = { id: "actor-1", fullName: "اسم المستخدم" };

    expect(getStudentActivityPresentation(makeLog("student.update"), currentUser).actorName)
      .toBe("اسم المستخدم");
    expect(getStudentActivityPresentation(makeLog("student.update", undefined, "actor-2"), currentUser).actorName)
      .toBe("مستخدم غير معروف");
  });

  it("uses a generic Arabic title for unknown activity types", () => {
    const presentation = getStudentActivityPresentation(makeLog("untranslated.internal.event"));

    expect(presentation.title).toBe("نشاط على ملف الطالب");
    expect(presentation.title).not.toContain("untranslated.internal.event");
  });
});

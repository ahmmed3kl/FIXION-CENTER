jest.mock("expo-device", () => ({ modelName: "Test Device" }));

import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { useAuthStore } from "../src/features/auth/useAuthStore";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";
import { StudentRepository } from "../src/features/students/StudentRepository";

describe("card range enforcement", () => {
  let centerId: string;

  beforeEach(async () => {
    DatabaseService.init();
    useAuthStore.getState().logout();
    await useAuthStore.getState().login("admin@center1.com", "123456");
    centerId = useAuthStore.getState().activeCenterId!;
    CardRangeRepository.replaceCenterRanges(centerId, [{
      id: "range-test",
      center_id: centerId,
      start_code: "10051000",
      end_code: "10051500",
      status: "active",
    }]);
  });

  it("allows the inclusive start and end boundary without converting card codes to numbers", () => {
    expect(() => CardRangeRepository.assertCodeAllowed(centerId, "10051000")).not.toThrow();
    expect(() => CardRangeRepository.assertCodeAllowed(centerId, "10051500")).not.toThrow();
  });

  it("rejects an out-of-range card before storing a student or creating a sync operation", () => {
    const pendingBefore = SyncRepository.getPendingOperationsCount(centerId);

    expect(() => StudentRepository.createStudent({
      studentCode: "10051501",
      cardCode: "10051501",
      fullName: "طالب خارج النطاق",
      phone: "01012345678",
      parentPhone: "01112345678",
      grade: "الصف الأول الثانوي",
    })).toThrow("10051000 إلى 10051500");

    expect(StudentRepository.findByStudentCode("10051501")).toBeNull();
    expect(SyncRepository.getPendingOperationsCount(centerId)).toBe(pendingBefore);
  });

  it("allows a cached trusted range to be checked locally without a network request", () => {
    expect(() => CardRangeRepository.assertCodeAllowed(centerId, "10051000")).not.toThrow();
  });

  it("fails closed when the center has no trusted local range and leaves student and outbox untouched", () => {
    CardRangeRepository.replaceCenterRanges(centerId, []);
    const db = DatabaseService.getDb();
    const pendingBefore = SyncRepository.getPendingOperationsCount(centerId);

    expect(() => StudentRepository.createStudent({
      studentCode: "10051000",
      cardCode: "10051000",
      fullName: "طالب دون نطاق موثوق",
      phone: "01012345678",
      parentPhone: "01112345678",
      grade: "الصف الأول الثانوي",
    })).toThrow("لا تتوفر إعدادات نطاق بطاقات موثوقة");

    expect(StudentRepository.findByStudentCode("10051000")).toBeNull();
    expect(SyncRepository.getPendingOperationsCount(centerId)).toBe(pendingBefore);
    expect(db.getAllSync(
      "SELECT id FROM students WHERE center_id = ? AND student_code = ?",
      [centerId, "10051000"],
    )).toHaveLength(0);
  });
});

import { DatabaseService } from "../../core/database";
import { UnauthorizedError } from "../../core/errors";
import { Session } from "../../shared/types";
import { getLocalDateOnly } from "../../shared/utils/date";
import { useAuthStore } from "../auth/useAuthStore";

export class ScannerService {
  /**
   * Normalizes barcode / card input:
   * - Trims surrounding whitespace
   * - Converts Eastern Arabic / Indic digits (٠١٢٣٤٥٦٧٨٩) to standard Latin digits (0-9)
   * - Removes non-printable / control characters
   * - PRESERVES LEADING ZEROS strictly (e.g. "00125" stays "00125")
   */
  static normalizeCardCode(rawCode: string): string {
    if (!rawCode) return "";

    let code = rawCode.trim();

    // Map Eastern Arabic digits to Latin digits
    const arabicDigits: Record<string, string> = {
      "٠": "0",
      "١": "1",
      "٢": "2",
      "٣": "3",
      "٤": "4",
      "٥": "5",
      "٦": "6",
      "٧": "7",
      "٨": "8",
      "٩": "9",
    };

    code = code.replace(/[٠-٩]/g, (char) => arabicDigits[char] || char);

    // Remove unwanted control characters or hidden symbols, but preserve letters and digits
    code = code.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    return code;
  }

  /**
   * Returns today's eligible sessions for a student in the active authenticated center.
   * Matches if:
   * - The student is in session_expected_students for that session
   * - OR the student has an active student_group_enrollment valid on that date
   * - OR the student has an active student_subscription for the group (Sprint 1 compatibility)
   */
  static getEligibleSessionsForStudent(
    studentId: string,
    targetDate?: string,
  ): Session[] {
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) {
      throw new UnauthorizedError("لا يوجد مركز نشط محدد.");
    }

    const db = DatabaseService.getDb();
    const dateStr = targetDate || getLocalDateOnly();

    // 1. Base eligibility: session_expected_students snapshot OR active group enrollment / subscription
    const baseSessions = db.getAllSync<Session>(
      `SELECT s.id, s.center_id as centerId, s.group_id as groupId, s.schedule_id as scheduleId,
              s.subject_id as subjectId, s.teacher_id as teacherId, s.session_price as sessionPrice,
              s.late_after_minutes as lateAfterMinutes, s.session_date as sessionDate,
              s.start_time as startTime, s.end_time as endTime, s.status,
              g.name as groupName, subj.name as subjectName, t.name as teacherName
       FROM sessions s
       JOIN groups g ON s.center_id = g.center_id AND s.group_id = g.id
       LEFT JOIN subjects subj ON COALESCE(s.subject_id, g.subject_id) = subj.id
       LEFT JOIN teachers t ON COALESCE(s.teacher_id, g.teacher_id) = t.id
       LEFT JOIN session_expected_students ses ON s.center_id = ses.center_id AND s.id = ses.session_id AND ses.student_id = ?
       WHERE s.center_id = ? AND s.session_date = ? AND (s.status = 'open' OR s.status = 'scheduled')
          AND (
            ses.student_id IS NOT NULL
            OR (
              NOT EXISTS (SELECT 1 FROM session_expected_students WHERE center_id = s.center_id AND session_id = s.id)
              AND (
                g.id IN (
                  SELECT group_id FROM student_group_enrollments
                  WHERE student_id = ? AND center_id = ? AND status = 'active'
                    AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
                )
                OR g.id IN (
                  SELECT group_id FROM student_subscriptions
                  WHERE student_id = ? AND center_id = ? AND status = 'active'
                )
              )
            )
          )
        ORDER BY s.start_time ASC`,
      [
        studentId,
        centerId,
        dateStr,
        studentId,
        centerId,
        dateStr,
        dateStr,
        studentId,
        centerId,
      ],
    );

    const sessionMap = new Map<string, Session>();
    for (const s of baseSessions) {
      sessionMap.set(s.id, s);
    }

    // 2. Additional eligibility: Package subscriptions
    const activePkgSubs = db.getAllSync<any>(
      `SELECT id, package_id as packageId FROM student_package_subscriptions
       WHERE student_id = ? AND center_id = ? AND status = 'active'
         AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
      [studentId, centerId, dateStr, dateStr],
    );

    if (activePkgSubs.length > 0) {
      const todaySessions = db.getAllSync<Session>(
        `SELECT id, center_id as centerId, group_id as groupId, schedule_id as scheduleId,
                subject_id as subjectId, teacher_id as teacherId, session_price as sessionPrice,
                late_after_minutes as lateAfterMinutes, session_date as sessionDate,
                start_time as startTime, end_time as endTime, status
         FROM sessions WHERE center_id = ? AND session_date = ?`,
        [centerId, dateStr],
      );
      const pkgSubjects = db.getAllSync<any>(
        `SELECT package_id as packageId, subject_id as subjectId, default_teacher_id as defaultTeacherId,
                group_id as groupId
         FROM package_subjects WHERE center_id = ?`,
        [centerId],
      );
      const pkgOverrides = db.getAllSync<any>(
        `SELECT subscription_id as subscriptionId, subject_id as subjectId, teacher_id as teacherId
         FROM package_subject_teacher_overrides WHERE center_id = ?`,
        [centerId],
      );

      for (const s of todaySessions) {
        if (sessionMap.has(s.id)) continue;
        const isPkgCovered = activePkgSubs.some((ps: any) => {
          const subjects = pkgSubjects.filter(
            (psub: any) => psub.packageId === ps.packageId,
          );
          const selectedOverrides = pkgOverrides.filter(
            (override: any) => override.subscriptionId === ps.id,
          );
          // New subscriptions persist one override row per selected option.
          // This prevents an unselected subject in the package from making
          // every same-subject session look eligible. Legacy subscriptions
          // without overrides retain the old all-options behavior.
          const selectedSubjects = selectedOverrides.length
            ? subjects.filter((subject: any) =>
                selectedOverrides.some(
                  (override: any) => override.subjectId === subject.subjectId,
                ),
              )
            : subjects;
          return selectedSubjects.some((psub: any) => {
            if (psub.subjectId !== s.subjectId) return false;
            if (psub.groupId && psub.groupId !== s.groupId) return false;
            const override = selectedOverrides.find(
              (o: any) =>
                o.subscriptionId === ps.id && o.subjectId === s.subjectId,
            );
            const effectiveTeacherId = override
              ? override.teacherId
              : psub.defaultTeacherId;
            return effectiveTeacherId === s.teacherId;
          });
        });
        if (isPkgCovered) {
          sessionMap.set(s.id, s);
        }
      }
    }

    return Array.from(sessionMap.values());
  }

  /**
   * Calculates whether the check-in is late based on session start time and threshold (in minutes).
   */
  static calculateLateStatus(
    sessionStartTime: string,
    checkInTimeStr?: string,
    graceMinutes = 15,
  ): { isLate: boolean; status: "present" | "late" } {
    const now = new Date();
    const checkIn =
      checkInTimeStr ||
      `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    const [startH, startM] = sessionStartTime
      .split(":")
      .map((v) => parseInt(v, 10));
    const [checkH, checkM] = checkIn.split(":").map((v) => parseInt(v, 10));

    const startTotalMinutes = startH * 60 + startM;
    const checkTotalMinutes = checkH * 60 + checkM;

    const isLate = checkTotalMinutes > startTotalMinutes + graceMinutes;
    return {
      isLate,
      status: isLate ? "late" : "present",
    };
  }
}

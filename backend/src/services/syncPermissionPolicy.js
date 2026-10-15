const { AppError } = require("../middleware/errorHandler");

function getOperationType(operation) {
  return String(operation.operationType || operation.operation_type || "").toLowerCase();
}

function getPayload(operation) {
  const value = operation.payload;
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function getAction(operation) {
  return String(getPayload(operation).action || "").toLowerCase();
}

function hasPermission(permissions, permission) {
  return Array.isArray(permissions)
    ? permissions.includes(permission)
    : permissions?.[permission] === true;
}

function hasAnyPermission(permissions, candidates) {
  return candidates.some((permission) => hasPermission(permissions, permission));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function requiredPermission(operation) {
  const entity = String(operation.entityType || operation.entity_type || "").toLowerCase();
  const payload = getPayload(operation);
  const action = getAction(operation);
  const isResetRepair = getOperationType(operation) === "repair_after_server_reset";
  // Reset recovery rebuilds rows that are missing from the server snapshot.
  // Authorize the replay as the create action it performs, while preserving
  // explicit payload actions and entity-specific lifecycle permissions.
  const operationType = isResetRepair && !action ? "create" : getOperationType(operation);

  if (entity.includes("student_card")) return "students.cards.manage";
  if (entity === "teacher_subject" || entity === "teacher_subject_assigned") {
    return "subjects.teachers.manage";
  }
  if (entity === "student" || entity.startsWith("student_")) {
    if (payload.cardCodeChanged || payload.replaceCard) return "students.cards.manage";
    const student = payload.student || payload;
    if (hasOwn(student, "deletedAt") || hasOwn(student, "deleted_at")) {
      const deletedAt = student.deletedAt ?? student.deleted_at;
      return deletedAt == null ? "students.restore" : "students.deactivate";
    }
    if (operationType === "create" || action === "create") return "students.create";
    if (operationType === "delete" || action === "delete") return "students.deactivate";
    return "students.update";
  }
  if (entity === "teacher" || entity.startsWith("teacher_")) {
    return operationType === "create" || action === "create" ? "teachers.create" : "teachers.update";
  }
  if (entity === "subject" || entity.startsWith("subject_")) {
    return operationType === "create" || action === "create" ? "subjects.create" : "subjects.update";
  }
  if (entity === "group_schedule") return "groups.schedule.manage";
  if (entity === "group" || entity.startsWith("group_")) {
    if (
      isResetRepair &&
      (action === "delete" || action === "deactivate" || payload.status === "inactive")
    ) {
      return "groups.deactivate";
    }
    if (operationType === "create" || action === "create") return "groups.create";
    if (
      operationType === "delete" ||
      action === "delete" ||
      action === "deactivate" ||
      payload.status === "inactive"
    ) {
      return "groups.deactivate";
    }
    return "groups.update";
  }
  if (entity === "center_academic_stage" || entity === "center_academic_stages") {
    return "center.settings.manage";
  }
  if (entity === "enrollment" || entity === "student_group_enrollment") {
    if (isResetRepair && (action === "end" || payload.status === "ended")) return "enrollments.end";
    if (operationType === "create" || action === "create") return "enrollments.create";
    if (operationType === "delete" || action === "end" || payload.status === "ended") return "enrollments.end";
    return "enrollments.update";
  }
  if (entity === "session" || entity === "session_created") {
    if (action === "activate") return "attendance.create";
    if (action === "close") return "sessions.close";
    if (action === "reopen") return "sessions.reopen";
    if (operationType === "create" || action === "create") return "sessions.generate";
    return "sessions.update";
  }
  if (entity === "attendance" || entity === "attendance_marked" || entity === "advance_coverage") {
    if (action === "attendance.cancel") return "attendance.edit";
    return "attendance.create";
  }
  if (entity === "absence_note") return "attendance.edit";
  if (entity === "payment_reversal") return "payments.reverse";
  if (entity === "debt_adjustment") return "payments.adjust";
  if (entity === "payment" || entity === "payment_collected" || entity === "debt_cycle") {
    return "payments.create";
  }
  if (entity === "package_subscription") return "packages.subscribe";
  if (entity === "package" || entity === "package_subject" || entity === "package_teacher_override") {
    return "packages.manage";
  }
  if (entity === "grade_exam" || entity === "grade_score") return "grades.manage";
  if (entity === "homework_evaluation_status") return "homework.manage";
  if (entity === "session_homework_evaluation") return null;
  if (entity === "notification_template") return "notifications.templates.update";
  if (entity === "notification_event" || entity === "notification_delivery") return "notifications.send";
  if (entity === "daily_closing") {
    return action === "reopen" ? "daily_closing.reopen" : "daily_closing.close";
  }
  return null;
}

function assertSyncPermission(req, operation) {
  const entity = String(operation.entityType || operation.entity_type || "").toLowerCase();
  const payload = getPayload(operation);
  const teacher = entity === "teacher" || entity.startsWith("teacher_")
    ? payload.teacher || payload
    : {};
  const changesTeacherWeekStart = hasOwn(teacher, "weekStartDay") || hasOwn(teacher, "week_start_day");
  if (
    changesTeacherWeekStart &&
    req.user.role !== "admin"
  ) {
    throw new AppError(
      "FORBIDDEN",
      "Only center administrators can change a teacher week start day.",
      "إعداد بداية أسبوع المدرس متاح للأدمن فقط.",
      403,
    );
  }
  const permission = requiredPermission(operation);
  if (req.user.role === "admin" || req.user.role === "owner") return;

  const permissions = req.user.permissions || {};
  if (entity === "session_homework_evaluation") {
    const allowed = ["grades.manage", "attendance.create", "attendance.edit"];
    if (allowed.some((candidate) => hasPermission(permissions, candidate))) return;
    throw new AppError(
      "FORBIDDEN",
      "Missing required homework evaluation permission.",
      "ليس لديك الصلاحية الكافية لمزامنة تقييم الواجب.",
      403,
    );
  }

  if (!permission) {
    throw new AppError(
      "FORBIDDEN",
      `No sync permission policy for entity: ${entity || "unknown"}.`,
      "لا توجد صلاحية مزامنة معرّفة لهذا النوع من البيانات.",
      403,
    );
  }
  if (!hasPermission(permissions, permission)) {
    throw new AppError(
      "FORBIDDEN",
      `Missing required permission: ${permission}`,
      "ليس لديك الصلاحية الكافية لمزامنة هذه العملية.",
      403,
    );
  }

  if (entity === "attendance" || entity === "attendance_marked") {
    const payload = getPayload(operation);
    if (String(payload.action || "").toLowerCase() === "attendance.cancel") return;
    const attendanceType = String(
      payload.attendanceType || payload.attendance_type || "present",
    ).toLowerCase();
    const requiredAttendancePermissions = [];
    if (attendanceType === "makeup") {
      requiredAttendancePermissions.push("attendance.makeup");
    }
    if (payload.isExternal === true || payload.is_external === true) {
      requiredAttendancePermissions.push("attendance.external");
    }
    for (const required of requiredAttendancePermissions) {
      if (!hasPermission(permissions, required)) {
        throw new AppError(
          "FORBIDDEN",
          `Missing required permission: ${required}`,
          "ليس لديك الصلاحية الكافية لمزامنة هذا النوع من الحضور.",
          403,
        );
      }
    }
  }
}

function canReadSyncEntity(entityType, user) {
  if (user.role === "admin" || user.role === "owner") return true;
  const entity = String(entityType || "").toLowerCase();
  const permissions = user.permissions || {};
  const candidates = entity.includes("student_card") || entity === "student" || entity.startsWith("student_")
    ? ["students.view"]
    : entity === "teacher" || entity.startsWith("teacher_")
      ? ["teachers.view"]
      : entity === "subject" || entity.startsWith("subject_")
        ? ["subjects.view"]
        : entity === "teacher_subject" || entity === "teacher_subject_assigned"
          ? ["teachers.view", "subjects.view"]
          : entity === "group_schedule" || entity === "group" || entity.startsWith("group_")
            ? ["groups.view"]
            : entity === "enrollment" || entity === "student_group_enrollment"
              ? ["enrollments.view", "groups.students.view", "students.view"]
              : entity === "session" || entity === "session_created" || entity === "session_closing"
                ? ["sessions.view", "attendance.view"]
                : entity === "attendance" || entity === "attendance_marked"
                  ? ["attendance.view"]
                  : entity === "absence_note"
                    ? ["attendance.view", "reports.attendance.view", "reports.view"]
                  : ["payment", "payment_collected", "payment_reversal", "debt_adjustment", "debt_cycle", "advance_coverage"].includes(entity)
                    ? ["payments.view", "payments.debt.view", "reports.financial.view"]
                    : entity === "package" || entity.startsWith("package_")
                      ? ["packages.view"]
                      : entity === "grade_exam" || entity === "grade_score"
                        ? ["grades.view"]
                        : entity === "homework_evaluation_status"
                          ? ["homework.manage"]
                          : entity === "session_homework_evaluation"
                            ? ["homework.manage", "grades.manage", "attendance.view", "attendance.create", "attendance.edit"]
                          : entity === "notification_template"
                            ? ["notifications.view", "notifications.templates.view", "notifications.templates.manage", "notifications.templates.update"]
                            : entity === "notification_event" || entity === "notification_delivery"
                              ? ["notifications.view"]
                            : entity === "daily_closing"
                              ? ["daily_closing.view"]
                              : entity === "center_academic_stage" || entity === "center_academic_stages"
                                ? ["center.settings.view", "center.settings.manage", "groups.view"]
                                : entity === "card_range"
                                  ? ["students.create", "center.settings.view"]
                                  : [];
  return hasAnyPermission(permissions, candidates);
}

function filterBootstrapSnapshot(snapshot, user) {
  const tablePermissions = {
    students: "student",
    cards: "student_card",
    groups: "group",
    teachers: "teacher",
    subjects: "subject",
    teacherSubjects: "teacher_subject",
    schedules: "group_schedule",
    sessions: "session",
    expectedStudents: "session",
    enrollments: "student_group_enrollment",
    attendance: "attendance",
    absenceNotes: "absence_note",
    payments: "payment",
    paymentReversals: "payment_reversal",
    debtAdjustments: "debt_adjustment",
    packages: "package",
    packageSubjects: "package_subject",
    packageSubscriptions: "package_subscription",
    packageTeacherOverrides: "package_teacher_override",
    advanceCoverages: "advance_coverage",
    notificationTemplates: "notification_template",
    debtCycles: "debt_cycle",
    notificationEvents: "notification_event",
    notificationDeliveries: "notification_delivery",
    sessionClosings: "session_closing",
    dailyClosings: "daily_closing",
    gradeExams: "grade_exam",
    gradeScores: "grade_score",
    homeworkEvaluationStatuses: "homework_evaluation_status",
    sessionHomeworkEvaluations: "session_homework_evaluation",
    cardRanges: "card_range",
  };
  const filtered = { ...snapshot };
  for (const [key, entity] of Object.entries(tablePermissions)) {
    if (!canReadSyncEntity(entity, user)) filtered[key] = [];
  }
  if (!canReadSyncEntity("session", user)) filtered.sessionNaturalKeys = [];
  const canReadSessionReferences =
    canReadSyncEntity("session", user) ||
    canReadSyncEntity("attendance", user) ||
    canReadSyncEntity("payment", user) ||
    canReadSyncEntity("advance_coverage", user);
  if (!canReadSessionReferences) filtered.sessionAliases = [];
  if (!canReadSyncEntity("center_academic_stage", user)) filtered.academicStages = null;
  return filtered;
}

module.exports = {
  assertSyncPermission,
  canReadSyncEntity,
  filterBootstrapSnapshot,
  requiredPermission,
};

const { AppError } = require("../middleware/errorHandler");

function getOperationType(operation) {
  return String(operation.operationType || operation.operation_type || "").toLowerCase();
}

function getAction(operation) {
  return String(operation.payload?.action || "").toLowerCase();
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
  const operationType = getOperationType(operation);
  const payload = operation.payload || {};
  const action = getAction(operation);

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
    if (operationType === "create" || action === "create") return "enrollments.create";
    if (operationType === "delete" || action === "end" || payload.status === "ended") return "enrollments.end";
    return "enrollments.update";
  }
  if (entity === "session" || entity === "session_created") {
    if (action === "close") return "sessions.close";
    if (action === "reopen") return "sessions.reopen";
    if (operationType === "create" || action === "create") return "sessions.generate";
    return "sessions.update";
  }
  if (entity === "attendance" || entity === "attendance_marked" || entity === "advance_coverage") {
    return "attendance.create";
  }
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
  if (String(operation.operationType || operation.operation_type || "").toUpperCase() === "REPAIR_AFTER_SERVER_RESET") {
    return;
  }

  const entity = String(operation.entityType || operation.entity_type || "").toLowerCase();
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
  if (hasPermission(permissions, permission)) return;
  throw new AppError(
    "FORBIDDEN",
    `Missing required permission: ${permission}`,
    "ليس لديك الصلاحية الكافية لمزامنة هذه العملية.",
    403,
  );
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
  if (!canReadSyncEntity("center_academic_stage", user)) filtered.academicStages = null;
  return filtered;
}

module.exports = {
  assertSyncPermission,
  canReadSyncEntity,
  filterBootstrapSnapshot,
  requiredPermission,
};

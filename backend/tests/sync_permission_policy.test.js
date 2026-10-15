const assert = require("node:assert/strict");
const {
  assertSyncPermission,
  canReadSyncEntity,
  filterBootstrapSnapshot,
  requiredPermission,
} = require("../src/services/syncPermissionPolicy");

function request(permissions) {
  return { user: { role: "assistant", permissions } };
}

function rejectsWithPermission(req, operation, expectedPermission) {
  assert.throws(
    () => assertSyncPermission(req, operation),
    (error) =>
      error.code === "FORBIDDEN" &&
      error.message.includes(expectedPermission),
  );
}

function run() {
  assert.equal(requiredPermission({ entityType: "student", operationType: "CREATE" }), "students.create");
  assert.equal(requiredPermission({
    entityType: "student",
    operationType: "UPDATE",
    payload: { student: { deletedAt: "2026-10-01" } },
  }), "students.deactivate");
  assert.equal(requiredPermission({
    entityType: "student",
    operationType: "UPDATE",
    payload: { student: { deletedAt: null, deleted_at: null } },
  }), "students.restore");
  assert.equal(requiredPermission({
    entityType: "group",
    operationType: "UPDATE",
    payload: { status: "inactive" },
  }), "groups.deactivate");
  assert.equal(requiredPermission({
    entityType: "center_academic_stage",
    operationType: "UPDATE",
  }), "center.settings.manage");
  assert.equal(requiredPermission({ entityType: "teacher_subject", operationType: "CREATE" }), "subjects.teachers.manage");
  assert.equal(requiredPermission({ entityType: "absence_note", operationType: "UPDATE" }), "attendance.edit");
  assertSyncPermission(request(["attendance.edit"]), {
    entityType: "absence_note",
    operationType: "UPDATE",
    payload: { sessionId: "session-1", studentId: "student-1", text: "ظرف عائلي" },
  });
  rejectsWithPermission(request(["attendance.create"]), {
    entityType: "absence_note",
    operationType: "UPDATE",
    payload: { sessionId: "session-1", studentId: "student-1", text: "ظرف عائلي" },
  }, "attendance.edit");

  assertSyncPermission(request(["students.create"]), {
    entityType: "student",
    operationType: "CREATE",
  });
  assertSyncPermission(request(["attendance.create", "attendance.makeup"]), {
    entityType: "attendance",
    operationType: "CREATE",
    payload: { attendanceType: "makeup" },
  });
  const sessionActivation = {
    entityType: "session",
    operationType: "UPDATE",
    payload: { action: "activate", status: "open" },
  };
  assert.equal(requiredPermission(sessionActivation), "attendance.create");
  assertSyncPermission(request(["attendance.create"]), sessionActivation);
  rejectsWithPermission(request(["sessions.update"]), sessionActivation, "attendance.create");
  assert.equal(requiredPermission({
    entityType: "attendance",
    operationType: "UPDATE",
    payload: { action: "attendance.cancel" },
  }), "attendance.edit");
  assertSyncPermission(request(["attendance.edit"]), {
    entityType: "attendance",
    operationType: "UPDATE",
    payload: { action: "attendance.cancel", attendanceType: "makeup" },
  });
  rejectsWithPermission(request(["attendance.create"]), {
    entityType: "attendance",
    operationType: "UPDATE",
    payload: { action: "attendance.cancel" },
  }, "attendance.edit");
  assertSyncPermission(request(["attendance.create", "attendance.external"]), {
    entityType: "attendance",
    operationType: "CREATE",
    payload: { isExternal: true },
  });
  rejectsWithPermission(request(["attendance.create"]), {
    entityType: "attendance",
    operationType: "CREATE",
    payload: { attendanceType: "makeup" },
  }, "attendance.makeup");
  rejectsWithPermission(request(["attendance.create"]), {
    entityType: "attendance",
    operationType: "CREATE",
    payload: { isExternal: true },
  }, "attendance.external");
  rejectsWithPermission(request(["students.update"]), {
    entityType: "student",
    operationType: "UPDATE",
    payload: { student: { deletedAt: "2026-10-01" } },
  }, "students.deactivate");
  rejectsWithPermission(request(["groups.update"]), {
    entityType: "group",
    operationType: "UPDATE",
    payload: { status: "inactive" },
  }, "groups.deactivate");
  rejectsWithPermission(request(["groups.create"]), {
    entityType: "center_academic_stage",
    operationType: "UPDATE",
  }, "center.settings.manage");
  rejectsWithPermission(request([]), {
    entityType: "student",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    payload: { id: "student-1" },
  }, "students.create");
  rejectsWithPermission(request(["students.update"]), {
    entityType: "student",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    payload: { id: "student-1" },
  }, "students.create");
  assertSyncPermission(request(["students.create"]), {
    entityType: "student",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    payload: { id: "student-1" },
  });
  assert.equal(requiredPermission({
    entityType: "group",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    payload: { status: "inactive" },
  }), "groups.deactivate");
  assert.equal(requiredPermission({
    entityType: "student",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    payload: { deletedAt: null },
  }), "students.restore");
  rejectsWithPermission(request(["attendance.create"]), {
    entityType: "attendance",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    payload: { attendanceType: "makeup" },
  }, "attendance.makeup");
  rejectsWithPermission(request(["attendance.create"]), {
    entityType: "attendance",
    operationType: "REPAIR_AFTER_SERVER_RESET",
    payload: JSON.stringify({ attendanceType: "makeup" }),
  }, "attendance.makeup");
  rejectsWithPermission(request([]), {
    entityType: "unrecognized_entity",
    operationType: "UPDATE",
  }, "No sync permission policy");
  assert.throws(
    () => assertSyncPermission(request(["teachers.update"]), {
      entityType: "teacher",
      operationType: "UPDATE",
      payload: { id: "teacher-1", weekStartDay: 3 },
    }),
    (error) => error.code === "FORBIDDEN" && error.statusCode === 403,
  );
  assert.throws(
    () => assertSyncPermission(request(["teachers.update"]), {
      entityType: "teacher",
      operationType: "UPDATE",
      payload: { id: "teacher-1", week_start_day: 3 },
    }),
    (error) => error.code === "FORBIDDEN" && error.statusCode === 403,
  );
  assertSyncPermission({ user: { role: "admin", permissions: [] } }, {
    entityType: "teacher",
    operationType: "UPDATE",
    payload: { id: "teacher-1", weekStartDay: 3 },
  });
  assert.throws(
    () => assertSyncPermission({ user: { role: "owner", permissions: [] } }, {
      entityType: "teacher",
      operationType: "UPDATE",
      payload: { id: "teacher-1", weekStartDay: 3 },
    }),
    (error) => error.code === "FORBIDDEN" && error.statusCode === 403,
  );
  assert.equal(
    canReadSyncEntity("student", {
      role: "manager",
      permissions: ["students.create", "students.update"],
    }),
    false,
  );
  assert.equal(
    canReadSyncEntity("student", {
      role: "manager",
      permissions: ["students.view"],
    }),
    true,
  );
  assert.equal(canReadSyncEntity("payment", { role: "assistant", permissions: ["students.view"] }), false);
  assert.equal(canReadSyncEntity("group", { role: "assistant", permissions: ["groups.view"] }), true);
  assert.equal(canReadSyncEntity("student_group_enrollment", { role: "assistant", permissions: ["groups.view"] }), false);
  assert.equal(canReadSyncEntity("absence_note", { role: "assistant", permissions: ["reports.view"] }), true);
  assert.equal(canReadSyncEntity("absence_note", { role: "assistant", permissions: ["students.view"] }), false);
  const snapshot = filterBootstrapSnapshot({
    students: [{ id: "student-1" }],
    payments: [{ id: "payment-1" }],
    absenceNotes: [{ id: "note-1" }],
    academicStages: [{ id: "primary" }],
  }, { role: "assistant", permissions: ["students.view"] });
  assert.equal(snapshot.students.length, 1);
  assert.equal(snapshot.payments.length, 0);
  assert.equal(snapshot.absenceNotes.length, 0);
  assert.equal(snapshot.academicStages, null);

  console.log("sync_permission_policy: all assertions passed");
}

run();

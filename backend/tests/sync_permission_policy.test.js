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

  assertSyncPermission(request(["students.create"]), {
    entityType: "student",
    operationType: "CREATE",
  });
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
    entityType: "unrecognized_entity",
    operationType: "UPDATE",
  }, "No sync permission policy");
  assert.equal(canReadSyncEntity("payment", { role: "assistant", permissions: ["students.view"] }), false);
  assert.equal(canReadSyncEntity("group", { role: "assistant", permissions: ["groups.view"] }), true);
  assert.equal(canReadSyncEntity("student_group_enrollment", { role: "assistant", permissions: ["groups.view"] }), false);
  const snapshot = filterBootstrapSnapshot({
    students: [{ id: "student-1" }],
    payments: [{ id: "payment-1" }],
    academicStages: [{ id: "primary" }],
  }, { role: "assistant", permissions: ["students.view"] });
  assert.equal(snapshot.students.length, 1);
  assert.equal(snapshot.payments.length, 0);
  assert.equal(snapshot.academicStages, null);

  console.log("sync_permission_policy: all assertions passed");
}

run();

import { DatabaseService } from "../src/core/database";
import { SyncRepository } from "../src/core/sync";
import { ForbiddenError, ValidationError } from "../src/core/errors";

describe("Phase 1: Conflict Management Tests", () => {
  const centerId = "center-conflict-test";
  const otherCenterId = "center-other-test";
  const managerUser = { id: "user-mgr-1", permissions: ["sync.manage", "sync.view"] };
  const restrictedUser = { id: "user-sec-1", permissions: ["students.view", "attendance.view"] };

  beforeEach(() => {
    DatabaseService.init();
    const db = DatabaseService.getDb();
    // Clean test tables
    db.runSync("DELETE FROM sync_operations WHERE center_id IN (?, ?)", [centerId, otherCenterId]);
    db.runSync("DELETE FROM sync_conflicts WHERE center_id IN (?, ?)", [centerId, otherCenterId]);
    db.runSync("DELETE FROM audit_logs WHERE center_id IN (?, ?)", [centerId, otherCenterId]);
    db.runSync("DELETE FROM groups WHERE center_id IN (?, ?)", [centerId, otherCenterId]);
    db.runSync("DELETE FROM teachers WHERE center_id IN (?, ?)", [centerId, otherCenterId]);
    db.runSync("DELETE FROM group_schedules WHERE center_id IN (?, ?)", [centerId, otherCenterId]);
    db.runSync("DELETE FROM students WHERE center_id IN (?, ?)", [centerId, otherCenterId]);
  });

  function setupConflict(params: {
    operationId: string;
    centerId: string;
    entityType: string;
    entityId: string;
    reason: string;
    resolvedAt?: string | null;
    resolvedBy?: string | null;
    resolutionNote?: string | null;
    payload?: any;
    rawError?: string;
  }) {
    const db = DatabaseService.getDb();
    const now = new Date().toISOString();
    const payloadStr = params.payload ? JSON.stringify(params.payload) : "{}";

    db.runSync(
      `INSERT INTO sync_operations (
         id, operation_id, center_id, user_id, device_id,
         operation_type, entity_type, entity_id, payload,
         status, created_at, last_error
       ) VALUES (?, ?, ?, 'user-1', 'dev-1', 'UPDATE', ?, ?, ?, 'conflict', ?, ?)`,
      [
        `op-row-${params.operationId}`,
        params.operationId,
        params.centerId,
        params.entityType,
        params.entityId,
        payloadStr,
        now,
        params.rawError || params.reason,
      ],
    );

    db.runSync(
      `INSERT INTO sync_conflicts (
         id, operation_id, center_id, entity_type, entity_id,
         reason, local_payload, server_payload, created_at,
         resolved_at, resolved_by, resolution_note
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        `conf-${params.operationId}`,
        params.operationId,
        params.centerId,
        params.entityType,
        params.entityId,
        params.reason,
        payloadStr,
        now,
        params.resolvedAt || null,
        params.resolvedBy || null,
        params.resolutionNote || null,
      ],
    );
  }

  function assertConflictUnmodified(operationId: string, originalError?: string) {
    const db = DatabaseService.getDb();
    const conf = db.getFirstSync<any>(
      "SELECT resolved_at, resolved_by, resolution_note FROM sync_conflicts WHERE operation_id = ?",
      [operationId],
    );
    expect(conf?.resolved_at).toBeNull();
    expect(conf?.resolved_by).toBeNull();
    expect(conf?.resolution_note).toBeNull();

    const op = db.getFirstSync<any>(
      "SELECT status, last_error FROM sync_operations WHERE operation_id = ?",
      [operationId],
    );
    expect(op?.status).toBe("conflict");
    if (originalError) {
      expect(op?.last_error).toBe(originalError);
    }
    expect(op?.last_error).not.toContain("[إغلاق يدوي]");

    const auditCount = db.getFirstSync<any>(
      "SELECT COUNT(*) as count FROM audit_logs WHERE operation_id = ?",
      [operationId],
    );
    expect(auditCount?.count || 0).toBe(0);
  }

  // -------------------------------------------------------------
  // Test 1: Open conflicts display
  // -------------------------------------------------------------
  test("1. عرض التعارضات النشطة المفتوحة واستبعاد المحسومة مع تفاصيل الكيان والسبب العربي", () => {
    const db = DatabaseService.getDb();

    // Setup group and teacher for entity enrichment
    db.runSync(
      `INSERT INTO teachers (id, center_id, name, phone, status, created_at)
       VALUES ('t-physics', ?, 'أحمد فيزياء', '0100000001', 'active', ?)`,
      [centerId, new Date().toISOString()],
    );
    db.runSync(
      `INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, status, created_at)
       VALUES ('grp-phy-1', ?, 'فيزياء ثانوي', 't-physics', 's-1', 'الثانوي', 'active', ?)`,
      [centerId, new Date().toISOString()],
    );

    // Conflict 1: Open schedule conflict
    setupConflict({
      operationId: "op-sched-open",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-1",
      reason: "TEACHER_SCHEDULE_CONFLICT: teacher already booked at this time",
      payload: { groupId: "grp-phy-1" },
    });

    // Conflict 2: Already resolved schedule conflict
    setupConflict({
      operationId: "op-sched-closed",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-2",
      reason: "TEACHER_SCHEDULE_CONFLICT",
      resolvedAt: new Date().toISOString(),
      resolvedBy: "admin-1",
      resolutionNote: "تم التحقق والإغلاق مسبقًا",
    });

    const openConflicts = SyncRepository.getOpenConflicts(centerId);
    expect(openConflicts).toHaveLength(1);

    const open = openConflicts[0];
    expect(open.operationId).toBe("op-sched-open");
    expect(open.entityType).toBe("group_schedule");
    expect(open.resolvedAt).toBeNull();
    expect(open.groupName).toBe("فيزياء ثانوي");
    expect(open.teacherName).toBe("أحمد فيزياء");
    expect(open.isFinancial).toBe(false);
    expect(open.friendlyReason).toContain("تعارض جدول المدرس");
  });

  // -------------------------------------------------------------
  // Test 2: Manual closure of non-financial conflict
  // -------------------------------------------------------------
  test("2. إغلاق التعارض غير المالي يدويًا بنجاح وتوثيق سبب الإغلاق والمستخدم والتاريخ", () => {
    setupConflict({
      operationId: "op-close-me",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-manual",
      reason: "TEACHER_SCHEDULE_CONFLICT",
    });

    const reason = "تم التنسيق مع المدرس فيصل وتعديل موعد الحصة يدويًا";
    SyncRepository.dismissConflict({
      centerId,
      operationId: "op-close-me",
      reason,
      user: managerUser,
      deviceId: "dev-test-1",
    });

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      "SELECT resolved_at, resolved_by, resolution_note FROM sync_conflicts WHERE operation_id = ?",
      ["op-close-me"],
    );

    expect(row).toBeDefined();
    expect(row?.resolved_at).toBeTruthy();
    expect(row?.resolved_by).toBe(managerUser.id);
    expect(row?.resolution_note).toBe(reason);

    // It should no longer appear in open conflicts
    const openAfter = SyncRepository.getOpenConflicts(centerId);
    expect(openAfter.find((c) => c.operationId === "op-close-me")).toBeUndefined();
  });

  // -------------------------------------------------------------
  // Test 3: Historical log
  // -------------------------------------------------------------
  test("3. ظهور التعارض المغلق في سجل التعارضات المحسومة التاريخي بتفاصيله الكاملة", () => {
    setupConflict({
      operationId: "op-hist-1",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-h1",
      reason: "TEACHER_SCHEDULE_CONFLICT",
    });

    SyncRepository.dismissConflict({
      centerId,
      operationId: "op-hist-1",
      reason: "تم حسم التعارض بعد إعادة ترتيب القاعات والمواعيد",
      user: managerUser,
    });

    const history = SyncRepository.getHistoricalConflicts(centerId);
    expect(history.length).toBeGreaterThanOrEqual(1);

    const closed = history.find((c) => c.operationId === "op-hist-1");
    expect(closed).toBeDefined();
    expect(closed?.resolvedBy).toBe(managerUser.id);
    expect(closed?.resolutionNote).toBe("تم حسم التعارض بعد إعادة ترتيب القاعات والمواعيد");
    expect(closed?.resolvedAt).toBeTruthy();
  });

  // -------------------------------------------------------------
  // Test 4: Stats count
  // -------------------------------------------------------------
  test("4. استبعاد التعارض المحسوم من عداد مشاكل المزامنة في getStats", () => {
    setupConflict({
      operationId: "op-stat-test",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-stat",
      reason: "TEACHER_SCHEDULE_CONFLICT",
    });

    // Before closure: conflict count should be 1
    const beforeStats = SyncRepository.getStats(centerId);
    expect(beforeStats.conflict).toBe(1);

    // Dismiss the conflict
    SyncRepository.dismissConflict({
      centerId,
      operationId: "op-stat-test",
      reason: "إغلاق للتحقق من انخفاض عداد التعارضات في الإحصائيات",
      user: managerUser,
    });

    // After closure: conflict count should drop to 0
    const afterStats = SyncRepository.getStats(centerId);
    expect(afterStats.conflict).toBe(0);
  });

  // -------------------------------------------------------------
  // Test 5: Financial protection
  // -------------------------------------------------------------
  test("5. الحماية المالية الصارمة: منع إغلاق أي تعارض مالي يدويًا ورمي استثناء", () => {
    const financialTypes = [
      "payment",
      "payment_reversal",
      "debt_cycle",
      "debt_adjustment",
      "daily_closing",
      "advance_coverage",
      "payment_collected",
    ];

    for (const finType of financialTypes) {
      const opId = `op-fin-${finType}`;
      setupConflict({
        operationId: opId,
        centerId,
        entityType: finType,
        entityId: `ent-${finType}`,
        reason: "DUPLICATE_PAYMENT_DETECTED",
      });

      expect(() => {
        SyncRepository.dismissConflict({
          centerId,
          operationId: opId,
          reason: "محاولة غير مصرح بها لإغلاق تعارض مالي يدويًا",
          user: managerUser,
        });
      }).toThrow(ValidationError);

      assertConflictUnmodified(opId, "DUPLICATE_PAYMENT_DETECTED");
    }
  });

  // -------------------------------------------------------------
  // Test 6: Multi-tenant isolation
  // -------------------------------------------------------------
  test("6. عزل المراكز: منع إغلاق تعارض تابع لمركز آخر ورمي ValidationError", () => {
    setupConflict({
      operationId: "op-center-a",
      centerId: centerId,
      entityType: "group_schedule",
      entityId: "sched-isolated",
      reason: "TEACHER_SCHEDULE_CONFLICT",
    });

    // Attempt to dismiss using otherCenterId
    expect(() => {
      SyncRepository.dismissConflict({
        centerId: otherCenterId,
        operationId: "op-center-a",
        reason: "محاولة إغلاق من مركز مختلف تمامًا",
        user: managerUser,
      });
    }).toThrow(ValidationError);

    // Verify centerId's conflict was untouched
    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      "SELECT resolved_at FROM sync_conflicts WHERE operation_id = ?",
      ["op-center-a"],
    );
    expect(row?.resolved_at).toBeNull();
  });

  // -------------------------------------------------------------
  // Test 7: Idempotency
  // -------------------------------------------------------------
  test("7. الحتمية والتكرار الآمن (Idempotency): تكرار الاستدعاء لا يغير البيانات ولا يرمي خطأ", () => {
    setupConflict({
      operationId: "op-idempotent",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-idemp",
      reason: "TEACHER_SCHEDULE_CONFLICT",
    });

    const firstReason = "الإغلاق الأول المعتمد";
    SyncRepository.dismissConflict({
      centerId,
      operationId: "op-idempotent",
      reason: firstReason,
      user: managerUser,
    });

    const db = DatabaseService.getDb();
    const firstRow = db.getFirstSync<any>(
      "SELECT resolved_at, resolution_note FROM sync_conflicts WHERE operation_id = ?",
      ["op-idempotent"],
    );
    const originalResolvedAt = firstRow?.resolved_at;

    // Second call with different reason should be a no-op
    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-idempotent",
        reason: "محاولة ثانية بسبب آخر لا يجب أن تؤثر",
        user: managerUser,
      });
    }).not.toThrow();

    const secondRow = db.getFirstSync<any>(
      "SELECT resolved_at, resolution_note FROM sync_conflicts WHERE operation_id = ?",
      ["op-idempotent"],
    );
    expect(secondRow?.resolved_at).toBe(originalResolvedAt);
    expect(secondRow?.resolution_note).toBe(firstReason);
  });

  // -------------------------------------------------------------
  // Test 8: Permission check
  // -------------------------------------------------------------
  test("8. التحقق من الصلاحيات: رفض إغلاق التعارض لمستخدم لا يمتلك صلاحية sync.manage", () => {
    setupConflict({
      operationId: "op-perm-test",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-perm",
      reason: "TEACHER_SCHEDULE_CONFLICT",
    });

    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-perm-test",
        reason: "محاولة إغلاق بدون الصلاحية المناسبة",
        user: restrictedUser,
      });
    }).toThrow(ForbiddenError);

    const db = DatabaseService.getDb();
    const row = db.getFirstSync<any>(
      "SELECT resolved_at FROM sync_conflicts WHERE operation_id = ?",
      ["op-perm-test"],
    );
    expect(row?.resolved_at).toBeNull();
  });

  // -------------------------------------------------------------
  // Test 9: Atomicity & Preserving status='conflict' in sync_operations
  // -------------------------------------------------------------
  test("9. الحفاظ على status='conflict' والخطأ الأصلي وإنشاء سجل Audit وتفاصيل الإغلاق", () => {
    const rawError = "TEACHER_SCHEDULE_CONFLICT: Slot already occupied";
    setupConflict({
      operationId: "op-atomic-test",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-atomic",
      reason: "TEACHER_SCHEDULE_CONFLICT",
      rawError,
    });

    const note = "تم حسم الخلاف بتأكيد الموعد البديل";
    SyncRepository.dismissConflict({
      centerId,
      operationId: "op-atomic-test",
      reason: note,
      user: managerUser,
      deviceId: "dev-audit-1",
    });

    const db = DatabaseService.getDb();

    // 1. Check sync_operations: status MUST NOT be 'synced', it must remain 'conflict'
    const op = db.getFirstSync<any>(
      "SELECT status, last_error, next_retry_at FROM sync_operations WHERE operation_id = ?",
      ["op-atomic-test"],
    );
    expect(op?.status).toBe("conflict");
    expect(op?.next_retry_at).toBeNull();
    expect(op?.last_error).toContain(rawError);
    expect(op?.last_error).toContain("[إغلاق يدوي]: " + note);

    // 2. Check sync_conflicts: resolution fields set, original reason preserved
    const conf = db.getFirstSync<any>(
      "SELECT reason, resolved_at, resolved_by, resolution_note FROM sync_conflicts WHERE operation_id = ?",
      ["op-atomic-test"],
    );
    expect(conf?.reason).toBe("TEACHER_SCHEDULE_CONFLICT");
    expect(conf?.resolved_at).toBeTruthy();
    expect(conf?.resolved_by).toBe(managerUser.id);
    expect(conf?.resolution_note).toBe(note);

    // 3. Check audit_logs: record created
    const audit = db.getFirstSync<any>(
      "SELECT action, user_id, entity_type, entity_id FROM audit_logs WHERE operation_id = ?",
      ["op-atomic-test"],
    );
    expect(audit).toBeDefined();
    expect(audit?.action).toBe("CONFLICT_DISMISSED");
    expect(audit?.user_id).toBe(managerUser.id);
    expect(audit?.entity_type).toBe("group_schedule");
    expect(audit?.entity_id).toBe("sched-atomic");
  });

  // -------------------------------------------------------------
  // Test 10: Reject entity_type = "PAYMENT"
  // -------------------------------------------------------------
  test("10. رفض إغلاق التعارض عندما يكون entity_type = 'PAYMENT' بالحروف الكبيرة دون تعديل أو Audit", () => {
    setupConflict({
      operationId: "op-rej-payment-upper",
      centerId,
      entityType: "PAYMENT",
      entityId: "pay-upper-1",
      reason: "PAYMENT_DUPLICATE",
      rawError: "PAYMENT_DUPLICATE: already exists",
    });

    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-rej-payment-upper",
        reason: "محاولة إغلاق تعارض مالي بحروف كبيرة",
        user: managerUser,
      });
    }).toThrow(ValidationError);

    assertConflictUnmodified("op-rej-payment-upper", "PAYMENT_DUPLICATE: already exists");
  });

  // -------------------------------------------------------------
  // Test 11: Reject entity_type = " Debt_Cycle "
  // -------------------------------------------------------------
  test("11. رفض إغلاق التعارض عندما يكون entity_type = ' Debt_Cycle ' مع مسافات وحالة أحرف مختلفة دون تعديل أو Audit", () => {
    setupConflict({
      operationId: "op-rej-debt-ws",
      centerId,
      entityType: " Debt_Cycle ",
      entityId: "dc-ws-1",
      reason: "DEBT_CYCLE_CONFLICT",
      rawError: "DEBT_CYCLE_CONFLICT: cycle mismatch",
    });

    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-rej-debt-ws",
        reason: "محاولة إغلاق دورة مديونية مع مسافات",
        user: managerUser,
      });
    }).toThrow(ValidationError);

    assertConflictUnmodified("op-rej-debt-ws", "DEBT_CYCLE_CONFLICT: cycle mismatch");
  });

  // -------------------------------------------------------------
  // Test 12: Reject payment_collected
  // -------------------------------------------------------------
  test("12. رفض إغلاق التعارض المالي payment_collected دون أي تعديل أو Audit", () => {
    setupConflict({
      operationId: "op-rej-pay-collected",
      centerId,
      entityType: "payment_collected",
      entityId: "pay-col-1",
      reason: "PAYMENT_COLLECTED_INVALID",
      rawError: "PAYMENT_COLLECTED_INVALID: amount mismatch",
    });

    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-rej-pay-collected",
        reason: "محاولة إغلاق تحصيل دفعة يدوياً",
        user: managerUser,
      });
    }).toThrow(ValidationError);

    assertConflictUnmodified("op-rej-pay-collected", "PAYMENT_COLLECTED_INVALID: amount mismatch");
  });

  // -------------------------------------------------------------
  // Test 13: Reject daily_closing
  // -------------------------------------------------------------
  test("13. رفض إغلاق التعارض المالي daily_closing دون أي تعديل أو Audit", () => {
    setupConflict({
      operationId: "op-rej-daily-closing",
      centerId,
      entityType: "daily_closing",
      entityId: "close-1",
      reason: "DAILY_CLOSING_LOCKED",
      rawError: "DAILY_CLOSING_LOCKED: already closed for today",
    });

    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-rej-daily-closing",
        reason: "محاولة إغلاق إغلاق يومي يدوياً",
        user: managerUser,
      });
    }).toThrow(ValidationError);

    assertConflictUnmodified("op-rej-daily-closing", "DAILY_CLOSING_LOCKED: already closed for today");
  });

  // -------------------------------------------------------------
  // Test 14: Reject advance_coverage
  // -------------------------------------------------------------
  test("14. رفض إغلاق التعارض المالي advance_coverage دون أي تعديل أو Audit", () => {
    setupConflict({
      operationId: "op-rej-advance-cov",
      centerId,
      entityType: "advance_coverage",
      entityId: "adv-1",
      reason: "ADVANCE_COVERAGE_INVALID",
      rawError: "ADVANCE_COVERAGE_INVALID: advance exceeded",
    });

    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-rej-advance-cov",
        reason: "محاولة إغلاق تغطية سلفة يدوياً",
        user: managerUser,
      });
    }).toThrow(ValidationError);

    assertConflictUnmodified("op-rej-advance-cov", "ADVANCE_COVERAGE_INVALID: advance exceeded");
  });

  // -------------------------------------------------------------
  // Test 15: Reject user with id = ""
  // -------------------------------------------------------------
  test("15. رفض إغلاق التعارض عندما يكون user.id فارغاً دون أي تعديل على قاعدة البيانات أو Audit", () => {
    setupConflict({
      operationId: "op-rej-empty-user",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-emp-u",
      reason: "TEACHER_SCHEDULE_CONFLICT",
      rawError: "TEACHER_SCHEDULE_CONFLICT: teacher busy",
    });

    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-rej-empty-user",
        reason: "سبب وجيه وصحيح لكن المستخدم فارغ",
        user: { id: "   ", permissions: ["sync.manage"] },
      });
    }).toThrow(ValidationError);

    assertConflictUnmodified("op-rej-empty-user", "TEACHER_SCHEDULE_CONFLICT: teacher busy");
  });

  // -------------------------------------------------------------
  // Test 16: Reject user with id = "unknown"
  // -------------------------------------------------------------
  test("16. رفض إغلاق التعارض عندما يكون user.id يساوي 'unknown' بحالات أحرف مختلفة دون تعديل أو Audit", () => {
    setupConflict({
      operationId: "op-rej-unknown-user",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-unk-u",
      reason: "TEACHER_SCHEDULE_CONFLICT",
      rawError: "TEACHER_SCHEDULE_CONFLICT: conflict exists",
    });

    for (const testUserId of ["unknown", "UNKNOWN", "  Unknown  "]) {
      expect(() => {
        SyncRepository.dismissConflict({
          centerId,
          operationId: "op-rej-unknown-user",
          reason: "سبب صحيح ومفصل لا يقل عن خمسة أحرف",
          user: { id: testUserId, permissions: ["sync.manage"] },
        });
      }).toThrow(ValidationError);
    }

    assertConflictUnmodified("op-rej-unknown-user", "TEACHER_SCHEDULE_CONFLICT: conflict exists");
  });

  // -------------------------------------------------------------
  // Test 17: Reject closure reason < 5 characters or whitespace only
  // -------------------------------------------------------------
  test("17. رفض سبب إغلاق أقل من 5 أحرف أو مسافات فقط دون أي تعديل أو Audit", () => {
    setupConflict({
      operationId: "op-rej-short-reason",
      centerId,
      entityType: "group_schedule",
      entityId: "sched-short-r",
      reason: "TEACHER_SCHEDULE_CONFLICT",
      rawError: "TEACHER_SCHEDULE_CONFLICT: time overlap",
    });

    for (const invalidReason of ["", "   ", "abc", " 123 "]) {
      expect(() => {
        SyncRepository.dismissConflict({
          centerId,
          operationId: "op-rej-short-reason",
          reason: invalidReason,
          user: managerUser,
        });
      }).toThrow(ValidationError);
    }

    assertConflictUnmodified("op-rej-short-reason", "TEACHER_SCHEDULE_CONFLICT: time overlap");
  });

  // -------------------------------------------------------------
  // Test 18: Reject non-existent operationId
  // -------------------------------------------------------------
  test("18. رفض إغلاق عملية غير موجودة operationId دون تعديل أو Audit", () => {
    expect(() => {
      SyncRepository.dismissConflict({
        centerId,
        operationId: "op-non-existent-999",
        reason: "سبب إغلاق لعملية غير مسجلة في النظام",
        user: managerUser,
      });
    }).toThrow(ValidationError);

    const db = DatabaseService.getDb();
    const auditCount = db.getFirstSync<any>(
      "SELECT COUNT(*) as count FROM audit_logs WHERE operation_id = ?",
      ["op-non-existent-999"],
    );
    expect(auditCount?.count || 0).toBe(0);
  });
});


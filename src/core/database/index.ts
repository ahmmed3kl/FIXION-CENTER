import * as SQLite from "expo-sqlite";

export interface SqlDatabase {
  execSync(sql: string): void;
  runSync(sql: string, ...params: any[]): any;
  getAllSync<T = any>(sql: string, ...params: any[]): T[];
  getFirstSync<T = any>(sql: string, ...params: any[]): T | null;
}

export interface Migration {
  version: number;
  name: string;
  up: (db: SqlDatabase) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_sprint1_foundation",
    up: (db: SqlDatabase) => {
      db.execSync(`
        CREATE TABLE IF NOT EXISTS centers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          code TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS teachers (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          name TEXT NOT NULL,
          phone TEXT
        );

        CREATE TABLE IF NOT EXISTS subjects (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          name TEXT NOT NULL,
          code TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS groups (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          name TEXT NOT NULL,
          teacher_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          grade TEXT NOT NULL,
          default_fee REAL NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS group_schedules (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          day_of_week INTEGER NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS students (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          full_name TEXT NOT NULL,
          card_code TEXT NOT NULL,
          phone TEXT NOT NULL,
          parent_phone TEXT NOT NULL,
          grade TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          CONSTRAINT uq_student_card UNIQUE (center_id, card_code)
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          session_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
        );

        CREATE TABLE IF NOT EXISTS session_expected_students (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          CONSTRAINT uq_expected UNIQUE (session_id, student_id)
        );

        CREATE TABLE IF NOT EXISTS attendance (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          check_in_time TEXT NOT NULL,
          status TEXT NOT NULL,
          is_late INTEGER NOT NULL DEFAULT 0,
          attendance_type TEXT NOT NULL DEFAULT 'present',
          original_absence_id TEXT,
          operation_id TEXT NOT NULL,
          CONSTRAINT uq_attendance UNIQUE (session_id, student_id)
        );

        CREATE TABLE IF NOT EXISTS student_subscriptions (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          package_name TEXT NOT NULL,
          amount_due REAL NOT NULL,
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );

        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          subscription_id TEXT,
          amount REAL NOT NULL,
          payment_type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          user_id TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_operations (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          synced_at TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          center_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          payload TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_students_card ON students(center_id, card_code);
        CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(center_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(center_id, session_date);
        CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_operations(center_id, status);
      `);
    },
  },
  {
    version: 2,
    name: "academic_core_sprint2",
    up: (db: SqlDatabase) => {
      // 1. Canonical Student Cards Table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS student_cards (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          card_code TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          issued_at TEXT NOT NULL,
          deactivated_at TEXT,
          created_at TEXT NOT NULL,
          CONSTRAINT uq_center_card UNIQUE (center_id, card_code)
        );
      `);

      // 2. Extend students table
      const studentCols = [
        "ALTER TABLE students ADD COLUMN student_code TEXT;",
        "ALTER TABLE students ADD COLUMN student_type TEXT NOT NULL DEFAULT 'registered';",
        "ALTER TABLE students ADD COLUMN notes TEXT;",
        "ALTER TABLE students ADD COLUMN updated_at TEXT;",
      ];
      for (const colSql of studentCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }

      // Backfill clearly marked temporary migration student_code for legacy students
      try {
        db.execSync(`
          UPDATE students 
          SET student_code = 'MIGRATED-LEGACY-' || id 
          WHERE student_code IS NULL;
        `);
      } catch {}

      // Backfill student_cards from existing students
      try {
        db.execSync(`
          INSERT OR IGNORE INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
          SELECT 'card-' || id, center_id, id, card_code, 'active', created_at, created_at
          FROM students
          WHERE card_code IS NOT NULL;
        `);
      } catch {}

      // 3. Extend teachers table
      const teacherCols = [
        "ALTER TABLE teachers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
        "ALTER TABLE teachers ADD COLUMN notes TEXT;",
        "ALTER TABLE teachers ADD COLUMN created_at TEXT;",
        "ALTER TABLE teachers ADD COLUMN updated_at TEXT;",
      ];
      for (const colSql of teacherCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }
      try {
        db.execSync(
          "UPDATE teachers SET created_at = '2026-09-01' WHERE created_at IS NULL;",
        );
      } catch {}

      // 4. Extend subjects table
      const subjectCols = [
        "ALTER TABLE subjects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
        "ALTER TABLE subjects ADD COLUMN created_at TEXT;",
        "ALTER TABLE subjects ADD COLUMN updated_at TEXT;",
      ];
      for (const colSql of subjectCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }
      try {
        db.execSync(
          "UPDATE subjects SET created_at = '2026-09-01' WHERE created_at IS NULL;",
        );
      } catch {}

      // 5. New Table: teacher_subjects
      db.execSync(`
        CREATE TABLE IF NOT EXISTS teacher_subjects (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          teacher_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CONSTRAINT uq_teacher_subject UNIQUE (center_id, teacher_id, subject_id)
        );
      `);
      try {
        db.execSync(`
          INSERT OR IGNORE INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at)
          SELECT 'ts-' || id, center_id, teacher_id, subject_id, '2026-09-01'
          FROM groups;
        `);
      } catch {}

      // 6. Extend groups table
      const groupCols = [
        "ALTER TABLE groups ADD COLUMN session_price REAL NOT NULL DEFAULT 0;",
        "ALTER TABLE groups ADD COLUMN monthly_price REAL NOT NULL DEFAULT 0;",
        "ALTER TABLE groups ADD COLUMN session_duration_minutes INTEGER NOT NULL DEFAULT 120;",
        "ALTER TABLE groups ADD COLUMN late_after_minutes INTEGER NOT NULL DEFAULT 15;",
        "ALTER TABLE groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
        "ALTER TABLE groups ADD COLUMN created_at TEXT;",
        "ALTER TABLE groups ADD COLUMN updated_at TEXT;",
      ];
      for (const colSql of groupCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }
      try {
        db.execSync(`
          UPDATE groups 
          SET session_price = default_fee, monthly_price = default_fee, created_at = '2026-09-01'
          WHERE session_price = 0;
        `);
      } catch {}

      // 7. Extend group_schedules table
      const schedCols = [
        "ALTER TABLE group_schedules ADD COLUMN center_id TEXT;",
        "ALTER TABLE group_schedules ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
        "ALTER TABLE group_schedules ADD COLUMN created_at TEXT;",
        "ALTER TABLE group_schedules ADD COLUMN updated_at TEXT;",
      ];
      for (const colSql of schedCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }
      try {
        db.execSync(`
          UPDATE group_schedules 
          SET center_id = (SELECT center_id FROM groups WHERE groups.id = group_schedules.group_id), created_at = '2026-09-01'
          WHERE center_id IS NULL;
        `);
      } catch {}

      // 8. New Table: student_group_enrollments
      db.execSync(`
        CREATE TABLE IF NOT EXISTS student_group_enrollments (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          start_date TEXT NOT NULL,
          end_date TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          special_monthly_price REAL,
          created_at TEXT NOT NULL,
          updated_at TEXT
        );
      `);
      try {
        db.execSync(`
          INSERT OR IGNORE INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, status, created_at)
          SELECT 'enr-' || ses.id, ses.center_id, ses.student_id, s.group_id, '2026-09-01', 'active', '2026-09-01'
          FROM session_expected_students ses
          JOIN sessions s ON ses.session_id = s.id;
        `);
      } catch {}

      // 9. Extend sessions table (Historical configuration snapshot)
      const sessCols = [
        "ALTER TABLE sessions ADD COLUMN schedule_id TEXT;",
        "ALTER TABLE sessions ADD COLUMN subject_id TEXT;",
        "ALTER TABLE sessions ADD COLUMN teacher_id TEXT;",
        "ALTER TABLE sessions ADD COLUMN session_price REAL NOT NULL DEFAULT 0;",
        "ALTER TABLE sessions ADD COLUMN late_after_minutes INTEGER NOT NULL DEFAULT 15;",
        "ALTER TABLE sessions ADD COLUMN created_at TEXT;",
        "ALTER TABLE sessions ADD COLUMN updated_at TEXT;",
      ];
      for (const colSql of sessCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }
      try {
        db.execSync(`
          UPDATE sessions 
          SET subject_id = (SELECT subject_id FROM groups WHERE groups.id = sessions.group_id),
              teacher_id = (SELECT teacher_id FROM groups WHERE groups.id = sessions.group_id),
              session_price = (SELECT default_fee FROM groups WHERE groups.id = sessions.group_id),
              late_after_minutes = 15,
              created_at = '2026-09-01'
          WHERE subject_id IS NULL;
        `);
      } catch {}

      // 10. Extend session_expected_students
      try {
        db.execSync(
          "ALTER TABLE session_expected_students ADD COLUMN created_at TEXT;",
        );
      } catch {}
      try {
        db.execSync(
          "UPDATE session_expected_students SET created_at = '2026-09-01' WHERE created_at IS NULL;",
        );
      } catch {}

      // 11. Indexes
      db.execSync(`
        CREATE INDEX IF NOT EXISTS idx_students_code ON students(center_id, student_code);
        CREATE INDEX IF NOT EXISTS idx_students_name ON students(center_id, full_name);
        CREATE INDEX IF NOT EXISTS idx_student_cards_code ON student_cards(center_id, card_code);
        CREATE INDEX IF NOT EXISTS idx_student_cards_student ON student_cards(student_id, status);
        CREATE INDEX IF NOT EXISTS idx_teacher_subjects ON teacher_subjects(center_id, teacher_id, subject_id);
        CREATE INDEX IF NOT EXISTS idx_groups_subject ON groups(center_id, subject_id);
        CREATE INDEX IF NOT EXISTS idx_groups_teacher ON groups(center_id, teacher_id);
        CREATE INDEX IF NOT EXISTS idx_group_schedules ON group_schedules(center_id, group_id, day_of_week);
        CREATE INDEX IF NOT EXISTS idx_enrollments_student ON student_group_enrollments(center_id, student_id, status);
        CREATE INDEX IF NOT EXISTS idx_enrollments_group ON student_group_enrollments(center_id, group_id, status);
        CREATE INDEX IF NOT EXISTS idx_sessions_group_date ON sessions(center_id, group_id, session_date);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_group_sched_date ON sessions(group_id, schedule_id, session_date);
      `);
    },
  },
  {
    version: 3,
    name: "financial_core_sprint3",
    up: (db: SqlDatabase) => {
      // 1. Debt Cycles table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS debt_cycles (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          enrollment_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          cycle_number INTEGER NOT NULL DEFAULT 1,
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          cycle_price REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL,
          updated_at TEXT,
          CONSTRAINT uq_debt_cycles_enrollment_cycle UNIQUE (center_id, enrollment_id, cycle_number)
        );
      `);

      // 2. Extend payments table
      const paymentCols = [
        "ALTER TABLE payments ADD COLUMN payment_date TEXT;",
        "ALTER TABLE payments ADD COLUMN debt_cycle_id TEXT;",
        "ALTER TABLE payments ADD COLUMN session_id TEXT;",
        "ALTER TABLE payments ADD COLUMN notes TEXT;",
        "ALTER TABLE payments ADD COLUMN is_reversed INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE payments ADD COLUMN updated_at TEXT;",
      ];
      for (const colSql of paymentCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }
      try {
        db.execSync(`
          UPDATE payments 
          SET payment_date = SUBSTR(created_at, 1, 10), is_reversed = 0
          WHERE payment_date IS NULL;
        `);
      } catch {}

      // 3. Payment Reversals table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS payment_reversals (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          payment_id TEXT NOT NULL UNIQUE,
          student_id TEXT NOT NULL,
          reversed_amount REAL NOT NULL,
          reason TEXT NOT NULL,
          reversed_by TEXT NOT NULL,
          reversed_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 4. Debt Adjustments table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS debt_adjustments (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          enrollment_id TEXT,
          debt_cycle_id TEXT NOT NULL,
          amount_before REAL NOT NULL,
          adjustment_amount REAL NOT NULL,
          amount_after REAL NOT NULL,
          reason TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 5. Indexes
      db.execSync(`
        CREATE INDEX IF NOT EXISTS idx_debt_cycles_student ON debt_cycles(center_id, student_id, status);
        CREATE INDEX IF NOT EXISTS idx_debt_cycles_enrollment ON debt_cycles(center_id, enrollment_id);
        CREATE INDEX IF NOT EXISTS idx_payments_cycle ON payments(center_id, debt_cycle_id);
        CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(center_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_reversals_payment ON payment_reversals(center_id, payment_id);
        CREATE INDEX IF NOT EXISTS idx_adjustments_cycle ON debt_adjustments(center_id, debt_cycle_id);
      `);
    },
  },
  {
    version: 4,
    name: "packages_and_makeups_sprint4",
    up: (db: SqlDatabase) => {
      // 1. Packages table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS packages (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          name TEXT NOT NULL,
          price REAL NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT
        );
      `);

      // 2. Package Subjects table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS package_subjects (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          package_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          default_teacher_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CONSTRAINT uq_pkg_subject UNIQUE (center_id, package_id, subject_id)
        );
      `);

      // 3. Student Package Subscriptions table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS student_package_subscriptions (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          package_id TEXT NOT NULL,
          start_date TEXT NOT NULL,
          end_date TEXT,
          cancellation_date TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT
        );
      `);

      // 4. Package Subject Teacher Overrides table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS package_subject_teacher_overrides (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          teacher_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CONSTRAINT uq_pkg_override UNIQUE (center_id, subscription_id, subject_id)
        );
      `);

      // 5. Advance Coverages table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS advance_coverages (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          advance_session_id TEXT NOT NULL,
          target_future_session_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CONSTRAINT uq_advance_coverage UNIQUE (center_id, student_id, target_future_session_id)
        );
      `);

      // 6. Extend debt_cycles table
      const debtCycleCols = [
        "ALTER TABLE debt_cycles ADD COLUMN package_subscription_id TEXT;",
        "ALTER TABLE debt_cycles ADD COLUMN package_id TEXT;",
        "ALTER TABLE debt_cycles ADD COLUMN cycle_type TEXT NOT NULL DEFAULT 'group';",
      ];
      for (const colSql of debtCycleCols) {
        try {
          db.execSync(colSql);
        } catch {}
      }

      // 7. Extend attendance table
      try {
        db.execSync(
          "ALTER TABLE attendance ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0;",
        );
      } catch {}

      // 8. Extend payments table with payment_method
      try {
        db.execSync(
          "ALTER TABLE payments ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash';",
        );
      } catch {}
      try {
        db.execSync(
          "UPDATE payments SET payment_type = 'session', payment_method = 'cash' WHERE payment_type = 'cash';",
        );
      } catch {}

      // 9. Indexes
      db.execSync(`
        CREATE INDEX IF NOT EXISTS idx_packages_center ON packages(center_id, status);
        CREATE INDEX IF NOT EXISTS idx_pkg_subj_pkg ON package_subjects(center_id, package_id);
        CREATE INDEX IF NOT EXISTS idx_pkg_subs_student ON student_package_subscriptions(center_id, student_id, status);
        CREATE INDEX IF NOT EXISTS idx_pkg_subs_pkg ON student_package_subscriptions(center_id, package_id, status);
        CREATE INDEX IF NOT EXISTS idx_pkg_overrides_sub ON package_subject_teacher_overrides(center_id, subscription_id);
        CREATE INDEX IF NOT EXISTS idx_adv_cov_target ON advance_coverages(center_id, student_id, target_future_session_id);
        CREATE INDEX IF NOT EXISTS idx_adv_cov_advance ON advance_coverages(center_id, student_id, advance_session_id);
        CREATE INDEX IF NOT EXISTS idx_debt_cycles_pkg_sub ON debt_cycles(center_id, package_subscription_id);
      `);
    },
  },
  {
    version: 5,
    name: "operational_layer_sprint5",
    up: (db: SqlDatabase) => {
      // 1. Notification Templates
      db.execSync(`
        CREATE TABLE IF NOT EXISTS notification_templates (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          channel TEXT NOT NULL,
          template_body TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL,
          updated_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT,
          CONSTRAINT uq_notif_template UNIQUE (center_id, event_type, channel, is_default)
        );
      `);

      // 2. Notification Events
      db.execSync(`
        CREATE TABLE IF NOT EXISTS notification_events (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          attendance_id TEXT,
          event_type TEXT NOT NULL,
          template_id TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_events_attendance ON notification_events(center_id, attendance_id, event_type) WHERE attendance_id IS NOT NULL;
      `);

      // 3. Notification Deliveries
      db.execSync(`
        CREATE TABLE IF NOT EXISTS notification_deliveries (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          notification_event_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          recipient TEXT NOT NULL,
          rendered_message TEXT NOT NULL,
          sent_at TEXT,
          failure_reason TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT,
          CONSTRAINT uq_notif_delivery UNIQUE (notification_event_id, channel)
        );
      `);

      // 4. Session Closing Records (audit trail for close/reopen)
      db.execSync(`
        CREATE TABLE IF NOT EXISTS session_closing_records (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          action TEXT NOT NULL,
          reason TEXT,
          performed_by TEXT NOT NULL,
          performed_at TEXT NOT NULL,
          previous_status TEXT NOT NULL,
          new_status TEXT NOT NULL,
          total_attendance INTEGER NOT NULL DEFAULT 0,
          total_session_payments REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);

      // 5. Daily Closing Summaries
      db.execSync(`
        CREATE TABLE IF NOT EXISTS daily_closing_summaries (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          business_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'closed',
          closed_by TEXT,
          closed_at TEXT,
          reopened_by TEXT,
          reopened_at TEXT,
          reopen_reason TEXT,
          total_cash REAL NOT NULL DEFAULT 0,
          monthly_total REAL NOT NULL DEFAULT 0,
          partial_total REAL NOT NULL DEFAULT 0,
          session_total REAL NOT NULL DEFAULT 0,
          external_makeup_total REAL NOT NULL DEFAULT 0,
          package_total REAL NOT NULL DEFAULT 0,
          payment_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT,
          CONSTRAINT uq_daily_closing UNIQUE (center_id, business_date)
        );
      `);

      // 6. Indexes
      db.execSync(`
        CREATE INDEX IF NOT EXISTS idx_notif_events_student ON notification_events(center_id, student_id);
        CREATE INDEX IF NOT EXISTS idx_notif_events_session ON notification_events(center_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_notif_deliveries_event ON notification_deliveries(center_id, notification_event_id);
        CREATE INDEX IF NOT EXISTS idx_notif_deliveries_status ON notification_deliveries(center_id, status);
        CREATE INDEX IF NOT EXISTS idx_session_closing_session ON session_closing_records(center_id, session_id);
        CREATE INDEX IF NOT EXISTS idx_daily_closing_date ON daily_closing_summaries(center_id, business_date);
      `);
    },
  },
  {
    version: 6,
    name: "production_readiness_sprint6",
    up: (db: SqlDatabase) => {
      // 1. Devices table
      db.execSync(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          device_name TEXT NOT NULL,
          device_identifier TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          CONSTRAINT uq_device_identifier UNIQUE (center_id, device_identifier)
        );
        CREATE INDEX IF NOT EXISTS idx_devices_center ON devices(center_id, status);
      `);

      // 2. Sync Cursors table for monotonic sequence tokens
      db.execSync(`
        CREATE TABLE IF NOT EXISTS sync_cursors (
          center_id TEXT PRIMARY KEY,
          server_cursor TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 7,
    name: "sync_retry_and_conflict_review",
    up: (db: SqlDatabase) => {
      // Retry scheduling survives process restarts and keeps a failed
      // operation from being retried on every render/background tick.
      try {
        db.execSync("ALTER TABLE sync_operations ADD COLUMN next_retry_at TEXT;");
      } catch {}
      db.execSync(`
        CREATE TABLE IF NOT EXISTS sync_conflicts (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          center_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          local_payload TEXT,
          server_payload TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_conflicts_center
          ON sync_conflicts(center_id, resolved_at, created_at);
      `);
    },
  },
  {
    version: 8,
    name: "package_selection_limits",
    up: (db: SqlDatabase) => {
      try {
        db.execSync("ALTER TABLE packages ADD COLUMN max_selections INTEGER NOT NULL DEFAULT 1;");
      } catch {}
      db.execSync("CREATE INDEX IF NOT EXISTS idx_packages_selection_limit ON packages(center_id, max_selections);");
    },
  },
  {
    version: 9,
    name: "grade_book",
    up: (db: SqlDatabase) => {
      db.execSync(`
        CREATE TABLE IF NOT EXISTS grade_exams (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          name TEXT NOT NULL,
          grade TEXT NOT NULL,
          max_score REAL NOT NULL DEFAULT 100,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS grade_scores (
          id TEXT PRIMARY KEY,
          center_id TEXT NOT NULL,
          exam_id TEXT NOT NULL,
          student_id TEXT NOT NULL,
          score REAL,
          created_at TEXT NOT NULL,
          updated_at TEXT,
          CONSTRAINT uq_grade_score UNIQUE (center_id, exam_id, student_id)
        );
        CREATE INDEX IF NOT EXISTS idx_grade_exams_grade ON grade_exams(center_id, grade, status);
        CREATE INDEX IF NOT EXISTS idx_grade_scores_exam ON grade_scores(center_id, exam_id);
        CREATE INDEX IF NOT EXISTS idx_grade_scores_student ON grade_scores(center_id, student_id);
      `);
    },
  },
  {
    version: 10,
    name: "central_reset_generation",
    up: (db: SqlDatabase) => {
      try {
        db.execSync("ALTER TABLE sync_cursors ADD COLUMN reset_generation INTEGER NOT NULL DEFAULT 0;");
      } catch {}
    },
  },
  {
    version: 11,
    name: "package_subject_teacher_options",
    up: (db: SqlDatabase) => {
      // A package may contain the same subject more than once when each row
      // uses a different teacher. Rebuild the old table whose uniqueness was
      // incorrectly limited to (center, package, subject).
      try {
        db.execSync(`
          CREATE TABLE package_subjects_v11 (
            id TEXT PRIMARY KEY,
            center_id TEXT NOT NULL,
            package_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            default_teacher_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            CONSTRAINT uq_pkg_subject_teacher UNIQUE (center_id, package_id, subject_id, default_teacher_id)
          );
          INSERT INTO package_subjects_v11 (id, center_id, package_id, subject_id, default_teacher_id, created_at)
            SELECT id, center_id, package_id, subject_id, default_teacher_id, created_at
            FROM package_subjects;
          DROP TABLE package_subjects;
          ALTER TABLE package_subjects_v11 RENAME TO package_subjects;
          CREATE INDEX IF NOT EXISTS idx_pkg_subj_pkg ON package_subjects(center_id, package_id);
        `);
      } catch {}
    },
  },
  {
    version: 12,
    name: "package_subject_groups",
    up: (db: SqlDatabase) => {
      try {
        db.execSync(`
          ALTER TABLE package_subjects ADD COLUMN group_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_pkg_subj_group ON package_subjects(center_id, group_id);
        `);
      } catch {
        // Column may already exist on upgraded or in-memory test databases.
      }
    },
  },
  {
    version: 13,
    name: "sms_provider_message_id",
    up: (db: SqlDatabase) => {
      try {
        db.execSync("ALTER TABLE notification_deliveries ADD COLUMN provider_message_id TEXT;");
      } catch {}
    },
  },
];

// In-Memory SQLite Mock for Jest / Test environments
class InMemorySqliteMock implements SqlDatabase {
  private tables = new Map<string, any[]>();
  private userVersion = 0;
  private transactionSnapshot: Map<string, any[]> | null = null;

  constructor() {
    this.tables.set("schema_migrations", []);
    this.tables.set("centers", []);
    this.tables.set("teachers", []);
    this.tables.set("subjects", []);
    this.tables.set("teacher_subjects", []);
    this.tables.set("groups", []);
    this.tables.set("group_schedules", []);
    this.tables.set("students", []);
    this.tables.set("student_cards", []);
    this.tables.set("student_group_enrollments", []);
    this.tables.set("sessions", []);
    this.tables.set("session_expected_students", []);
    this.tables.set("attendance", []);
    this.tables.set("student_subscriptions", []);
    this.tables.set("debt_cycles", []);
    this.tables.set("payment_reversals", []);
    this.tables.set("debt_adjustments", []);
    this.tables.set("payments", []);
    this.tables.set("sync_operations", []);
    this.tables.set("sync_conflicts", []);
    this.tables.set("audit_logs", []);
    this.tables.set("packages", []);
    this.tables.set("package_subjects", []);
    this.tables.set("student_package_subscriptions", []);
    this.tables.set("package_subject_teacher_overrides", []);
    this.tables.set("advance_coverages", []);
    // Sprint 5 tables
    this.tables.set("notification_templates", []);
    this.tables.set("notification_events", []);
    this.tables.set("notification_deliveries", []);
    this.tables.set("session_closing_records", []);
    this.tables.set("daily_closing_summaries", []);
    // Sprint 6 tables
    this.tables.set("devices", []);
    this.tables.set("sync_cursors", []);
    this.tables.set("grade_exams", []);
    this.tables.set("grade_scores", []);
  }

  execSync(sql: string): void {
    const trimmed = sql.trim();
    const command = trimmed.replace(/;\s*$/, "").toUpperCase();
    if (command === "BEGIN IMMEDIATE" || command === "BEGIN") {
      if (!this.transactionSnapshot) {
        this.transactionSnapshot = new Map(
          Array.from(this.tables.entries()).map(([name, rows]) => [
            name,
            rows.map((row) => ({ ...row })),
          ]),
        );
      }
      return;
    }
    if (command === "COMMIT") {
      this.transactionSnapshot = null;
      return;
    }
    if (command === "ROLLBACK") {
      if (this.transactionSnapshot) {
        this.tables = this.transactionSnapshot;
        this.transactionSnapshot = null;
      }
      return;
    }
    if (trimmed.includes("PRAGMA user_version =")) {
      const match = trimmed.match(/PRAGMA\s+user_version\s*=\s*(\d+)/i);
      if (match) {
        this.userVersion = parseInt(match[1], 10);
      }
    }
  }

  runSync(
    sql: string,
    params: any[] = [],
  ): { lastInsertRowId: number; changes: number } {
    const trimmed = sql.trim();
    if (trimmed.toUpperCase().startsWith("INSERT INTO")) {
      const match = trimmed.match(
        /INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
      );
      if (match) {
        const tableName = match[1].toLowerCase();
        const columns = match[2].split(",").map((c) => c.trim());
        const valuesTokens = match[3].split(",").map((v) => v.trim());
        const row: any = {};
        let paramIdx = 0;
        columns.forEach((col, idx) => {
          const token = valuesTokens[idx];
          if (token && token.startsWith("'") && token.endsWith("'")) {
            row[col] = token.slice(1, -1);
          } else if (token && token.toUpperCase() === "NULL") {
            row[col] = null;
          } else if (token && !isNaN(Number(token)) && token !== "") {
            row[col] = Number(token);
          } else {
            row[col] = params[paramIdx++];
          }
        });

        const list = this.tables.get(tableName) || [];
        // Basic SQLite-compatible upsert behavior for the in-memory test DB.
        // Most sync writes use ON CONFLICT(id) DO UPDATE; merge those rows
        // instead of incorrectly raising a duplicate-key error.
        if (trimmed.toUpperCase().includes("ON CONFLICT") && row.id != null) {
          const existingIndex = list.findIndex((r) => r.id === row.id);
          if (existingIndex >= 0) {
            list[existingIndex] = { ...list[existingIndex], ...row };
            this.tables.set(tableName, list);
            return { lastInsertRowId: existingIndex + 1, changes: 1 };
          }
        }
        // Check UNIQUE constraints
        if (tableName === "students") {
          if (row.card_code) {
            const cardExists = list.some(
              (r) =>
                r.center_id === row.center_id && r.card_code === row.card_code,
            );
            if (cardExists) {
              throw new Error(
                "UNIQUE constraint failed: students.center_id, students.card_code",
              );
            }
          }
          if (row.student_code) {
            const codeExists = list.some(
              (r) =>
                r.center_id === row.center_id &&
                r.student_code === row.student_code,
            );
            if (codeExists) {
              throw new Error(
                "UNIQUE constraint failed: students.center_id, students.student_code",
              );
            }
          }
        }
        if (tableName === "student_cards") {
          const cardExists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.card_code === row.card_code &&
              r.status === "active",
          );
          if (cardExists) {
            throw new Error(
              "UNIQUE constraint failed: student_cards.center_id, student_cards.card_code",
            );
          }
        }
        if (tableName === "teacher_subjects") {
          const exists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.teacher_id === row.teacher_id &&
              r.subject_id === row.subject_id,
          );
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: teacher_subjects.center_id, teacher_subjects.teacher_id, teacher_subjects.subject_id",
            );
          }
        }
        if (tableName === "student_group_enrollments") {
          if (row.status === "active") {
            const exists = list.some(
              (r) =>
                r.center_id === row.center_id &&
                r.student_id === row.student_id &&
                r.group_id === row.group_id &&
                r.status === "active",
            );
            if (exists) {
              throw new Error(
                "UNIQUE constraint failed: duplicate active student_group_enrollment",
              );
            }
          }
        }
        if (tableName === "sessions" && row.schedule_id) {
          const exists = list.some(
            (r) =>
              r.group_id === row.group_id &&
              r.schedule_id === row.schedule_id &&
              r.session_date === row.session_date,
          );
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: sessions.group_id, sessions.schedule_id, sessions.session_date",
            );
          }
        }
        if (tableName === "attendance") {
          const exists = list.some(
            (r) =>
              r.session_id === row.session_id &&
              r.student_id === row.student_id,
          );
          if (exists)
            throw new Error(
              "UNIQUE constraint failed: attendance.session_id, attendance.student_id",
            );
        }
        if (tableName === "session_expected_students") {
          const exists = list.some(
            (r) =>
              r.session_id === row.session_id &&
              r.student_id === row.student_id,
          );
          if (exists)
            throw new Error(
              "UNIQUE constraint failed: session_expected_students.session_id, session_expected_students.student_id",
            );
        }
        if (tableName === "sync_operations") {
          const exists = list.some((r) => r.operation_id === row.operation_id);
          if (exists)
            throw new Error(
              "UNIQUE constraint failed: sync_operations.operation_id",
            );
        }
        if (tableName === "debt_cycles") {
          const exists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.enrollment_id === row.enrollment_id &&
              r.cycle_number === row.cycle_number,
          );
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: debt_cycles.center_id, debt_cycles.enrollment_id, debt_cycles.cycle_number",
            );
          }
        }
        if (tableName === "payment_reversals") {
          const exists = list.some((r) => r.payment_id === row.payment_id);
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: payment_reversals.payment_id",
            );
          }
        }
        if (tableName === "debt_adjustments") {
          const exists = list.some((r) => r.operation_id === row.operation_id);
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: debt_adjustments.operation_id",
            );
          }
        }
        if (tableName === "payments") {
          const exists = list.some((r) => r.operation_id === row.operation_id);
          if (exists) {
            throw new Error("UNIQUE constraint failed: payments.operation_id");
          }
        }
        if (tableName === "package_subjects") {
          const exists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.package_id === row.package_id &&
              r.subject_id === row.subject_id &&
              r.default_teacher_id === row.default_teacher_id,
          );
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: package_subjects.center_id, package_subjects.package_id, package_subjects.subject_id, package_subjects.default_teacher_id",
            );
          }
        }
        if (tableName === "package_subject_teacher_overrides") {
          const exists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.subscription_id === row.subscription_id &&
              r.subject_id === row.subject_id,
          );
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: package_subject_teacher_overrides.center_id, package_subject_teacher_overrides.subscription_id, package_subject_teacher_overrides.subject_id",
            );
          }
        }
        if (tableName === "advance_coverages") {
          const opExists = list.some(
            (r) => r.operation_id === row.operation_id,
          );
          if (opExists) {
            throw new Error(
              "UNIQUE constraint failed: advance_coverages.operation_id",
            );
          }
          const targetExists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.student_id === row.student_id &&
              r.target_future_session_id === row.target_future_session_id,
          );
          if (targetExists) {
            throw new Error(
              "UNIQUE constraint failed: advance_coverages.center_id, advance_coverages.student_id, advance_coverages.target_future_session_id",
            );
          }
          const advanceUsed = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.student_id === row.student_id &&
              r.advance_session_id === row.advance_session_id,
          );
          if (advanceUsed) {
            throw new Error(
              "Conflict: advance_session_id already used for another coverage",
            );
          }
        }
        if (tableName === "notification_events") {
          const exists = list.some((r) => r.operation_id === row.operation_id);
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: notification_events.operation_id",
            );
          }
          if (row.attendance_id && row.event_type === "attendance") {
            const attExists = list.some(
              (r) =>
                r.center_id === row.center_id &&
                r.attendance_id === row.attendance_id &&
                r.event_type === row.event_type,
            );
            if (attExists) {
              throw new Error(
                "UNIQUE constraint failed: notification_events.center_id, notification_events.attendance_id, notification_events.event_type",
              );
            }
          }
        }
        if (tableName === "notification_deliveries") {
          const exists = list.some(
            (r) =>
              r.notification_event_id === row.notification_event_id &&
              r.channel === row.channel,
          );
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: notification_deliveries.notification_event_id, notification_deliveries.channel",
            );
          }
        }
        if (tableName === "session_closing_records") {
          const exists = list.some((r) => r.operation_id === row.operation_id);
          if (exists) {
            throw new Error(
              "UNIQUE constraint failed: session_closing_records.operation_id",
            );
          }
        }
        if (tableName === "daily_closing_summaries") {
          const opExists = list.some(
            (r) => r.operation_id === row.operation_id,
          );
          if (opExists) {
            throw new Error(
              "UNIQUE constraint failed: daily_closing_summaries.operation_id",
            );
          }
          const dateExists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.business_date === row.business_date,
          );
          if (dateExists) {
            throw new Error(
              "UNIQUE constraint failed: daily_closing_summaries.center_id, daily_closing_summaries.business_date",
            );
          }
        }
        if (tableName === "devices") {
          const devExists = list.some(
            (r) =>
              r.center_id === row.center_id &&
              r.device_identifier === row.device_identifier,
          );
          if (devExists) {
            throw new Error(
              "UNIQUE constraint failed: devices.center_id, devices.device_identifier",
            );
          }
        }
        if (tableName === "sync_cursors") {
          const existingIdx = list.findIndex(
            (r) => r.center_id === row.center_id,
          );
          if (existingIdx >= 0) {
            list[existingIdx] = row;
            this.tables.set(tableName, list);
            return { lastInsertRowId: existingIdx + 1, changes: 1 };
          }
        }
        list.push(row);
        this.tables.set(tableName, list);
        return { lastInsertRowId: list.length, changes: 1 };
      }
    } else if (trimmed.toUpperCase().startsWith("UPDATE")) {
      const match = trimmed.match(/UPDATE\s+(\w+)\s+SET/i);
      if (match) {
        const tableName = match[1].toLowerCase();
        const list = this.tables.get(tableName) || [];

        if (tableName === "sync_operations") {
          const statusMatch = trimmed.match(/status\s*=\s*'([^']+)'/i);
          const isRetryInc = trimmed.includes("retry_count = retry_count + 1");
          const opId = params[params.length - 1];
          const row = list.find((r) => r.operation_id === opId);
          if (row) {
            if (statusMatch) row.status = statusMatch[1];
            if (isRetryInc) row.retry_count = (row.retry_count || 0) + 1;
            if (params.length >= 2 && trimmed.includes("last_error = ?")) {
              row.last_error = params[0];
            }
            if (trimmed.includes("next_retry_at = NULL")) {
              row.next_retry_at = null;
            } else if (trimmed.includes("next_retry_at = ?")) {
              row.next_retry_at = params[1];
            }
            if (params.length >= 2 && trimmed.includes("synced_at = ?")) {
              row.synced_at = params[0];
            }
          }
        } else if (tableName === "student_cards") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = 'inactive'"))
              row.status = "inactive";
            else if (trimmed.includes("status = ?")) row.status = params[0];

            if (trimmed.includes("deactivated_at = ?")) {
              row.deactivated_at = trimmed.includes("status = ?")
                ? params[1]
                : params[0];
            }
          }
        } else if (tableName === "students") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (params.length >= 2 && trimmed.includes("updated_at = ?")) {
                row.updated_at = params[1];
              }
            } else if (params.length >= 6) {
              row.full_name = params[0];
              row.phone = params[1];
              row.parent_phone = params[2];
              row.grade = params[3];
              row.student_type = params[4];
              row.notes = params[5];
              row.updated_at = params[6];
            }
          }
        } else if (tableName === "teachers") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = 'inactive'")) {
              row.status = "inactive";
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            } else if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (params.length >= 2) row.updated_at = params[1];
            } else if (params.length >= 4) {
              row.name = params[0];
              row.phone = params[1];
              row.notes = params[2];
              row.status = params[3];
              row.updated_at = params[4];
            }
          }
        } else if (tableName === "subjects") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = 'inactive'")) {
              row.status = "inactive";
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            } else if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (params.length >= 2) row.updated_at = params[1];
            } else if (params.length >= 3) {
              row.name = params[0];
              row.code = params[1];
              row.status = params[2];
              row.updated_at = params[3];
            }
          }
        } else if (tableName === "groups") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("monthly_price =")) {
              const priceMatch = trimmed.match(
                /monthly_price\s*=\s*(\d+(?:\.\d+)?)/i,
              );
              if (priceMatch) {
                row.monthly_price = parseFloat(priceMatch[1]);
              } else if (trimmed.includes("monthly_price = ?")) {
                row.monthly_price = params[0];
              }
            }
            if (trimmed.includes("status = 'inactive'")) {
              row.status = "inactive";
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            } else if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (params.length >= 2) row.updated_at = params[1];
            } else if (params.length >= 8) {
              row.name = params[0];
              row.teacher_id = params[1];
              row.subject_id = params[2];
              row.grade = params[3];
              row.session_price = params[4];
              row.monthly_price = params[5];
              row.session_duration_minutes = params[6];
              row.late_after_minutes = params[7];
              row.status = params[8];
              row.updated_at = params[9];
            }
          }
        } else if (tableName === "group_schedules") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = 'inactive'"))
              row.status = "inactive";
            else if (trimmed.includes("status = ?")) row.status = params[0];
          }
        } else if (tableName === "student_group_enrollments") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = 'ended'")) {
              row.status = "ended";
              if (trimmed.includes("end_date = ?")) row.end_date = params[0];
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[1];
            } else if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (params.length >= 2 && trimmed.includes("end_date = ?"))
                row.end_date = params[1];
              if (params.length >= 3 && trimmed.includes("updated_at = ?"))
                row.updated_at = params[2];
            }
          }
        } else if (tableName === "sessions") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = 'cancelled'")) {
              row.status = "cancelled";
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            } else if (trimmed.includes("status = 'closed'")) {
              row.status = "closed";
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            } else if (trimmed.includes("status = 'open'")) {
              row.status = "open";
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            } else if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[1];
            }
          }
        } else if (tableName === "payments") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("is_reversed = 1")) {
              row.is_reversed = 1;
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            }
          }
        } else if (tableName === "debt_cycles") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[1];
            }
          }
        } else if (tableName === "packages") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("name = ?") && params.length >= 5) {
              row.name = params[0];
              row.price = params[1];
              row.description = params[2];
              row.status = params[3];
              row.updated_at = params[4];
            } else if (trimmed.includes("status = 'inactive'")) {
              row.status = "inactive";
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[0];
            } else if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (params.length >= 2) row.updated_at = params[1];
            }
          }
        } else if (tableName === "student_package_subscriptions") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = 'cancelled'")) {
              row.status = "cancelled";
              if (
                trimmed.includes("cancellation_date = ?") &&
                trimmed.includes("end_date = ?")
              ) {
                row.cancellation_date = params[0];
                row.end_date = params[1];
                if (trimmed.includes("updated_at = ?"))
                  row.updated_at = params[2];
              } else if (trimmed.includes("cancellation_date = ?")) {
                row.cancellation_date = params[0];
                if (trimmed.includes("updated_at = ?"))
                  row.updated_at = params[1];
              }
            } else if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (params.length >= 2) row.updated_at = params[1];
            }
          }
        } else if (tableName === "notification_deliveries") {
          const id = params[params.length - 1];
          const row = list.find(
            (r) => r.id === id || r.notification_event_id === id,
          );
          if (row) {
            if (trimmed.includes("status = ?")) {
              row.status = params[0];
              if (trimmed.includes("sent_at = ?")) row.sent_at = params[1];
              if (trimmed.includes("failure_reason = ?"))
                row.failure_reason = params[1];
              if (trimmed.includes("updated_at = ?"))
                row.updated_at = params[params.length - 2];
            }
            if (trimmed.includes("retry_count = retry_count + 1")) {
              row.retry_count = (row.retry_count || 0) + 1;
            }
          }
        } else if (tableName === "notification_templates") {
          // UPDATE notification_templates SET template_body = ?, updated_by = ?, updated_at = ? WHERE id = ? AND center_id = ?
          const centerId = params[params.length - 1];
          const id = params[params.length - 2];
          const row = list.find((r) => r.id === id && r.center_id === centerId);
          if (row) {
            if (trimmed.includes("template_body = ?")) {
              row.template_body = params[0];
              row.updated_by = params[1];
              row.updated_at = params[2];
            }
          }
        } else if (tableName === "daily_closing_summaries") {
          const centerId = params[params.length - 2];
          const businessDate = params[params.length - 1];
          const row = list.find(
            (r) => r.center_id === centerId && r.business_date === businessDate,
          );
          if (row) {
            if (
              trimmed.includes("status = 'open'") ||
              (trimmed.includes("reopened_by") && params.length >= 4)
            ) {
              row.status = "open";
              row.reopened_by = params[0];
              row.reopened_at = params[1];
              row.reopen_reason = params[2];
              row.updated_at = params[3];
            } else if (trimmed.includes("status = 'closed'")) {
              row.status = "closed";
              row.operation_id = params[0];
              row.closed_by = params[1];
              row.closed_at = params[2];
              row.total_cash = params[3];
              row.monthly_total = params[4];
              row.partial_total = params[5];
              row.session_total = params[6];
              row.external_makeup_total = params[7];
              row.package_total = params[8];
              row.payment_count = params[9];
              row.updated_at = params[10];
            }
          }
        } else if (tableName === "devices") {
          const id = params[params.length - 1];
          const row = list.find((r) => r.id === id);
          if (row) {
            if (trimmed.includes("status = ?")) {
              row.status = params[0];
              row.last_seen_at = params[1];
            } else if (trimmed.includes("last_seen_at = ?")) {
              row.last_seen_at = params[0];
              row.user_id = params[1];
            }
          }
        } else if (tableName === "sync_cursors") {
          const centerId = params[params.length - 1];
          const row = list.find((r) => r.center_id === centerId);
          if (row) {
            if (trimmed.includes("reset_generation")) {
              row.reset_generation = params[0];
              row.updated_at = params[1];
            } else {
              row.server_cursor = params[0];
              row.updated_at = params[1];
            }
          }
        }
        return { lastInsertRowId: 0, changes: 1 };
      }
    } else if (trimmed.toUpperCase().startsWith("DELETE")) {
      if (trimmed.includes("FROM teacher_subjects")) {
        const list = this.tables.get("teacher_subjects") || [];
        if (params.length === 3) {
          const [centerId, teacherId, subjectId] = params;
          const remaining = list.filter(
            (r) =>
              !(
                r.center_id === centerId &&
                r.teacher_id === teacherId &&
                r.subject_id === subjectId
              ),
          );
          this.tables.set("teacher_subjects", remaining);
        }
      }
      if (trimmed.includes("FROM package_subjects")) {
        const list = this.tables.get("package_subjects") || [];
        if (params.length === 3 && trimmed.includes("subject_id = ?")) {
          const [centerId, packageId, subjectId] = params;
          const remaining = list.filter(
            (r) =>
              !(
                r.center_id === centerId &&
                r.package_id === packageId &&
                r.subject_id === subjectId
              ),
          );
          this.tables.set("package_subjects", remaining);
        } else if (params.length === 2) {
          const [centerId, packageId] = params;
          const remaining = list.filter(
            (r) => !(r.center_id === centerId && r.package_id === packageId),
          );
          this.tables.set("package_subjects", remaining);
        } else if (params.length === 1 && trimmed.includes("package_id = ?")) {
          const packageId = params[0];
          const remaining = list.filter((r) => r.package_id !== packageId);
          this.tables.set("package_subjects", remaining);
        }
      }
      if (trimmed.includes("FROM package_subject_teacher_overrides")) {
        const list = this.tables.get("package_subject_teacher_overrides") || [];
        if (params.length === 3 && trimmed.includes("subject_id = ?")) {
          const [centerId, subscriptionId, subjectId] = params;
          const remaining = list.filter(
            (r) =>
              !(
                r.center_id === centerId &&
                r.subscription_id === subscriptionId &&
                r.subject_id === subjectId
              ),
          );
          this.tables.set("package_subject_teacher_overrides", remaining);
        } else if (params.length === 2 && trimmed.includes("subject_id = ?")) {
          const [subscriptionId, subjectId] = params;
          const remaining = list.filter(
            (r) =>
              !(
                r.subscription_id === subscriptionId &&
                r.subject_id === subjectId
              ),
          );
          this.tables.set("package_subject_teacher_overrides", remaining);
        } else if (params.length === 1) {
          const id = params[0];
          const remaining = list.filter(
            (r) => r.id !== id && r.subscription_id !== id,
          );
          this.tables.set("package_subject_teacher_overrides", remaining);
        }
      }
      if (trimmed.includes("FROM student_cards")) {
        const list = this.tables.get("student_cards") || [];
        if (trimmed.includes("student_id = ?") && params.length >= 1) {
          const studentId = params[0];
          this.tables.set(
            "student_cards",
            list.filter((r) => r.student_id !== studentId),
          );
        } else if (trimmed.includes("id = ?") && params.length >= 1) {
          const id = params[0];
          this.tables.set(
            "student_cards",
            list.filter((r) => r.id !== id),
          );
        }
      }
      if (trimmed.includes("FROM student_group_enrollments")) {
        const list = this.tables.get("student_group_enrollments") || [];
        if (trimmed.includes("student_id = ?") && params.length >= 1) {
          const studentId = params[0];
          this.tables.set(
            "student_group_enrollments",
            list.filter((r) => r.student_id !== studentId),
          );
        } else if (trimmed.includes("id = ?") && params.length >= 1) {
          const id = params[0];
          this.tables.set(
            "student_group_enrollments",
            list.filter((r) => r.id !== id),
          );
        }
      }
      if (trimmed.includes("FROM students")) {
        const list = this.tables.get("students") || [];
        if (trimmed.includes("id = ?") && params.length >= 1) {
          const studentId = params[0];
          this.tables.set(
            "students",
            list.filter((r) => r.id !== studentId),
          );
        }
      }
      return { lastInsertRowId: 0, changes: 1 };
    }
    return { lastInsertRowId: 0, changes: 0 };
  }

  getAllSync<T = any>(sql: string, params: any[] = []): T[] {
    const trimmed = sql.trim();

    if (trimmed.includes("PRAGMA user_version")) {
      return [{ user_version: this.userVersion }] as any;
    }

    if (trimmed.includes("FROM schema_migrations")) {
      const list = this.tables.get("schema_migrations") || [];
      if (trimmed.includes("ORDER BY version DESC")) {
        return [...list].sort((a, b) => b.version - a.version) as T[];
      }
      return [...list].sort((a, b) => a.version - b.version) as T[];
    }

    if (trimmed.includes("FROM centers")) {
      return (this.tables.get("centers") || []) as T[];
    }

    if (trimmed.includes("FROM sessions")) {
      const list = this.tables.get("sessions") || [];
      const groups = this.tables.get("groups") || [];
      const subjects = this.tables.get("subjects") || [];
      const teachers = this.tables.get("teachers") || [];
      const expected = this.tables.get("session_expected_students") || [];

      const joined = list.map((s) => {
        const g = groups.find((grp) => grp.id === s.group_id);
        const subjId = s.subject_id || (g ? g.subject_id : "");
        const teachId = s.teacher_id || (g ? g.teacher_id : "");
        const subj = subjects.find((sub) => sub.id === subjId);
        const t = teachers.find((tch) => tch.id === teachId);
        return {
          id: s.id,
          centerId: s.center_id,
          groupId: s.group_id,
          scheduleId: s.schedule_id || null,
          subjectId: subjId,
          teacherId: teachId,
          sessionPrice: s.session_price ?? (g ? g.default_fee : 0),
          lateAfterMinutes: s.late_after_minutes ?? 15,
          sessionDate: s.session_date,
          startTime: s.start_time,
          endTime: s.end_time,
          status: s.status,
          groupName: g ? g.name : "",
          subjectName: subj ? subj.name : "",
          teacherName: t ? t.name : "",
          // snake_case
          center_id: s.center_id,
          group_id: s.group_id,
          schedule_id: s.schedule_id || null,
          subject_id: subjId,
          teacher_id: teachId,
          session_price: s.session_price ?? (g ? g.default_fee : 0),
          late_after_minutes: s.late_after_minutes ?? 15,
          session_date: s.session_date,
          start_time: s.start_time,
          end_time: s.end_time,
        };
      });

      if (
        params.length >= 3 &&
        (trimmed.includes("subject_id = ?") ||
          trimmed.includes("s.subject_id = ?")) &&
        (trimmed.includes("teacher_id = ?") ||
          trimmed.includes("s.teacher_id = ?"))
      ) {
        const [cId, subId, teachId, exclId] = params;
        return joined.filter(
          (s) =>
            s.centerId === cId &&
            s.subjectId === subId &&
            s.teacherId === teachId &&
            (!exclId || s.id !== exclId),
        ) as T[];
      }

      if (
        params.length === 2 &&
        (trimmed.includes("center_id = ? AND session_date = ?") ||
          trimmed.includes("s.center_id = ? AND s.session_date = ?")) &&
        !trimmed.includes("JOIN groups")
      ) {
        return joined.filter(
          (r) => r.centerId === params[0] && r.sessionDate === params[1],
        ) as T[];
      }

      if (
        params.length >= 2 &&
        (trimmed.includes("center_id = ? AND id = ?") ||
          trimmed.includes("s.center_id = ? AND s.id = ?") ||
          trimmed.includes("center_id = ? AND s.id = ?") ||
          (trimmed.includes("center_id = ?") &&
            (trimmed.includes(" AND id = ?") ||
              trimmed.includes("WHERE id = ?") ||
              trimmed.includes("s.id = ?")) &&
            !trimmed.includes("JOIN groups")))
      ) {
        return joined.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }

      if (
        params.length >= 2 &&
        (trimmed.includes("s.center_id = ? AND s.id = ?") ||
          (trimmed.includes("center_id = ?") && trimmed.includes("s.id = ?")))
      ) {
        return joined.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }

      if (
        params.length >= 3 &&
        trimmed.includes(
          "group_id = ? AND schedule_id = ? AND session_date = ?",
        )
      ) {
        const hasCenterScope = trimmed.includes(
          "center_id = ? AND group_id = ? AND schedule_id = ? AND session_date = ?",
        );
        const [centerId, grpId, schedId, sDate] = hasCenterScope
          ? params
          : [undefined, ...params];
        return joined.filter(
          (s) =>
            (!hasCenterScope || s.centerId === centerId) &&
            s.groupId === grpId &&
            s.scheduleId === schedId &&
            s.sessionDate === sDate,
        ) as T[];
      }

      if (params.length >= 3 && trimmed.includes("JOIN groups")) {
        const [studentId, centerId, dateStr] = params;
        return joined.filter((s) => {
          if (
            s.centerId !== centerId ||
            s.sessionDate !== dateStr ||
            (s.status !== "open" && s.status !== "scheduled")
          )
            return false;
          const isExp = expected.some(
            (e) => e.session_id === s.id && e.student_id === studentId,
          );
          const hasSnapshot = expected.some((e) => e.session_id === s.id);
          if (hasSnapshot) {
            // For generated sessions with an expected students snapshot, eligibility derives strictly from the immutable snapshot
            return isExp;
          }

          const enrollments =
            this.tables.get("student_group_enrollments") || [];
          const isEnrolled = enrollments.some(
            (enr) =>
              enr.center_id === centerId &&
              enr.student_id === studentId &&
              enr.group_id === s.groupId &&
              enr.status === "active" &&
              enr.start_date <= dateStr &&
              (!enr.end_date || enr.end_date >= dateStr),
          );
          const subscriptions = this.tables.get("student_subscriptions") || [];
          const isSubscribed = subscriptions.some(
            (sub) =>
              sub.center_id === centerId &&
              sub.student_id === studentId &&
              sub.group_id === s.groupId &&
              sub.status === "active",
          );
          const pkgSubs =
            this.tables.get("student_package_subscriptions") || [];
          const activePkgSubs = pkgSubs.filter(
            (ps) =>
              ps.center_id === centerId &&
              ps.student_id === studentId &&
              ps.status === "active" &&
              ps.start_date <= dateStr &&
              (!ps.end_date || ps.end_date >= dateStr),
          );
          const pkgSubjects = this.tables.get("package_subjects") || [];
          const overrides =
            this.tables.get("package_subject_teacher_overrides") || [];
          const isPackageEligible = activePkgSubs.some((ps) => {
            const psSubjects = pkgSubjects.filter(
              (psub) => psub.package_id === ps.package_id,
            );
            return psSubjects.some((psub) => {
              if (psub.subject_id !== s.subjectId) return false;
              const ov = overrides.find(
                (o) =>
                  o.subscription_id === ps.id && o.subject_id === s.subjectId,
              );
              const effectiveTeacherId = ov
                ? ov.teacher_id
                : psub.default_teacher_id;
              return effectiveTeacherId === s.teacherId;
            });
          });
          return isEnrolled || isSubscribed || isPackageEligible;
        }) as T[];
      }

      if (
        params.length >= 2 &&
        (trimmed.includes("center_id = ? AND id = ?") ||
          trimmed.includes("s.center_id = ? AND s.id = ?"))
      ) {
        return joined.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }

      if (
        params.length >= 1 &&
        (trimmed.includes("center_id = ?") ||
          trimmed.includes("s.center_id = ?"))
      ) {
        return joined.filter((r) => r.centerId === params[0]) as T[];
      }

      return joined as T[];
    }

    if (trimmed.includes("FROM student_cards")) {
      const list = this.tables.get("student_cards") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        studentId: r.student_id,
        cardCode: r.card_code,
        status: r.status,
        issuedAt: r.issued_at,
        deactivatedAt: r.deactivated_at,
        createdAt: r.created_at,
      }));
      if (params.length >= 2 && trimmed.includes("card_code = ?")) {
        const centerId = params[0];
        const cardCode = params[1];
        if (trimmed.includes("status = 'active'")) {
          return mapped.filter(
            (r) =>
              r.centerId === centerId &&
              r.cardCode === cardCode &&
              r.status === "active",
          ) as T[];
        }
        return mapped.filter(
          (r) => r.centerId === centerId && r.cardCode === cardCode,
        ) as T[];
      }
      // findByCardCodeAnywhere intentionally has no center predicate. The
      // mock used to return the first card in the table for this one-parameter
      // query, making every student creation look like a duplicate card.
      if (params.length === 1 && trimmed.includes("card_code = ?")) {
        const cardCode = params[0];
        const result = mapped.filter((r) => r.cardCode === cardCode);
        if (trimmed.includes("status = 'active'")) {
          return result.filter((r) => r.status === "active") as T[];
        }
        return result as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        if (trimmed.includes("status = 'active'")) {
          return mapped.filter(
            (r) =>
              r.centerId === params[0] &&
              r.studentId === params[1] &&
              r.status === "active",
          ) as T[];
        }
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM teachers")) {
      const list = this.tables.get("teachers") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        name: r.name,
        phone: r.phone,
        status: r.status || "active",
        notes: r.notes || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        if (trimmed.includes("status = 'active'")) {
          return mapped.filter(
            (r) => r.centerId === params[0] && r.status === "active",
          ) as T[];
        }
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM subjects")) {
      const list = this.tables.get("subjects") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        name: r.name,
        code: r.code,
        status: r.status || "active",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("code = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.code === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        if (trimmed.includes("status = 'active'")) {
          return mapped.filter(
            (r) => r.centerId === params[0] && r.status === "active",
          ) as T[];
        }
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM teacher_subjects")) {
      const list = this.tables.get("teacher_subjects") || [];
      const teachers = this.tables.get("teachers") || [];
      const subjects = this.tables.get("subjects") || [];
      const mapped = list.map((r) => {
        const t = teachers.find((tch) => tch.id === r.teacher_id);
        const s = subjects.find((sbj) => sbj.id === r.subject_id);
        return {
          id: r.id,
          centerId: r.center_id,
          teacherId: r.teacher_id,
          subjectId: r.subject_id,
          createdAt: r.created_at,
          teacherName: t ? t.name : "",
          subjectName: s ? s.name : "",
        };
      });
      if (
        params.length >= 3 &&
        trimmed.includes("teacher_id = ? AND subject_id = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.teacherId === params[1] &&
            r.subjectId === params[2],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("teacher_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.teacherId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("subject_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.subjectId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM groups")) {
      const list = this.tables.get("groups") || [];
      const teachers = this.tables.get("teachers") || [];
      const subjects = this.tables.get("subjects") || [];
      const mapped = list.map((r) => {
        const t = teachers.find((tch) => tch.id === r.teacher_id);
        const s = subjects.find((sbj) => sbj.id === r.subject_id);
        return {
          id: r.id,
          centerId: r.center_id,
          name: r.name,
          teacherId: r.teacher_id,
          subjectId: r.subject_id,
          grade: r.grade,
          defaultFee: r.default_fee,
          sessionPrice: r.session_price || r.default_fee || 0,
          monthlyPrice: r.monthly_price || r.default_fee || 0,
          sessionDurationMinutes: r.session_duration_minutes || 120,
          lateAfterMinutes: r.late_after_minutes || 15,
          status: r.status || "active",
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          teacherName: t ? t.name : "",
          subjectName: s ? s.name : "",
        };
      });
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") ||
          trimmed.includes("WHERE id = ?") ||
          trimmed.includes("g.id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        if (trimmed.includes("status = 'active'")) {
          return mapped.filter(
            (r) => r.centerId === params[0] && r.status === "active",
          ) as T[];
        }
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM group_schedules")) {
      const list = this.tables.get("group_schedules") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        groupId: r.group_id,
        dayOfWeek: r.day_of_week,
        startTime: r.start_time,
        endTime: r.end_time,
        status: r.status || "active",
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      if (
        params.length >= 3 &&
        trimmed.includes("group_id = ? AND day_of_week = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.groupId === params[1] &&
            r.dayOfWeek === params[2] &&
            r.status === "active",
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("group_id = ?")) {
        return mapped.filter(
          (r) => r.groupId === params[1] && r.status === "active",
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM student_group_enrollments")) {
      const list = this.tables.get("student_group_enrollments") || [];
      const students = this.tables.get("students") || [];
      const groups = this.tables.get("groups") || [];
      const mapped = list.map((r) => {
        const std = students.find((s) => s.id === r.student_id);
        const grp = groups.find((g) => g.id === r.group_id);
        return {
          id: r.id,
          centerId: r.center_id,
          studentId: r.student_id,
          groupId: r.group_id,
          startDate: r.start_date,
          endDate: r.end_date,
          status: r.status || "active",
          specialMonthlyPrice: r.special_monthly_price,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          studentName: std ? std.full_name : "",
          groupName: grp ? grp.name : "",
        };
      });
      if (
        params.length >= 3 &&
        trimmed.includes("student_id = ? AND group_id = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.studentId === params[1] &&
            r.groupId === params[2] &&
            r.status === "active",
        ) as T[];
      }
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        if (trimmed.includes("status = 'active'")) {
          return mapped.filter(
            (r) =>
              r.centerId === params[0] &&
              r.studentId === params[1] &&
              r.status === "active",
          ) as T[];
        }
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("group_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.groupId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM audit_logs")) {
      const list = this.tables.get("audit_logs") || [];
      if (params.length >= 1) {
        return list
          .filter((r) => r.center_id === params[0])
          .map((r) => ({
            id: r.id,
            operationId: r.operation_id,
            centerId: r.center_id,
            userId: r.user_id,
            deviceId: r.device_id,
            entityType: r.entity_type,
            entityId: r.entity_id,
            action: r.action,
            timestamp: r.timestamp,
            payload: r.payload,
          })) as T[];
      }
      return list as T[];
    }

    if (trimmed.includes("FROM session_expected_students")) {
      const list = this.tables.get("session_expected_students") || [];
      if (
        trimmed.includes("SELECT DISTINCT student_id") &&
        params.length >= 2
      ) {
        const centerId = params[0];
        const sIds = params.slice(1);
        const filtered = list.filter(
          (r) => r.center_id === centerId && sIds.includes(r.session_id),
        );
        const unique = Array.from(
          new Set(filtered.map((r) => r.student_id)),
        ).map((id) => ({ student_id: id }));
        return unique as T[];
      }
      if (params.length >= 2) {
        return list
          .filter((r) => r.center_id === params[0] && r.session_id === params[1])
          .map((r) => ({
            id: r.id,
            centerId: r.center_id,
            sessionId: r.session_id,
            studentId: r.student_id,
            center_id: r.center_id,
            session_id: r.session_id,
            student_id: r.student_id,
          })) as T[];
      }
      return list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        sessionId: r.session_id,
        studentId: r.student_id,
        center_id: r.center_id,
        session_id: r.session_id,
        student_id: r.student_id,
      })) as T[];
    }

    if (trimmed.includes("FROM attendance")) {
      const list = this.tables.get("attendance") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        studentId: r.student_id,
        sessionId: r.session_id,
        checkInTime: r.check_in_time,
        status: r.status,
        isLate: r.is_late === 1 || r.is_late === true,
        attendanceType: r.attendance_type || "present",
        originalAbsenceId: r.original_absence_id || null,
        isExternal: r.is_external === 1 || r.is_external === true,
        operationId: r.operation_id,
        // snake_case
        center_id: r.center_id,
        student_id: r.student_id,
        session_id: r.session_id,
        check_in_time: r.check_in_time,
        is_late: r.is_late,
        attendance_type: r.attendance_type,
        original_absence_id: r.original_absence_id,
        is_external: r.is_external,
        operation_id: r.operation_id,
      }));
      if (
        trimmed.includes(
          "center_id = ? AND session_id = ? AND student_id = ?",
        ) &&
        params.length === 3
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.sessionId === params[1] &&
            r.studentId === params[2],
        ) as T[];
      }
      if (
        trimmed.includes("session_id = ? AND student_id = ?") &&
        params.length === 2
      ) {
        return mapped.filter(
          (r) => r.sessionId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (trimmed.includes("session_id IN (") && params.length >= 2) {
        const centerId = params[0];
        const sIds = params.slice(1);
        return mapped.filter(
          (r) => r.centerId === centerId && sIds.includes(r.sessionId),
        ) as T[];
      }
      if (
        params.length === 2 &&
        trimmed.includes("center_id = ? AND session_id = ?")
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.sessionId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("is_external = 1")) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            (r.isExternal || (r as any).is_external === 1),
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM students")) {
      const list = this.tables.get("students") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        studentCode: r.student_code || `MIGRATED-LEGACY-${r.id}`,
        fullName: r.full_name,
        cardCode: r.card_code,
        phone: r.phone,
        parentPhone: r.parent_phone,
        grade: r.grade,
        status: r.status,
        studentType: r.student_type || "registered",
        notes: r.notes || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at || null,
      }));
      if (params.length >= 2 && trimmed.includes("card_code = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.cardCode === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_code = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentCode === params[1],
        ) as T[];
      }
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM student_subscriptions")) {
      const list = this.tables.get("student_subscriptions") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        studentId: r.student_id,
        groupId: r.group_id,
        packageName: r.package_name,
        amountDue: r.amount_due,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        status: r.status,
      }));
      if (params.length >= 2) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.studentId === params[1] &&
            r.status === "active",
        ) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM debt_cycles")) {
      const list = this.tables.get("debt_cycles") || [];
      const groups = this.tables.get("groups") || [];
      const packages = this.tables.get("packages") || [];
      const mapped = list.map((r) => {
        const g = groups.find((grp) => grp.id === r.group_id);
        const p = packages.find((pkg) => pkg.id === r.package_id);
        return {
          id: r.id,
          centerId: r.center_id,
          studentId: r.student_id,
          enrollmentId: r.enrollment_id,
          groupId: r.group_id,
          cycleNumber: r.cycle_number,
          startDate: r.start_date,
          endDate: r.end_date,
          cyclePrice: r.cycle_price,
          status: r.status,
          createdAt: r.created_at,
          updatedAt: r.updated_at || null,
          groupName: g ? g.name : p ? p.name : "",
          packageName: p ? p.name : "",
          packageSubscriptionId: r.package_subscription_id || null,
          packageId: r.package_id || null,
          cycleType: r.cycle_type || "group",
          // snake_case
          center_id: r.center_id,
          student_id: r.student_id,
          enrollment_id: r.enrollment_id,
          group_id: r.group_id,
          cycle_number: r.cycle_number,
          start_date: r.start_date,
          end_date: r.end_date,
          cycle_price: r.cycle_price,
          package_subscription_id: r.package_subscription_id,
          package_id: r.package_id,
          cycle_type: r.cycle_type,
        };
      });
      if (
        params.length >= 3 &&
        trimmed.includes("enrollment_id = ? AND cycle_number = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.enrollmentId === params[1] &&
            r.cycleNumber === params[2],
        ) as T[];
      }
      if (
        params.length >= 2 &&
        trimmed.includes("package_subscription_id = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] && r.packageSubscriptionId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("enrollment_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.enrollmentId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM payment_reversals")) {
      const list = this.tables.get("payment_reversals") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        centerId: r.center_id,
        paymentId: r.payment_id,
        studentId: r.student_id,
        reversedAmount: r.reversed_amount,
        reason: r.reason,
        reversedBy: r.reversed_by,
        reversedAt: r.reversed_at,
        createdAt: r.created_at,
      }));
      if (params.length >= 2 && trimmed.includes("payment_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.paymentId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM debt_adjustments")) {
      const list = this.tables.get("debt_adjustments") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        centerId: r.center_id,
        studentId: r.student_id,
        enrollmentId: r.enrollment_id || null,
        debtCycleId: r.debt_cycle_id,
        amountBefore: r.amount_before,
        adjustmentAmount: r.adjustment_amount,
        amountAfter: r.amount_after,
        reason: r.reason,
        createdBy: r.created_by,
        createdAt: r.created_at,
      }));
      if (params.length >= 2 && trimmed.includes("debt_cycle_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.debtCycleId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM payments")) {
      const list = this.tables.get("payments") || [];
      if (trimmed.includes("created_at LIKE ?")) {
        const centerId = params[0];
        const pattern = String(params[1]).replace("%", "");
        return list.filter(
          (r) =>
            r.center_id === centerId &&
            (!r.is_reversed || r.is_reversed === 0) &&
            (r.created_at || "").startsWith(pattern),
        ) as T[];
      }
      const mapped = list.map((r) => {
        const pType = r.payment_type === "cash" ? "session" : r.payment_type;
        const pMethod = r.payment_method || "cash";
        return {
          id: r.id,
          operationId: r.operation_id,
          centerId: r.center_id,
          studentId: r.student_id,
          subscriptionId: r.subscription_id || null,
          debtCycleId: r.debt_cycle_id || null,
          sessionId: r.session_id || null,
          amount: Number(r.amount) || 0,
          paymentType: pType,
          paymentMethod: pMethod,
          paymentDate:
            r.payment_date || (r.created_at ? r.created_at.slice(0, 10) : ""),
          notes: r.notes || null,
          isReversed: r.is_reversed === 1 || r.is_reversed === true,
          createdAt: r.created_at,
          userId: r.user_id,
          updatedAt: r.updated_at || null,
          // snake_case
          operation_id: r.operation_id,
          center_id: r.center_id,
          student_id: r.student_id,
          subscription_id: r.subscription_id || null,
          debt_cycle_id: r.debt_cycle_id || null,
          session_id: r.session_id || null,
          payment_type: pType,
          payment_method: pMethod,
          payment_date:
            r.payment_date || (r.created_at ? r.created_at.slice(0, 10) : ""),
          is_reversed: r.is_reversed === 1 || r.is_reversed === true ? 1 : 0,
          created_at: r.created_at,
          user_id: r.user_id,
          updated_at: r.updated_at || null,
        };
      });
      if (
        params.length >= 3 &&
        trimmed.includes("student_id = ?") &&
        trimmed.includes("session_id = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.studentId === params[1] &&
            r.sessionId === params[2],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("payment_date = ?")) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            (r.paymentDate === params[1] ||
              (!r.paymentDate && r.createdAt?.startsWith(params[1]))) &&
            !r.isReversed,
        ) as T[];
      }
      if (params.length === 1 && trimmed.includes("payment_date = ?")) {
        return mapped.filter(
          (r) =>
            (r.paymentDate === params[0] ||
              (!r.paymentDate && r.createdAt?.startsWith(params[0]))) &&
            !r.isReversed,
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("debt_cycle_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.debtCycleId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("session_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.sessionId === params[1],
        ) as T[];
      }
      if (
        params.length >= 2 &&
        trimmed.includes("center_id = ?") &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (
        params.length >= 1 &&
        (trimmed.includes("WHERE id = ?") || trimmed.includes("AND id = ?"))
      ) {
        return mapped.filter((r) => r.id === params[params.length - 1]) as T[];
      }
      if (params.length >= 1 && trimmed.includes("operation_id = ?")) {
        return mapped.filter((r) => r.operationId === params[0]) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM sync_operations")) {
      const list = this.tables.get("sync_operations") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        centerId: r.center_id,
        userId: r.user_id,
        deviceId: r.device_id,
        operationType: r.operation_type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payload: r.payload,
        status: r.status,
        createdAt: r.created_at,
        syncedAt: r.synced_at,
        retryCount: r.retry_count,
        lastError: r.last_error,
        nextRetryAt: r.next_retry_at || null,
      }));

      // Support the diagnostic queries used by Sync Debug in the in-memory
      // database as well as native SQLite (status filters, ordering and
      // LIMIT). Keeping the mock behaviour close to SQLite prevents tests
      // and web fallback builds from showing synced rows as unsynced.
      if (trimmed.includes("status IN (")) {
        const statusMatch = trimmed.match(/status\s+IN\s*\(([^)]+)\)/i);
        const statuses = statusMatch
          ? statusMatch[1]
              .split(",")
              .map((value) => value.trim().replace(/^['\"]|['\"]$/g, "").toLowerCase())
          : [];
        const centerId = params[0];
        let result = mapped.filter((row) =>
          row.centerId === centerId && statuses.includes(String(row.status).toLowerCase()),
        );
        result.sort((a, b) => {
          const descending = /ORDER BY\s+created_at\s+DESC/i.test(trimmed);
          const direction = descending ? -1 : 1;
          return String(a.createdAt || "").localeCompare(String(b.createdAt || "")) * direction;
        });
        if (/LIMIT\s+\?/i.test(trimmed)) {
          const limit = Number(params[params.length - 1]);
          if (Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);
        }
        return result as T[];
      }

      if (params.length >= 1 && trimmed.includes("WHERE operation_id = ?")) {
        return mapped.filter((r) => r.operationId === params[0]) as T[];
      }
      if (params.length >= 1 && trimmed.includes("status = 'pending'")) {
        const now = params[1] ? new Date(params[1]).getTime() : Date.now();
        return mapped.filter((r) => r.centerId === params[0] &&
          (r.status === "pending" || (r.status === "failed" && Number(r.retryCount || 0) < 10 && (!r.nextRetryAt || new Date(r.nextRetryAt).getTime() <= now)))) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        let result = mapped.filter((r) => r.centerId === params[0]);
        if (/ORDER BY\s+created_at\s+(ASC|DESC)/i.test(trimmed)) {
          const descending = /ORDER BY\s+created_at\s+DESC/i.test(trimmed);
          const direction = descending ? -1 : 1;
          result.sort((a, b) =>
            String(a.createdAt || "").localeCompare(String(b.createdAt || "")) * direction,
          );
        }
        if (/LIMIT\s+\?/i.test(trimmed)) {
          const limit = Number(params[params.length - 1]);
          if (Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);
        }
        return result as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM packages")) {
      const list = this.tables.get("packages") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        name: r.name,
        price: r.price,
        description: r.description || null,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at || null,
        // snake_case
        center_id: r.center_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      if (params.length >= 2 && trimmed.includes("status = 'active'")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.status === "active",
        ) as T[];
      }
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (
        params.length >= 1 &&
        (trimmed.includes("WHERE id = ?") || trimmed.includes("AND id = ?"))
      ) {
        return mapped.filter((r) => r.id === params[params.length - 1]) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM package_subjects")) {
      const list = this.tables.get("package_subjects") || [];
      const subjects = this.tables.get("subjects") || [];
      const teachers = this.tables.get("teachers") || [];
      const groups = this.tables.get("groups") || [];
      const mapped = list.map((r) => {
        const s = subjects.find((sub) => sub.id === r.subject_id);
        const t = teachers.find((tch) => tch.id === r.default_teacher_id);
        const g = groups.find((grp) => grp.id === r.group_id);
        return {
          id: r.id,
          centerId: r.center_id,
          packageId: r.package_id,
          subjectId: r.subject_id,
          defaultTeacherId: r.default_teacher_id,
          groupId: r.group_id || null,
          createdAt: r.created_at,
          subjectName: s ? s.name : "",
          subjectCode: s ? s.code : "",
           defaultTeacherName: t ? t.name : "",
           groupName: g ? g.name : "",
           // snake_case
          center_id: r.center_id,
          package_id: r.package_id,
          subject_id: r.subject_id,
          default_teacher_id: r.default_teacher_id,
          group_id: r.group_id || null,
          created_at: r.created_at,
        };
      });
       if (
         params.length >= 3 &&
         trimmed.includes("package_id = ?") &&
         trimmed.includes("default_teacher_id = ?")
       ) {
         return mapped.filter(
           (r) =>
             r.centerId === params[0] &&
             r.packageId === params[1] &&
             r.defaultTeacherId === params[2],
         ) as T[];
       }
       if (
        params.length >= 3 &&
        trimmed.includes("package_id = ?") &&
        trimmed.includes("subject_id = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.packageId === params[1] &&
            r.subjectId === params[2],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("package_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.packageId === params[1],
        ) as T[];
      }
      if (params.length === 1 && trimmed.includes("package_id = ?")) {
        return mapped.filter((r) => r.packageId === params[0]) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM student_package_subscriptions")) {
      const list = this.tables.get("student_package_subscriptions") || [];
      const packages = this.tables.get("packages") || [];
      const mapped = list.map((r) => {
        const pkg = packages.find((p) => p.id === r.package_id);
        return {
          id: r.id,
          centerId: r.center_id,
          studentId: r.student_id,
          packageId: r.package_id,
          startDate: r.start_date,
          endDate: r.end_date || null,
          cancellationDate: r.cancellation_date || null,
          status: r.status,
          createdAt: r.created_at,
          updatedAt: r.updated_at || null,
          packageName: pkg ? pkg.name : "",
          packagePrice: pkg ? pkg.price : 0,
          // snake_case
          center_id: r.center_id,
          student_id: r.student_id,
          package_id: r.package_id,
          start_date: r.start_date,
          end_date: r.end_date,
          cancellation_date: r.cancellation_date,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      });
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        if (trimmed.includes("status = 'active'")) {
          return mapped.filter(
            (r) =>
              r.centerId === params[0] &&
              r.studentId === params[1] &&
              r.status === "active",
          ) as T[];
        }
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (
        params.length >= 2 &&
        (trimmed.includes("AND id = ?") || trimmed.includes("WHERE id = ?"))
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.id === params[1],
        ) as T[];
      }
      if (
        params.length >= 1 &&
        (trimmed.includes("WHERE id = ?") || trimmed.includes("AND id = ?"))
      ) {
        return mapped.filter((r) => r.id === params[params.length - 1]) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM package_subject_teacher_overrides")) {
      const list = this.tables.get("package_subject_teacher_overrides") || [];
      const teachers = this.tables.get("teachers") || [];
      const mapped = list.map((r) => {
        const t = teachers.find((tch) => tch.id === r.teacher_id);
        return {
          id: r.id,
          centerId: r.center_id,
          subscriptionId: r.subscription_id,
          subjectId: r.subject_id,
          teacherId: r.teacher_id,
          createdAt: r.created_at,
          teacherName: t ? t.name : "",
          // snake_case
          center_id: r.center_id,
          subscription_id: r.subscription_id,
          subject_id: r.subject_id,
          teacher_id: r.teacher_id,
          created_at: r.created_at,
        };
      });
      if (
        params.length >= 3 &&
        trimmed.includes("subscription_id = ?") &&
        trimmed.includes("subject_id = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.subscriptionId === params[1] &&
            r.subjectId === params[2],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("subscription_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.subscriptionId === params[1],
        ) as T[];
      }
      if (params.length === 1 && trimmed.includes("subscription_id = ?")) {
        return mapped.filter((r) => r.subscriptionId === params[0]) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM advance_coverages")) {
      const list = this.tables.get("advance_coverages") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        centerId: r.center_id,
        studentId: r.student_id,
        advanceSessionId: r.advance_session_id,
        targetFutureSessionId: r.target_future_session_id,
        createdBy: r.created_by,
        createdAt: r.created_at,
        // snake_case
        operation_id: r.operation_id,
        center_id: r.center_id,
        student_id: r.student_id,
        advance_session_id: r.advance_session_id,
        target_future_session_id: r.target_future_session_id,
        created_by: r.created_by,
        created_at: r.created_at,
      }));
      if (
        params.length >= 3 &&
        trimmed.includes("target_future_session_id = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.studentId === params[1] &&
            r.targetFutureSessionId === params[2],
        ) as T[];
      }
      if (params.length >= 3 && trimmed.includes("advance_session_id = ?")) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.studentId === params[1] &&
            r.advanceSessionId === params[2],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM notification_templates")) {
      const list = this.tables.get("notification_templates") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        eventType: r.event_type,
        channel: r.channel,
        templateBody: r.template_body,
        isDefault: r.is_default === 1 || r.is_default === true,
        createdBy: r.created_by,
        updatedBy: r.updated_by || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at || null,
        // snake_case
        center_id: r.center_id,
        event_type: r.event_type,
        channel_type: r.channel,
        template_body: r.template_body,
        is_default: r.is_default,
        created_by: r.created_by,
        updated_by: r.updated_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      if (
        params.length >= 3 &&
        trimmed.includes("event_type = ?") &&
        trimmed.includes("channel = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.eventType === params[1] &&
            r.channel === params[2],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("event_type = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.eventType === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM notification_events")) {
      const list = this.tables.get("notification_events") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        centerId: r.center_id,
        studentId: r.student_id,
        sessionId: r.session_id,
        attendanceId: r.attendance_id || null,
        eventType: r.event_type,
        templateId: r.template_id || null,
        createdBy: r.created_by,
        createdAt: r.created_at,
        // snake_case
        operation_id: r.operation_id,
        center_id: r.center_id,
        student_id: r.student_id,
        session_id: r.session_id,
        attendance_id: r.attendance_id,
        event_type: r.event_type,
        template_id: r.template_id,
        created_by: r.created_by,
        created_at: r.created_at,
      }));
      if (
        params.length >= 3 &&
        trimmed.includes("attendance_id = ?") &&
        trimmed.includes("event_type = ?")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.attendanceId === params[1] &&
            r.eventType === params[2],
        ) as T[];
      }
      if (
        params.length >= 2 &&
        trimmed.includes("center_id = ?") &&
        trimmed.includes("attendance_id = ?")
      ) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.attendanceId === params[1],
        ) as T[];
      }
      if (params.length === 1 && trimmed.includes("attendance_id = ?")) {
        return mapped.filter((r) => r.attendanceId === params[0]) as T[];
      }
      if (params.length >= 2 && trimmed.includes("operation_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.operationId === params[1],
        ) as T[];
      }
      if (params.length === 1 && trimmed.includes("WHERE operation_id = ?")) {
        return mapped.filter((r) => r.operationId === params[0]) as T[];
      }
      if (params.length >= 2 && trimmed.includes("student_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.studentId === params[1],
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("session_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.sessionId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM notification_deliveries")) {
      const list = this.tables.get("notification_deliveries") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        notificationEventId: r.notification_event_id,
        channel: r.channel,
        status: r.status,
        recipient: r.recipient,
        renderedMessage: r.rendered_message,
        sentAt: r.sent_at || null,
        failureReason: r.failure_reason || null,
        retryCount: r.retry_count || 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at || null,
        // snake_case
        center_id: r.center_id,
        notification_event_id: r.notification_event_id,
        rendered_message: r.rendered_message,
        sent_at: r.sent_at,
        failure_reason: r.failure_reason,
        retry_count: r.retry_count || 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      if (
        params.length >= 2 &&
        trimmed.includes("notification_event_id = ?") &&
        trimmed.includes("status = 'pending'")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.notificationEventId === params[1] &&
            r.status === "pending",
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("notification_event_id = ?")) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] && r.notificationEventId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM session_closing_records")) {
      const list = this.tables.get("session_closing_records") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        centerId: r.center_id,
        sessionId: r.session_id,
        action: r.action,
        reason: r.reason || null,
        performedBy: r.performed_by,
        performedAt: r.performed_at,
        previousStatus: r.previous_status,
        newStatus: r.new_status,
        totalAttendance: r.total_attendance || 0,
        totalSessionPayments: r.total_session_payments || 0,
        createdAt: r.created_at,
        // snake_case
        operation_id: r.operation_id,
        center_id: r.center_id,
        session_id: r.session_id,
        performed_by: r.performed_by,
        performed_at: r.performed_at,
        previous_status: r.previous_status,
        new_status: r.new_status,
        total_attendance: r.total_attendance || 0,
        total_session_payments: r.total_session_payments || 0,
        created_at: r.created_at,
      }));
      if (
        params.length >= 2 &&
        trimmed.includes("session_id = ?") &&
        trimmed.includes("action = 'close'")
      ) {
        return mapped.filter(
          (r) =>
            r.centerId === params[0] &&
            r.sessionId === params[1] &&
            r.action === "close",
        ) as T[];
      }
      if (params.length >= 2 && trimmed.includes("session_id = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.sessionId === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM daily_closing_summaries")) {
      const list = this.tables.get("daily_closing_summaries") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        operationId: r.operation_id,
        centerId: r.center_id,
        businessDate: r.business_date,
        status: r.status,
        closedBy: r.closed_by || null,
        closedAt: r.closed_at || null,
        reopenedBy: r.reopened_by || null,
        reopenedAt: r.reopened_at || null,
        reopenReason: r.reopen_reason || null,
        totalCash: Number(r.total_cash) || 0,
        monthlyTotal: Number(r.monthly_total) || 0,
        partialTotal: Number(r.partial_total) || 0,
        sessionTotal: Number(r.session_total) || 0,
        externalMakeupTotal: Number(r.external_makeup_total) || 0,
        packageTotal: Number(r.package_total) || 0,
        paymentCount: Number(r.payment_count) || 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at || null,
        // snake_case
        operation_id: r.operation_id,
        center_id: r.center_id,
        business_date: r.business_date,
        closed_by: r.closed_by,
        closed_at: r.closed_at,
        reopened_by: r.reopened_by,
        reopened_at: r.reopened_at,
        reopen_reason: r.reopen_reason,
        total_cash: Number(r.total_cash) || 0,
        monthly_total: Number(r.monthly_total) || 0,
        partial_total: Number(r.partial_total) || 0,
        session_total: Number(r.session_total) || 0,
        external_makeup_total: Number(r.external_makeup_total) || 0,
        package_total: Number(r.package_total) || 0,
        payment_count: Number(r.payment_count) || 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      if (params.length >= 2 && trimmed.includes("business_date = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.businessDate === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM devices")) {
      const list = this.tables.get("devices") || [];
      const mapped = list.map((r) => ({
        id: r.id,
        centerId: r.center_id,
        userId: r.user_id,
        deviceName: r.device_name,
        deviceIdentifier: r.device_identifier,
        status: r.status,
        lastSeenAt: r.last_seen_at || null,
        createdAt: r.created_at,
        // snake_case
        center_id: r.center_id,
        user_id: r.user_id,
        device_name: r.device_name,
        device_identifier: r.device_identifier,
        last_seen_at: r.last_seen_at,
        created_at: r.created_at,
      }));
      if (params.length >= 2 && trimmed.includes("device_identifier = ?")) {
        return mapped.filter(
          (r) => r.centerId === params[0] && r.deviceIdentifier === params[1],
        ) as T[];
      }
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    if (trimmed.includes("FROM sync_cursors")) {
      const list = this.tables.get("sync_cursors") || [];
      const mapped = list.map((r) => ({
        centerId: r.center_id,
        serverCursor: r.server_cursor,
        resetGeneration: r.reset_generation ?? 0,
        updatedAt: r.updated_at,
        // snake_case
        center_id: r.center_id,
        server_cursor: r.server_cursor,
        reset_generation: r.reset_generation ?? 0,
        updated_at: r.updated_at,
      }));
      if (params.length >= 1 && trimmed.includes("center_id = ?")) {
        return mapped.filter((r) => r.centerId === params[0]) as T[];
      }
      return mapped as T[];
    }

    return [] as T[];
  }

  getFirstSync<T = any>(sql: string, params: any[] = []): T | null {
    const results = this.getAllSync<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }
}

export class DatabaseService {
  private static db: SqlDatabase | null = null;
  private static transactionDepth = 0;

  static getDb(): SqlDatabase {
    if (!this.db) {
      this.init();
    }
    return this.db!;
  }

  static setMockDb(mock: SqlDatabase) {
    this.db = mock;
  }

  /** Reopens a stale native SQLite handle after an Android prepare failure. */
  static reinitialize(): void {
    const current = this.db as any;
    try {
      if (typeof current?.closeSync === "function") current.closeSync();
    } catch {}
    this.db = null;
    this.transactionDepth = 0;
    this.init();
  }

  /** Runs a synchronous SQLite transaction for snapshot/bootstrap writes. */
  static runInTransaction<T>(callback: (db: SqlDatabase) => T): T {
    const db = this.getDb();
    // Repositories can compose mutations (for example, creating a student
    // issues a card and creates enrollments). Use savepoints for nested calls
    // instead of attempting a second BEGIN, which SQLite rejects.
    if (this.transactionDepth > 0) {
      const savepoint = `sp_${this.transactionDepth}`;
      this.transactionDepth += 1;
      db.execSync(`SAVEPOINT ${savepoint};`);
      try {
        const result = callback(db);
        db.execSync(`RELEASE SAVEPOINT ${savepoint};`);
        return result;
      } catch (error) {
        try {
          db.execSync(`ROLLBACK TO SAVEPOINT ${savepoint};`);
          db.execSync(`RELEASE SAVEPOINT ${savepoint};`);
        } catch {}
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    db.execSync("BEGIN IMMEDIATE;");
    this.transactionDepth = 1;
    try {
      const result = callback(db);
      db.execSync("COMMIT;");
      return result;
    } catch (error) {
      try {
        db.execSync("ROLLBACK;");
      } catch {}
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  /** Async counterpart used by repositories that perform awaited work while
   * keeping their local mutation, audit entry, and outbox enqueue atomic. */
  static async runInTransactionAsync<T>(callback: (db: SqlDatabase) => Promise<T> | T): Promise<T> {
    const db = this.getDb();
    if (this.transactionDepth > 0) {
      const savepoint = `sp_${this.transactionDepth}`;
      this.transactionDepth += 1;
      db.execSync(`SAVEPOINT ${savepoint};`);
      try {
        const result = await callback(db);
        db.execSync(`RELEASE SAVEPOINT ${savepoint};`);
        return result;
      } catch (error) {
        try { db.execSync(`ROLLBACK TO SAVEPOINT ${savepoint};`); db.execSync(`RELEASE SAVEPOINT ${savepoint};`); } catch {}
        throw error;
      } finally { this.transactionDepth -= 1; }
    }
    db.execSync("BEGIN IMMEDIATE;");
    this.transactionDepth = 1;
    try {
      const result = await callback(db);
      db.execSync("COMMIT;");
      return result;
    } catch (error) {
      try { db.execSync("ROLLBACK;"); } catch {}
      throw error;
    } finally { this.transactionDepth = 0; }
  }

  static init(): void {
    const hasNativeSQLite = typeof SQLite?.openDatabaseSync === "function";
    try {
      if (hasNativeSQLite) {
        const nativeDb = SQLite.openDatabaseSync("fixion_local.db");
        nativeDb.execSync("PRAGMA foreign_keys = ON;");
        nativeDb.execSync("PRAGMA journal_mode = WAL;");
        this.db = nativeDb as unknown as SqlDatabase;
      } else {
        this.db = new InMemorySqliteMock();
      }

      this.runMigrations();
      this.seedData();
      this.ensureAcademicSchema();
    } catch (e: any) {
      // Falling back to an in-memory database in a real APK makes all local
      // sessions, attendance, and payments appear to vanish on the next
      // render/restart. Tests without expo-sqlite still need the mock, but a
      // native SQLite failure must remain visible instead of losing data.
      if (hasNativeSQLite) {
        console.error("Persistent SQLite initialization failed:", e?.message || e);
        throw e;
      }
      console.warn("Database initialization fallback to in-memory:", e?.message);
      this.db = new InMemorySqliteMock();
      this.runMigrations();
      this.seedData();
      this.ensureAcademicSchema();
    }
  }

  /**
   * Unconditionally guarantees all academic columns and tables exist in SQLite,
   * protecting against partial migration runs or legacy SQLite state.
   */
  static ensureAcademicSchema(): void {
    const db = this.getDb();
    const defensiveStatements = [
      // 1. Teachers
      "ALTER TABLE teachers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
      "ALTER TABLE teachers ADD COLUMN notes TEXT;",
      "ALTER TABLE teachers ADD COLUMN created_at TEXT;",
      "ALTER TABLE teachers ADD COLUMN updated_at TEXT;",
      // 2. Subjects
      "ALTER TABLE subjects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
      "ALTER TABLE subjects ADD COLUMN created_at TEXT;",
      "ALTER TABLE subjects ADD COLUMN updated_at TEXT;",
      // 3. Teacher Subjects
      `CREATE TABLE IF NOT EXISTS teacher_subjects (
        id TEXT PRIMARY KEY,
        center_id TEXT NOT NULL,
        teacher_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CONSTRAINT uq_teacher_subject UNIQUE (center_id, teacher_id, subject_id)
      );`,
      `CREATE TABLE IF NOT EXISTS center_academic_stages (
        center_id TEXT PRIMARY KEY,
        stages_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      // 4. Groups
      "ALTER TABLE groups ADD COLUMN session_price REAL NOT NULL DEFAULT 0;",
      "ALTER TABLE groups ADD COLUMN monthly_price REAL NOT NULL DEFAULT 0;",
      "ALTER TABLE groups ADD COLUMN session_duration_minutes INTEGER NOT NULL DEFAULT 120;",
      "ALTER TABLE groups ADD COLUMN late_after_minutes INTEGER NOT NULL DEFAULT 15;",
      "ALTER TABLE groups ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
      "ALTER TABLE groups ADD COLUMN created_at TEXT;",
      "ALTER TABLE groups ADD COLUMN updated_at TEXT;",
      // 5. Group Schedules
      "ALTER TABLE group_schedules ADD COLUMN center_id TEXT;",
      "ALTER TABLE group_schedules ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
      "ALTER TABLE group_schedules ADD COLUMN created_at TEXT;",
      "ALTER TABLE group_schedules ADD COLUMN updated_at TEXT;",
    ];
    for (const sql of defensiveStatements) {
      try {
        db.execSync(sql);
      } catch {
        // Safe to ignore if column/table already exists
      }
    }
  }

  /**
   * Real Migration Runner:
   * 1. Creates schema_migrations table if absent.
   * 2. Reads applied versions without touching existing data.
   * 3. Applies only unapplied migrations in ascending order.
   * 4. Updates schema_migrations and PRAGMA user_version.
   */
  static runMigrations(): void {
    const db = this.getDb();

    db.execSync(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = db.getAllSync<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    const appliedVersions = new Set(appliedRows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (!appliedVersions.has(migration.version)) {
        migration.up(db);
        db.runSync(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          [migration.version, migration.name, new Date().toISOString()],
        );
        try {
          db.execSync(`PRAGMA user_version = ${migration.version};`);
        } catch {
          // safe fallback
        }
      }
    }
  }

  static getCurrentVersion(): number {
    const db = this.getDb();
    try {
      const rows = db.getAllSync<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version DESC",
      );
      if (rows.length > 0) return rows[0].version;
    } catch {
      // fallback
    }
    return 0;
  }

  public static seedData(): void {
    const db = this.db!;
    const centers = db.getAllSync("SELECT id FROM centers");
    if (centers.length > 0) return; // already seeded

    const today = new Date().toISOString().split("T")[0];
    const todayDayOfWeek = new Date().getDay();

    // 1. Centers
    db.runSync("INSERT INTO centers (id, name, code) VALUES (?, ?, ?)", [
      "center-1",
      "مركز النور التعليمي",
      "NOOR",
    ]);
    db.runSync("INSERT INTO centers (id, name, code) VALUES (?, ?, ?)", [
      "center-2",
      "مركز الأمل التعليمي",
      "AMAL",
    ]);

    // 2. Teachers
    db.runSync(
      "INSERT INTO teachers (id, center_id, name, phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "teach-1",
        "center-1",
        "أ/ أحمد إبراهيم",
        "01011112222",
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO teachers (id, center_id, name, phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "teach-2",
        "center-1",
        "د/ محمود علي",
        "01033334444",
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO teachers (id, center_id, name, phone, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "teach-3",
        "center-2",
        "أ/ محمد حسن",
        "01055556666",
        "active",
        "2026-09-01",
      ],
    );

    // 3. Subjects
    db.runSync(
      "INSERT INTO subjects (id, center_id, name, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["subj-1", "center-1", "رياضيات", "MATH", "active", "2026-09-01"],
    );
    db.runSync(
      "INSERT INTO subjects (id, center_id, name, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["subj-2", "center-1", "فيزياء", "PHYS", "active", "2026-09-01"],
    );
    db.runSync(
      "INSERT INTO subjects (id, center_id, name, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["subj-3", "center-2", "لغة عربية", "ARAB", "active", "2026-09-01"],
    );

    // Teacher-Subjects Relationships
    db.runSync(
      "INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ["ts-1", "center-1", "teach-1", "subj-1", "2026-09-01"],
    );
    db.runSync(
      "INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ["ts-2", "center-1", "teach-2", "subj-2", "2026-09-01"],
    );
    db.runSync(
      "INSERT INTO teacher_subjects (id, center_id, teacher_id, subject_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ["ts-3", "center-2", "teach-3", "subj-3", "2026-09-01"],
    );

    // 4. Groups
    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, session_duration_minutes, late_after_minutes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "grp-1",
        "center-1",
        "رياضيات - 3 ثانوي (مجموعة أ)",
        "teach-1",
        "subj-1",
        "الصف الثالث الثانوي",
        400,
        400,
        400,
        120,
        15,
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, session_duration_minutes, late_after_minutes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "grp-2",
        "center-1",
        "فيزياء - 3 ثانوي (مجموعة ب)",
        "teach-2",
        "subj-2",
        "الصف الثالث الثانوي",
        450,
        450,
        450,
        120,
        15,
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, session_price, monthly_price, session_duration_minutes, late_after_minutes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "grp-3",
        "center-2",
        "عربي - 1 ثانوي (مجموعة 1)",
        "teach-3",
        "subj-3",
        "الصف الأول الثانوي",
        350,
        350,
        350,
        120,
        15,
        "active",
        "2026-09-01",
      ],
    );

    // Group Schedules
    db.runSync(
      "INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sched-1",
        "center-1",
        "grp-1",
        todayDayOfWeek,
        "14:00",
        "16:00",
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sched-2",
        "center-1",
        "grp-2",
        todayDayOfWeek,
        "17:00",
        "19:00",
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO group_schedules (id, center_id, group_id, day_of_week, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sched-3",
        "center-2",
        "grp-3",
        todayDayOfWeek,
        "15:00",
        "17:00",
        "active",
        "2026-09-01",
      ],
    );

    // 5. Today's Sessions (with historical snapshots)
    db.runSync(
      "INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sess-1",
        "center-1",
        "grp-1",
        "sched-1",
        "subj-1",
        "teach-1",
        400,
        15,
        today,
        "14:00",
        "16:00",
        "open",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sess-2",
        "center-1",
        "grp-2",
        "sched-2",
        "subj-2",
        "teach-2",
        450,
        15,
        today,
        "17:00",
        "19:00",
        "open",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO sessions (id, center_id, group_id, schedule_id, subject_id, teacher_id, session_price, late_after_minutes, session_date, start_time, end_time, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "sess-3",
        "center-2",
        "grp-3",
        "sched-3",
        "subj-3",
        "teach-3",
        350,
        15,
        today,
        "15:00",
        "17:00",
        "open",
        "2026-09-01",
      ],
    );

    // 6. Students (note card_code 00125 preserving leading zeros & marked temporary legacy student_code)
    db.runSync(
      `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, student_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "std-1",
        "center-1",
        "MIGRATED-LEGACY-std-1",
        "أحمد محمد محمود",
        "00125",
        "01001234567",
        "01112345678",
        "الصف الثالث الثانوي",
        "active",
        "registered",
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, student_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "std-2",
        "center-1",
        "MIGRATED-LEGACY-std-2",
        "سارة علي حسن",
        "00126",
        "01002345678",
        "01122345679",
        "الصف الثالث الثانوي",
        "active",
        "registered",
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, student_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "std-3",
        "center-1",
        "MIGRATED-LEGACY-std-3",
        "عمر خالد إبراهيم",
        "00127",
        "01003456789",
        "01132345670",
        "الصف الثالث الثانوي",
        "active",
        "registered",
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO students (id, center_id, student_code, full_name, card_code, phone, parent_phone, grade, status, student_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "std-4",
        "center-2",
        "MIGRATED-LEGACY-std-4",
        "مصطفى كمال الدين",
        "00125",
        "01004567890",
        "01142345671",
        "الصف الأول الثانوي",
        "active",
        "registered",
        "2026-09-01",
      ],
    );

    // Canonical Student Cards
    db.runSync(
      `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "card-std-1",
        "center-1",
        "std-1",
        "00125",
        "active",
        "2026-09-01",
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "card-std-2",
        "center-1",
        "std-2",
        "00126",
        "active",
        "2026-09-01",
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "card-std-3",
        "center-1",
        "std-3",
        "00127",
        "active",
        "2026-09-01",
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO student_cards (id, center_id, student_id, card_code, status, issued_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "card-std-4",
        "center-2",
        "std-4",
        "00125",
        "active",
        "2026-09-01",
        "2026-09-01",
      ],
    );

    // Student Group Enrollments
    db.runSync(
      "INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "enr-1",
        "center-1",
        "std-1",
        "grp-1",
        "2026-09-01",
        null,
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "enr-2",
        "center-1",
        "std-2",
        "grp-1",
        "2026-09-01",
        null,
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "enr-3",
        "center-1",
        "std-3",
        "grp-1",
        "2026-09-01",
        null,
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      "INSERT INTO student_group_enrollments (id, center_id, student_id, group_id, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "enr-4",
        "center-2",
        "std-4",
        "grp-3",
        "2026-09-01",
        null,
        "active",
        "2026-09-01",
      ],
    );

    // 7. Session Expected Students (Foundation for accurate expected/absent calculations)
    db.runSync(
      "INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ["exp-1", "center-1", "sess-1", "std-1", "2026-09-01"],
    );
    db.runSync(
      "INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ["exp-2", "center-1", "sess-1", "std-2", "2026-09-01"],
    );
    db.runSync(
      "INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ["exp-3", "center-1", "sess-1", "std-3", "2026-09-01"],
    );
    db.runSync(
      "INSERT INTO session_expected_students (id, center_id, session_id, student_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ["exp-4", "center-2", "sess-3", "std-4", "2026-09-01"],
    );

    // 8. Financial Subscriptions, Debt Cycles & Payments
    db.runSync(
      `INSERT INTO student_subscriptions (id, center_id, student_id, group_id, package_name, amount_due, period_start, period_end, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sub-1",
        "center-1",
        "std-1",
        "grp-1",
        "اشتراك سبتمبر - رياضيات",
        400.0,
        "2026-09-01",
        "2026-09-30",
        "active",
      ],
    );
    // Baseline debt cycle for std-1 (enr-1, grp-1)
    db.runSync(
      `INSERT INTO debt_cycles (id, center_id, student_id, enrollment_id, group_id, cycle_number, start_date, end_date, cycle_price, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "cycle-1",
        "center-1",
        "std-1",
        "enr-1",
        "grp-1",
        1,
        "2026-09-01",
        "2026-09-30",
        400.0,
        "open",
        "2026-09-01T00:00:00Z",
      ],
    );
    // Prior payment of 250 EGP, so remaining balance is 150 EGP
    db.runSync(
      `INSERT INTO payments (id, operation_id, center_id, student_id, subscription_id, debt_cycle_id, amount, payment_type, payment_date, is_reversed, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "pay-1",
        "op-pay-seed-1",
        "center-1",
        "std-1",
        "sub-1",
        "cycle-1",
        250.0,
        "partial",
        "2026-09-02",
        0,
        "2026-09-02T10:30:00Z",
        "usr-1",
      ],
    );

    // 9. Packages & Package Subjects
    db.runSync(
      `INSERT INTO packages (id, center_id, name, price, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "pkg-1",
        "center-1",
        "باقة الثانوية العامة (رياضيات + فيزياء)",
        750.0,
        "باقة مخفضة لطلاب الشعبة العلمية",
        "active",
        "2026-09-01",
      ],
    );
    db.runSync(
      `INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["ps-1", "center-1", "pkg-1", "subj-1", "teach-1", "2026-09-01"],
    );
    db.runSync(
      `INSERT INTO package_subjects (id, center_id, package_id, subject_id, default_teacher_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["ps-2", "center-1", "pkg-1", "subj-2", "teach-2", "2026-09-01"],
    );
  }
}

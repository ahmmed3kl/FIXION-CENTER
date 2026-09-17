-- ==============================================================================
-- FIXION CENTER MANAGEMENT PLATFORM
-- PRODUCTION POSTGRESQL SCHEMA FOR NEON (neon.tech)
-- Matching Sprints 1-6 + UX & Architecture Standards
-- ==============================================================================

BEGIN;

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 2. CORE TENANCY & IDENTITY
-- ------------------------------------------------------------------------------

-- Centers
CREATE TABLE IF NOT EXISTS centers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(64) NOT NULL UNIQUE,
    phone VARCHAR(32),
    address TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Monotonic operational-data generation. Clients clear local operational
-- SQLite data when this value changes after a center reset.
CREATE TABLE IF NOT EXISTS center_data_state (
    center_id VARCHAR(64) PRIMARY KEY,
    reset_generation BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(32) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'secretary', 'accountant', 'assistant')),
    permissions JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phone numbers are shared contact details, not identities. Keep login lookup
-- indexed by the database if desired, but never enforce uniqueness on it.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key;

-- Platform administrators are a separate security scope from center users.
-- No center_id is stored because platform access is not tenant-scoped.
CREATE TABLE IF NOT EXISTS platform_admins (
    id VARCHAR(64) PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_admins_email_lower ON platform_admins(LOWER(email));

-- Multi-Center Access for Users
CREATE TABLE IF NOT EXISTS user_centers (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_center UNIQUE (user_id, center_id)
);

-- Registered Devices (Tablets, Phones)
CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    device_name VARCHAR(255),
    platform VARCHAR(32),
    app_version VARCHAR(32),
    device_token TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'pending')),
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 3. ACADEMIC STRUCTURE (Teachers, Subjects, Groups, Schedules)
-- ------------------------------------------------------------------------------

-- Teachers
CREATE TABLE IF NOT EXISTS teachers (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subjects
CREATE TABLE IF NOT EXISTS subjects (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_subject_code UNIQUE (center_id, code)
);

-- Teacher-Subject Assignments
CREATE TABLE IF NOT EXISTS teacher_subjects (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    teacher_id VARCHAR(64) NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_teacher_subject UNIQUE (center_id, teacher_id, subject_id)
);

-- Groups
CREATE TABLE IF NOT EXISTS groups (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    teacher_id VARCHAR(64) NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    grade VARCHAR(64) NOT NULL,
    default_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (default_fee >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Group Schedules
CREATE TABLE IF NOT EXISTS group_schedules (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    group_id VARCHAR(64) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time VARCHAR(16) NOT NULL,
    end_time VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 4. STUDENTS & PHYSICAL CARDS
-- ------------------------------------------------------------------------------

-- Students (Canonical identity, completely decoupled from physical plastic cards)
CREATE TABLE IF NOT EXISTS students (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_code VARCHAR(64) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    card_code VARCHAR(64) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    parent_phone VARCHAR(32) NOT NULL,
    grade VARCHAR(64) NOT NULL,
    student_type VARCHAR(32) NOT NULL DEFAULT 'registered' CHECK (student_type IN ('registered', 'guest', 'scholarship')),
    notes TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_student_code UNIQUE (center_id, student_code)
);

-- Physical Cards Lifecycle (tracks issuance, replacement, lost cards)
CREATE TABLE IF NOT EXISTS student_cards (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    card_code VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'lost')),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deactivated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_card_code UNIQUE (center_id, card_code)
);

-- Student Group Enrollments
CREATE TABLE IF NOT EXISTS student_group_enrollments (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    group_id VARCHAR(64) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    price_override NUMERIC(12, 2) CHECK (price_override IS NULL OR price_override >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'transferred', 'withdrawn', 'completed')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_student_enrollment UNIQUE (center_id, student_id, group_id)
);

-- ------------------------------------------------------------------------------
-- 5. SESSIONS & IDEMPOTENT ATTENDANCE
-- ------------------------------------------------------------------------------

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    group_id VARCHAR(64) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    session_date DATE NOT NULL,
    start_time VARCHAR(16) NOT NULL,
    end_time VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (status IN ('scheduled', 'open', 'closed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session Expected Students (Manifest snapshot)
CREATE TABLE IF NOT EXISTS session_expected_students (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    CONSTRAINT uq_session_expected UNIQUE (session_id, student_id)
);

-- Attendance (Strictly unique per session + student to prevent duplicate check-ins)
CREATE TABLE IF NOT EXISTS attendance (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    check_in_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(32) NOT NULL CHECK (status IN ('present', 'absent', 'excused', 'attended_elsewhere')),
    is_late BOOLEAN NOT NULL DEFAULT FALSE,
    attendance_type VARCHAR(32) NOT NULL DEFAULT 'present' CHECK (attendance_type IN ('present', 'advance', 'makeup')),
    original_absence_id VARCHAR(64),
    operation_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_session_attendance UNIQUE (session_id, student_id)
);

-- ------------------------------------------------------------------------------
-- 6. EVENT-ORIENTED FINANCIAL SYSTEM (Immutable Ledger, No Stored Balances)
-- ------------------------------------------------------------------------------

-- Debt Cycles (Payable obligations)
CREATE TABLE IF NOT EXISTS debt_cycles (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    enrollment_id VARCHAR(64) REFERENCES student_group_enrollments(id) ON DELETE SET NULL,
    package_subscription_id VARCHAR(64),
    cycle_type VARCHAR(32) NOT NULL CHECK (cycle_type IN ('monthly', 'per_session', 'package')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    amount_due NUMERIC(12, 2) NOT NULL CHECK (amount_due >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partially_paid', 'paid', 'cancelled', 'waived')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payments (Immutable cash-flow events)
CREATE TABLE IF NOT EXISTS payments (
    id VARCHAR(64) PRIMARY KEY,
    operation_id VARCHAR(64) NOT NULL UNIQUE,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    debt_cycle_id VARCHAR(64) REFERENCES debt_cycles(id) ON DELETE SET NULL,
    session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE SET NULL,
    subscription_id VARCHAR(64),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(32) NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'vodafone_cash', 'bank_transfer', 'other')),
    is_reversed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- Payment Reversals (Audited refunds / cancellations)
CREATE TABLE IF NOT EXISTS payment_reversals (
    id VARCHAR(64) PRIMARY KEY,
    operation_id VARCHAR(64) NOT NULL UNIQUE,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    payment_id VARCHAR(64) NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    reversed_amount NUMERIC(12, 2) NOT NULL CHECK (reversed_amount > 0),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- Debt Adjustments (Approved discounts, waivers, penalties)
CREATE TABLE IF NOT EXISTS debt_adjustments (
    id VARCHAR(64) PRIMARY KEY,
    operation_id VARCHAR(64) NOT NULL UNIQUE,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    debt_cycle_id VARCHAR(64) NOT NULL REFERENCES debt_cycles(id) ON DELETE CASCADE,
    adjustment_type VARCHAR(32) NOT NULL CHECK (adjustment_type IN ('discount', 'waiver', 'penalty', 'correction')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT
);

-- ------------------------------------------------------------------------------
-- 7. ADVANCED PACKAGES & COVERAGES (Sprint 4)
-- ------------------------------------------------------------------------------

-- Packages
CREATE TABLE IF NOT EXISTS packages (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    grade VARCHAR(64) NOT NULL,
    total_price NUMERIC(12, 2) NOT NULL CHECK (total_price >= 0),
    max_selections INTEGER NOT NULL DEFAULT 1 CHECK (max_selections > 0),
    billing_cycle VARCHAR(32) NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'term', 'annual')),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE packages ADD COLUMN IF NOT EXISTS max_selections INTEGER NOT NULL DEFAULT 1;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS grade VARCHAR(64) NOT NULL DEFAULT 'all';
ALTER TABLE packages ADD COLUMN IF NOT EXISTS total_price NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(32) NOT NULL DEFAULT 'monthly';
ALTER TABLE packages ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active';
ALTER TABLE packages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE packages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
DO $$ BEGIN
  ALTER TABLE packages ADD CONSTRAINT packages_max_selections_positive CHECK (max_selections > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Package Subjects
CREATE TABLE IF NOT EXISTS package_subjects (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    package_id VARCHAR(64) NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    default_teacher_id VARCHAR(64) REFERENCES teachers(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_pkg_subject UNIQUE (center_id, package_id, subject_id)
);

-- Student Package Subscriptions
CREATE TABLE IF NOT EXISTS student_package_subscriptions (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    package_id VARCHAR(64) NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
    price_override NUMERIC(12, 2) CHECK (price_override IS NULL OR price_override >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
    start_date DATE NOT NULL,
    end_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Package Subject Teacher Overrides
CREATE TABLE IF NOT EXISTS package_subject_teacher_overrides (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    subscription_id VARCHAR(64) NOT NULL REFERENCES student_package_subscriptions(id) ON DELETE CASCADE,
    subject_id VARCHAR(64) NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    teacher_id VARCHAR(64) NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_pkg_override UNIQUE (subscription_id, subject_id)
);

-- Advance Coverages (Handling students attending another session in advance)
CREATE TABLE IF NOT EXISTS advance_coverages (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    advance_session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    target_future_session_id VARCHAR(64) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_advance_coverage UNIQUE (student_id, target_future_session_id)
);

-- ------------------------------------------------------------------------------
-- 8. NOTIFICATIONS & CLOSINGS (Sprint 5)
-- ------------------------------------------------------------------------------

-- Notification Templates (center-scoped, editable message definitions)
CREATE TABLE IF NOT EXISTS notification_templates (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    channel VARCHAR(32) NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'push')),
    template_body TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    updated_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    CONSTRAINT uq_notification_template UNIQUE (center_id, event_type, channel, is_default)
);

-- Notification Events (Decoupled from core attendance speed)
CREATE TABLE IF NOT EXISTS notification_events (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    student_id VARCHAR(64) NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    session_id VARCHAR(64) REFERENCES sessions(id) ON DELETE SET NULL,
    event_type VARCHAR(64) NOT NULL,
    recipient_phone VARCHAR(32) NOT NULL,
    channel VARCHAR(32) NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms', 'push')),
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'delivered')),
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ
);

-- Notification Deliveries (Provider retry attempts)
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    notification_event_id VARCHAR(64) NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    provider VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'delivered')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    response_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session Closing Records
CREATE TABLE IF NOT EXISTS session_closing_records (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    session_id VARCHAR(64) NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    closed_by VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    total_expected INTEGER NOT NULL DEFAULT 0,
    total_present INTEGER NOT NULL DEFAULT 0,
    total_absent INTEGER NOT NULL DEFAULT 0,
    total_collected NUMERIC(12, 2) NOT NULL DEFAULT 0,
    discrepancy_notes TEXT,
    closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Daily Closing Summaries
CREATE TABLE IF NOT EXISTS daily_closing_summaries (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    business_date DATE NOT NULL,
    closed_by VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    total_sessions INTEGER NOT NULL DEFAULT 0,
    total_attendees INTEGER NOT NULL DEFAULT 0,
    total_revenue NUMERIC(12, 2) NOT NULL DEFAULT 0,
    cash_in_drawer NUMERIC(12, 2) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'reopened', 'approved')),
    notes TEXT,
    closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_business_date UNIQUE (center_id, business_date)
);

-- ------------------------------------------------------------------------------
-- 9. AUDIT TRAILS & SYNC INGESTION (Sprint 1 & Sprint 6)
-- ------------------------------------------------------------------------------

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    operation_id VARCHAR(64) NOT NULL,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    device_id VARCHAR(64) REFERENCES devices(id) ON DELETE SET NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB
);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type VARCHAR(32);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_id VARCHAR(64);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_state JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_state JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata JSONB;
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_logs(actor_type, actor_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_logs(action, timestamp DESC);

-- Ingested Sync Operations (Monotonic server ledger for offline-first clients)
CREATE TABLE IF NOT EXISTS server_sync_operations (
    server_seq BIGSERIAL PRIMARY KEY,
    operation_id VARCHAR(64) NOT NULL UNIQUE,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    device_id VARCHAR(64) REFERENCES devices(id) ON DELETE SET NULL,
    operation_type VARCHAR(64) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'rejected', 'conflict')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sync Device Checkpoints (Tracking client cursors)
CREATE TABLE IF NOT EXISTS sync_checkpoints (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    last_pulled_seq BIGINT NOT NULL DEFAULT 0,
    last_pushed_operation_id VARCHAR(64),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_device_checkpoint UNIQUE (center_id, device_id)
);

-- ------------------------------------------------------------------------------
-- 10. HIGH PERFORMANCE ENTERPRISE INDEXES
-- ------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_users_center ON users(center_id, role);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_admin_per_center ON users(center_id) WHERE role = 'admin' AND status = 'active';

-- Optional per-center service overrides. Missing rows preserve legacy behavior (enabled).
CREATE TABLE IF NOT EXISTS center_services (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    service_key VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_center_service UNIQUE (center_id, service_key)
);

-- Centrally controlled fixed-length decimal card ownership ranges.
CREATE TABLE IF NOT EXISTS card_ranges (
    id VARCHAR(64) PRIMARY KEY,
    center_id VARCHAR(64) NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
    start_code VARCHAR(64) NOT NULL,
    end_code VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_card_range_identity UNIQUE (center_id, start_code, end_code),
    CONSTRAINT chk_card_range_digits CHECK (start_code ~ '^[0-9]+$' AND end_code ~ '^[0-9]+$'),
    CONSTRAINT chk_card_range_same_length CHECK (length(start_code) = length(end_code)),
    CONSTRAINT chk_card_range_order CHECK (start_code <= end_code)
);
CREATE INDEX IF NOT EXISTS idx_card_ranges_codes ON card_ranges(start_code, end_code, status);
CREATE INDEX IF NOT EXISTS idx_center_services_center ON center_services(center_id, service_key);
CREATE INDEX IF NOT EXISTS idx_devices_center ON devices(center_id, status);
CREATE INDEX IF NOT EXISTS idx_students_center_code ON students(center_id, student_code);
CREATE INDEX IF NOT EXISTS idx_students_center_name ON students(center_id, full_name);
CREATE INDEX IF NOT EXISTS idx_student_cards_center_code ON student_cards(center_id, card_code);
CREATE INDEX IF NOT EXISTS idx_student_cards_student ON student_cards(student_id, status);
CREATE INDEX IF NOT EXISTS idx_teacher_subjects ON teacher_subjects(center_id, teacher_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_groups_subject ON groups(center_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_groups_teacher ON groups(center_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_group_schedules ON group_schedules(center_id, group_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON student_group_enrollments(center_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollments_group ON student_group_enrollments(center_id, group_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_group_date ON sessions(center_id, group_id, session_date);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(center_id, student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(center_id, session_id);
CREATE INDEX IF NOT EXISTS idx_debt_cycles_student ON debt_cycles(center_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_debt_cycles_enrollment ON debt_cycles(center_id, enrollment_id);
CREATE INDEX IF NOT EXISTS idx_payments_cycle ON payments(center_id, debt_cycle_id);
CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(center_id, session_id);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(center_id, student_id);
CREATE INDEX IF NOT EXISTS idx_reversals_payment ON payment_reversals(center_id, payment_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_cycle ON debt_adjustments(center_id, debt_cycle_id);
CREATE INDEX IF NOT EXISTS idx_packages_center ON packages(center_id, status);
CREATE INDEX IF NOT EXISTS idx_pkg_subj_pkg ON package_subjects(center_id, package_id);
CREATE INDEX IF NOT EXISTS idx_pkg_subs_student ON student_package_subscriptions(center_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_notif_events_student ON notification_events(center_id, student_id);
CREATE INDEX IF NOT EXISTS idx_notif_events_session ON notification_events(center_id, session_id);
CREATE INDEX IF NOT EXISTS idx_notif_deliveries_status ON notification_deliveries(center_id, status);
CREATE INDEX IF NOT EXISTS idx_session_closing_session ON session_closing_records(center_id, session_id);
CREATE INDEX IF NOT EXISTS idx_daily_closing_date ON daily_closing_summaries(center_id, business_date);
CREATE INDEX IF NOT EXISTS idx_server_sync_seq ON server_sync_operations(center_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_audit_center_time ON audit_logs(center_id, timestamp DESC);

-- ------------------------------------------------------------------------------
-- 11. INITIAL SEED DATA (For Immediate Testing on Neon)
-- ------------------------------------------------------------------------------

-- Seed Demo Centers
INSERT INTO centers (id, name, code, phone, address, status)
VALUES 
  ('center-1', 'سنتر النخبة التعليمي - الفرع الرئيسي', 'ELITE-01', '01000000000', 'القاهرة - مدينة نصر', 'active'),
  ('center-2', 'سنتر التفوق - فرع الدقي', 'TAFAWOQ-02', '01100000000', 'الجيزة - الدقي', 'active')
ON CONFLICT (id) DO NOTHING;

-- Seed Demo Users (Password: 123456 -> BCrypt / SHA256 hashed placeholder)
INSERT INTO users (id, center_id, full_name, email, phone, password_hash, role, permissions, status)
VALUES 
  ('usr-admin-1', 'center-1', 'أحمد الإدريسي (المدير)', 'admin@center1.com', '01000000001', crypt('123456', gen_salt('bf')), 'admin', '{"can_manage_students": true, "can_manage_financials": true, "can_mark_attendance": true, "can_close_session": true, "can_manage_settings": true}'::jsonb, 'active'),
  ('usr-sec-1', 'center-1', 'سارة يوسف (السكرتارية)', 'secretary@center1.com', '01000000002', crypt('123456', gen_salt('bf')), 'secretary', '{"can_manage_students": true, "can_mark_attendance": true, "can_collect_payment": true, "can_close_session": false}'::jsonb, 'active'),
  ('usr-acc-1', 'center-1', 'خالد ممدوح (المحاسب)', 'accountant@center1.com', '01000000003', crypt('123456', gen_salt('bf')), 'accountant', '{"can_manage_financials": true, "can_collect_payment": true, "can_view_reports": true, "can_close_session": true}'::jsonb, 'active'),
  ('usr-admin-2', 'center-2', 'عمرو سالم (مدير فرع 2)', 'admin@center2.com', '01000000004', crypt('123456', gen_salt('bf')), 'admin', '{"can_manage_students": true, "can_manage_financials": true, "can_mark_attendance": true, "can_close_session": true, "can_manage_settings": true}'::jsonb, 'active')
ON CONFLICT (id) DO NOTHING;

-- Link users to centers
INSERT INTO user_centers (id, user_id, center_id, role, is_primary)
VALUES
  ('uc-1', 'usr-admin-1', 'center-1', 'admin', true),
  ('uc-2', 'usr-admin-1', 'center-2', 'admin', false),
  ('uc-3', 'usr-sec-1', 'center-1', 'secretary', true),
  ('uc-4', 'usr-acc-1', 'center-1', 'accountant', true),
  ('uc-5', 'usr-admin-2', 'center-2', 'admin', true)
ON CONFLICT (id) DO NOTHING;

-- Seed Academic Basics for Center 1
INSERT INTO teachers (id, center_id, name, phone, status)
VALUES
  ('tch-1', 'center-1', 'أ. محمد عبد العزيز (فيزياء)', '01200000001', 'active'),
  ('tch-2', 'center-1', 'د. إبراهيم كمال (كيمياء)', '01200000002', 'active'),
  ('tch-3', 'center-1', 'أ. طارق الشهاوي (رياضيات)', '01200000003', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO subjects (id, center_id, name, code, status)
VALUES
  ('subj-1', 'center-1', 'فيزياء', 'PHYS', 'active'),
  ('subj-2', 'center-1', 'كيمياء', 'CHEM', 'active'),
  ('subj-3', 'center-1', 'رياضيات بحتة', 'MATH', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO groups (id, center_id, name, teacher_id, subject_id, grade, default_fee, status)
VALUES
  ('grp-1', 'center-1', 'مجموعة العباقرة - السبت والثلاثاء', 'tch-1', 'subj-1', 'الصف الثالث الثانوي', 250.00, 'active'),
  ('grp-2', 'center-1', 'مجموعة الكيمياء المتقدمة - الأحد والأربعاء', 'tch-2', 'subj-2', 'الصف الثالث الثانوي', 220.00, 'active'),
  ('grp-3', 'center-1', 'مجموعة التفوق في الرياضيات - الإثنين والخميس', 'tch-3', 'subj-3', 'الصف الثاني الثانوي', 200.00, 'active')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS grade_exams (
  id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL,
  name TEXT NOT NULL,
  grade VARCHAR(128) NOT NULL,
  max_score NUMERIC(10,2) NOT NULL DEFAULT 100,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS grade_scores (
  id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL,
  exam_id TEXT NOT NULL REFERENCES grade_exams(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  score NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  CONSTRAINT uq_grade_score UNIQUE (center_id, exam_id, student_id)
);

COMMIT;


# FIXION — Final Sync Validation Report

**Date:** 2026-10-06  
**Scope:** Validation only — no production code changes made during this review.  
**Target scenario:** One center, 4 active mobile devices, approximately 1,000 students, local SQLite on each device, shared Backend + Neon PostgreSQL.

---

## Executive Verdict

**The sync architecture has a solid foundation, but it is NOT production-ready in its current repository state.**

Do not proceed to Phase 2 performance work or release the mobile app until the three production blockers below are fixed and validated with a real multi-device integration test.

### Production blockers

1. **Client compilation is broken** in `src/core/api/SyncApiAdapter.ts`.
   - The class contains a duplicated `bootstrapCenter` block.
   - `Logger` is used without an import.
   - Removed constant `SYNC_REQUEST_TIMEOUT_MS` is still referenced.
   - Focused sync tests and `tsc --noEmit` cannot run.

2. **SQLite migration versions collide** in `src/core/database/index.ts`.
   - `add_sync_metadata_table` uses migration version `7`.
   - `sync_retry_and_conflict_review` was shifted to version `8`.
   - `package_selection_limits` is still version `8`.
   - The migration runner treats version as a unique primary key, so only the first migration with a duplicate version is applied. New devices can skip required migrations.

3. **The local pull cursor can skip another device's change after Push.**
   - The client writes `pushResponse.serverCursor` into its local cursor after Push.
   - A Push cursor is not proof that all changes up to that sequence were pulled and applied locally.
   - With concurrent devices, this can cause one device to skip a change from another device permanently.

---

## A. Is the current Sync safe for 4 devices and 1,000 students?

**No, not yet.**

The intended design is appropriate for the scenario:

- Every device writes locally first to SQLite.
- Local mutations are persisted to `sync_operations` outbox.
- Server-side operations use unique `operation_id` values.
- Server change stream uses monotonic `server_seq`.
- Pull applies changes locally before advancing its cursor.
- Attendance has a unique `(session_id, student_id)` rule.
- Parent-child dependency ordering exists for related operations such as session → attendance and debt cycle → payment.
- Server Push processing uses an ACID transaction and savepoints per operation.

However, the current build failure, migration collision, and cursor-after-Push issue make it unsafe to approve for four concurrent devices.

---

## B. Is there a data-loss scenario?

**Yes — there is a client-side data visibility loss scenario caused by cursor advancement after Push.**

### Scenario

1. Device B pushes a successful operation and receives server sequence `101`.
2. Device A started its own Push while its local pull cursor was `100`.
3. Device A completes Push and the server returns cursor `102`.
4. Device A stores `102` as its local pull cursor without pulling sequence `101`.
5. Device A next pulls changes after `102`.
6. Device B's sequence `101` is permanently skipped on Device A.

### Result

- The server still retains the operation.
- Device A may never receive Device B's change.
- This is data loss from the perspective of Device A's local SQLite/UI.

### Required rule

**A local cursor must advance only after a successful Pull applies the corresponding server changes locally.**

A Push response may confirm a local operation was accepted, but it must not be used as proof that all server-stream changes below that cursor exist locally.

---

## C. Is there a duplicate scenario?

### Same `operation_id`

**Protected correctly.**

- Local outbox prevents duplicate insertion for the same operation ID.
- `server_sync_operations.operation_id` is unique.
- The backend treats a resent operation with the same operation ID as success for the same center.
- Existing backend integration coverage checks that resending an identical operation leaves exactly one ledger row.

### Same business event from two devices

**Mostly protected.**

For attendance:

```sql
UNIQUE (session_id, student_id)
```

If two devices scan the same student for the same session:

- The first attendance write wins.
- The second distinct operation does not create a second attendance row.
- The second operation is surfaced as `ATTENDANCE_ALREADY_RECORDED` conflict.

This is the desired result: no duplicate attendance and clear operator visibility.

---

## D. Is conflict handling correct?

**Partially correct.**

### What works

- Updates carrying `updatedAt` / `updated_at` are checked against the current server `updated_at`.
- A stale update becomes `STALE_UPDATE` rather than overwriting a newer server update.
- Conflicts are persisted locally in `sync_conflicts`.
- Server state is read where possible for review.
- Parent-missing errors such as a payment arriving before its debt cycle are retried rather than immediately becoming permanent conflicts.
- Duplicate attendance from separate devices is prevented and surfaced as a conflict.

### Gaps

1. Optimistic concurrency only works when the payload includes `updatedAt` / `updated_at`.
2. Several UPSERT paths can behave as “last write to reach the server wins” when the client does not send a timestamp.
3. There is no proven end-user conflict-resolution workflow for choosing local/server values or resubmitting corrected data.
4. Existing tests use a mock conflict path; they do not validate four independent device databases against the real backend.

### Verdict

Conflict protection exists and is useful, but it needs real multi-device validation before production approval.

---

## E. Is 24-hour Bootstrap caching safe?

**The principle is correct. The current implementation cannot be approved yet.**

The correct separation is:

- **Full Bootstrap:** expensive authoritative snapshot for first use, cursor reset, empty/inconsistent local data, or scheduled recovery.
- **Incremental Pull:** frequent cursor-based stream consumption for changes from other devices.

The application already intends to run incremental Sync through:

- network recovery,
- app foregrounding,
- a 30-second foreground interval,
- a deferred Expo background task.

Therefore, if Device A changes data after Device B's last bootstrap, Device B should receive that change through incremental Pull, not wait 24 hours.

However, this depends on preserving a correct local cursor. The current cursor-after-Push problem breaks that guarantee.

### Verdict

- 24-hour Full Bootstrap cache: **conceptually safe**.
- Incremental Pull design: **correct conceptually**.
- Current implementation: **not safe until cursor-after-Push is fixed and tested**.

---

## F. Is the 500-change Pull limit safe?

**It is safe against UI blocking, but not sufficient for guaranteed prompt catch-up.**

Current limits:

- Pull batch size: 50 changes.
- Maximum batches per Sync: 10.
- Maximum per attempt: 500 changes.
- Maximum pull duration: 30 seconds.

### Positive behavior

- Each Pull batch is applied before the local cursor moves forward.
- A device that applies 500 changes does not lose those changes.
- It avoids consuming a very large backlog in one long foreground operation.

### Risk

When `hasMore` remains true after 500 changes, the code only logs that Pull is paused. It does not explicitly schedule an immediate continuation until caught up.

Catch-up relies on a future trigger:

- 30-second foreground interval,
- app resume,
- connectivity transition,
- or Expo BackgroundTask.

Expo BackgroundTask is deferred by the operating system. On Android it has a minimum 15-minute scheduling interval and is not immediate. On iOS execution timing is controlled by the OS and is also not immediate.

### Verdict

- No cursor advancement before apply: **safe**.
- No loss of the first 500 changes: **safe**.
- Guaranteed quick completion for a backlog above 500: **not guaranteed**.

Before production, add explicit continuation behavior until `hasMore === false`, while preserving a time/yield budget for UI responsiveness.

---

## G. Is the current server sufficient?

### Capacity estimate

| Deployment scale | Practical assessment |
|---|---|
| 1 center / 4 devices / 1,000 students | Suitable after blockers are fixed and verified. |
| 10 centers / about 40 devices | Likely workable with monitoring and realistic benchmark data. |
| 50 centers / about 200 devices | Requires load testing, connection-pool monitoring, and bootstrap-size measurement. |
| 100 centers / about 400 devices | Not approved without capacity tests, metrics, and scaling plan. |

### Why student count alone is not the main metric

Capacity is driven primarily by:

- concurrent active devices,
- attendance bursts at session start times,
- Push/Pull request rate,
- offline backlog replay,
- historical attendance/payment volume included in Bootstrap,
- Full Bootstrap payload size.

### Current positives

- PostgreSQL pool is limited to 10 connections.
- Pull stream has an index on `(center_id, server_seq)`.
- Push processing uses database transactions and savepoints.
- Bootstrap uses a repeatable-read snapshot.

### Current bottleneck

Bootstrap performs `SELECT *` across many center tables, including historical attendance and payments. As history grows, bootstrap payload size and query cost are more important than the base 1,000-student count.

---

## H. Is there a Neon problem?

**No Neon-specific defect was proven.**

Observed validation result:

- Backend syntax checks passed for `server.js`, `routes/sync.js`, and `services/SyncProcessor.js`.
- The backend integration suite reached the live health endpoint successfully.
- The suite then failed because expected test login credentials returned `401`.

This means the integration test seed assumptions do not match the current Neon data. It does not prove a Neon database failure.

### Neon notes

- Neon is appropriate in principle for the initial target size.
- A PostgreSQL warning appeared about future `sslmode=require` behavior in newer `pg` versions. This is maintenance work, not a current sync blocker.
- Live capacity must be validated with the actual Neon plan, actual region latency, and benchmark workload.

---

## I. Mandatory fixes before Production

### P0 — Must fix before any release

1. **Repair `src/core/api/SyncApiAdapter.ts`.**
   - Remove duplicate `bootstrapCenter` implementation.
   - Import `Logger` if it is used.
   - Remove all references to deleted `SYNC_REQUEST_TIMEOUT_MS`.
   - Make TypeScript compilation and all sync tests pass.

2. **Repair migration numbering in `src/core/database/index.ts`.**
   - Migration versions must be unique and immutable.
   - Correct all shifted collisions, not only the first duplicate.
   - Test both a new database and an existing database whose old versions are already recorded.

3. **Do not update local Pull cursor from Push response.**
   - Local `server_cursor` must represent server changes actually applied to local SQLite.
   - Advance it only after `applyServerChanges` succeeds for Pull data.

4. **Create a real four-device integration test.**
   Use four independent SQLite/outbox instances connected to the same test backend/database and test:
   - concurrent Push operations,
   - response loss after server commit followed by retry,
   - one device Pulling another device's changes,
   - duplicate attendance scan,
   - concurrent student/group updates,
   - 501+ stream operations,
   - reconnect after offline work,
   - cursor correctness under overlapping Push/Pull.

5. **Make backend integration test data deterministic.**
   - Provision a dedicated test center/users/devices.
   - Seed and clean test data independently.
   - Do not depend on mutable production-like login credentials.

### P1 — Strongly recommended before operational rollout

6. Explicitly continue Pull while backlog remains, rather than waiting for another opportunistic trigger.
7. Add production metrics: cursor lag, outbox pending/failed/conflict counts, Pull duration, Push duration, Bootstrap duration, payload bytes, and operation throughput.
8. Measure Full Bootstrap against a realistic center history, not only 1,000 current students.
9. Verify failure between server commit and client response; idempotent retry must produce one domain event and one ledger record.

---

## J. Items that can move to Phase 2 / Phase 3

These are valuable but not launch blockers once the P0 requirements above are complete:

- Replace Bootstrap `SELECT *` queries with explicit column lists.
- HTTP response compression for Bootstrap.
- Sync progress UI.
- Sync analytics dashboard.
- End-user manual retry/conflict-resolution UI.
- Delta Bootstrap optimization.
- Client payload compression.
- More detailed log/formatting cleanup.

---

## Validation Results

### Executed checks

| Check | Result |
|---|---|
| TypeScript validation (`tsc --noEmit`) | Failed due to `SyncApiAdapter.ts` syntax/type errors. |
| Focused mobile sync test (`sprint6`) | Could not run because TypeScript compilation fails in `SyncApiAdapter.ts`. |
| Focused local-first/attendance test (`sprint1`) | Could not run because TypeScript compilation fails in `SyncApiAdapter.ts`. |
| Focused resilience test (`security_audit`) | Could not run because TypeScript compilation fails in `SyncApiAdapter.ts`. |
| Backend JS syntax checks | Passed for backend server, sync route, and SyncProcessor. |
| Backend live integration test | Health passed; login failed with `401` due to test fixture/credential mismatch. |
| Four-device end-to-end test | Not present; not executable until the P0 client errors are repaired. |
| Performance benchmark | Not valid to execute until build/test blockers are repaired. |

### Important correction

Previous percentage claims such as “70% faster startup” or “50% fewer operations” are not validated measurements. They must not be used as performance facts until benchmarked with the real target dataset and devices.

---

## Final Answer Summary

| Requested question | Answer |
|---|---|
| A. Safe for 4 devices / 1,000 students? | No — architecture is promising, current build/cursor/migration state is not production-safe. |
| B. Data loss scenario? | Yes — cursor can skip another device's change after Push. |
| C. Duplicate scenario? | Same operation ID is protected; duplicate attendance is prevented and conflicted. |
| D. Conflict handling correct? | Partially; stale timestamps are protected, but real multi-device coverage and user resolution are incomplete. |
| E. Bootstrap cache safe? | Conceptually yes only with correct incremental cursor handling; current implementation is not approved. |
| F. 500-change limit safe? | Safe for applied batches, but guaranteed prompt catch-up is missing. |
| G. Server sufficient? | Yes for 1 center / 4 devices after P0 fixes; larger scales need real load tests. |
| H. Neon problem? | No Neon defect proven; backend test data is currently invalid/out of sync. |
| I. Required before Production? | Repair adapter, migrations, cursor semantics, deterministic tests, and four-device integration coverage. |
| J. Phase 2/3 deferrals? | Compression, query slimming, dashboards, progress UI, delta bootstrap, and advanced operations UX. |

---

## Recommended release gate

Do not release until all conditions are true:

- [ ] `npm exec tsc -- --noEmit --pretty false` passes.
- [ ] Focused sync, local-first, and resilience tests pass.
- [ ] Backend integration suite uses deterministic test credentials/data and passes.
- [ ] A real four-device test passes.
- [ ] A concurrent Push/Pull cursor test proves no cross-device changes are skipped.
- [ ] A >500 change backlog test proves automatic complete catch-up.
- [ ] A 1,000-student benchmark records real startup, bootstrap, Push, Pull, payload, memory, and API-request measurements.

---

*This report is a validation-only artifact. No code modifications were made as part of this validation.*

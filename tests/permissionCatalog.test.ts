import { RolePermissions } from "../src/core/permissions";
import {
  editablePermissions,
  keepManagerGrantablePermissions,
  permissionGroups,
  sensitivePermissions,
  updateGroupPermissions,
  updateIndividualPermission,
} from "../src/features/accounts/permissionCatalog";

describe("account permission catalog", () => {
  it("groups every editable permission exactly once and provides Arabic names and effects", () => {
    const entries = permissionGroups.flatMap((group) => group.permissions);
    const keys = entries.map((entry) => entry.key);

    expect([...keys].sort()).toEqual([...editablePermissions].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(editablePermissions).toEqual(RolePermissions.admin);
    entries.forEach((entry) => {
      expect(entry.name.trim()).not.toBe("");
      expect(entry.effect.trim()).not.toBe("");
      expect(/[\u0600-\u06FF]/.test(entry.name)).toBe(true);
      expect(/[\u0600-\u06FF]/.test(entry.effect)).toBe(true);
    });
  });

  it("bulk updates only its own manageable non-sensitive keys", () => {
    const selected = ["students.view", "groups.view", "payments.reverse"] as const;
    const updated = updateGroupPermissions(
      selected,
      ["students.view", "students.create", "users.manage"],
      true,
      ["students.view", "students.create", "users.manage"],
    );

    expect(updated).toContain("students.view");
    expect(updated).toContain("students.create");
    expect(updated).toContain("groups.view");
    expect(updated).toContain("payments.reverse");
    expect(updated).not.toContain("users.manage");

    const revoked = updateGroupPermissions(
      updated,
      ["students.view", "students.create", "users.manage"],
      false,
      ["students.view", "students.create", "users.manage"],
    );
    expect(revoked).not.toContain("students.view");
    expect(revoked).not.toContain("students.create");
    expect(revoked).toContain("groups.view");
    expect(revoked).toContain("payments.reverse");
  });

  it("does not grant permissions outside the manager's set, while allowing revocation", () => {
    const alreadyGranted = ["students.delete"] as const;
    expect(sensitivePermissions.has("students.delete")).toBe(true);
    expect(updateIndividualPermission(alreadyGranted, "students.delete", true, ["students.view"]))
      .toEqual(alreadyGranted);
    expect(updateIndividualPermission(alreadyGranted, "students.delete", false, ["students.view"]))
      .toEqual([]);
    expect(updateIndividualPermission([], "students.view", true, ["students.view"]))
      .toEqual(["students.view"]);
  });

  it("filters account-creation permission grants to the manager's own set", () => {
    expect(keepManagerGrantablePermissions(
      ["students.view", "payments.reverse", "users.manage"],
      ["students.view", "users.manage"],
    )).toEqual(["students.view", "users.manage"]);
  });
});

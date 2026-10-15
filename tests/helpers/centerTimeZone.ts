import { DatabaseService } from "../../src/core/database";

export function configureTestCenterTimeZones(): void {
  const db = DatabaseService.getDb();
  for (const id of ["center-1", "center-2"]) {
    const center = db.getFirstSync<{ name: string; code: string }>(
      "SELECT name, code FROM centers WHERE id = ?",
      [id],
    );
    if (!center) throw new Error(`Test center ${id} was not seeded.`);
    db.runSync(
      `INSERT INTO centers (id, name, code, time_zone) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone`,
      [id, center.name, center.code, "Africa/Cairo"],
    );
  }
}

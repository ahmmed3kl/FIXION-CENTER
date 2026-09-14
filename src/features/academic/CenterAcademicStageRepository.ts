import { DatabaseService } from "../../core/database";
import { useAuthStore } from "../auth/useAuthStore";

export const DEFAULT_ACADEMIC_STAGES = [
  { id: "primary", label: "ابتدائي", grades: ["الأول الابتدائي", "الثاني الابتدائي", "الثالث الابتدائي", "الرابع الابتدائي", "الخامس الابتدائي", "السادس الابتدائي"] },
  { id: "preparatory", label: "إعدادي", grades: ["الأول الإعدادي", "الثاني الإعدادي", "الثالث الإعدادي"] },
  { id: "secondary", label: "ثانوي", grades: ["الأول الثانوي", "الثاني الثانوي", "الثالث الثانوي"] },
] as const;

export type AcademicStage = { id: string; label: string; grades: readonly string[] };

export class CenterAcademicStageRepository {
  static getStages(): AcademicStage[] {
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) return [...DEFAULT_ACADEMIC_STAGES];
    const row = DatabaseService.getDb().getFirstSync<{ stagesJson: string }>(
      "SELECT stages_json as stagesJson FROM center_academic_stages WHERE center_id = ?",
      [centerId],
    );
    if (!row?.stagesJson) return DEFAULT_ACADEMIC_STAGES.map((stage) => ({ ...stage, grades: [...stage.grades] }));
    try {
      const parsed = JSON.parse(row.stagesJson);
      return Array.isArray(parsed) ? parsed : DEFAULT_ACADEMIC_STAGES.map((stage) => ({ ...stage, grades: [...stage.grades] }));
    } catch {
      return DEFAULT_ACADEMIC_STAGES.map((stage) => ({ ...stage, grades: [...stage.grades] }));
    }
  }

  static saveStages(stages: AcademicStage[]): void {
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) throw new Error("يجب تحديد السنتر أولاً.");
    const cleaned = stages.filter((stage) => stage && stage.id && stage.label && stage.grades.length);
    DatabaseService.getDb().runSync(
      `INSERT INTO center_academic_stages (center_id, stages_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(center_id) DO UPDATE SET stages_json = excluded.stages_json, updated_at = excluded.updated_at`,
      [centerId, JSON.stringify(cleaned), new Date().toISOString()],
    );
  }
}

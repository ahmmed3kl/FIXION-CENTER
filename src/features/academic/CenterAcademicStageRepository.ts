import { DatabaseService } from "../../core/database";
import { useAuthStore } from "../auth/useAuthStore";

export const DEFAULT_ACADEMIC_STAGES = [
  { id: "primary", label: "ابتدائي", grades: ["الأول الابتدائي", "الثاني الابتدائي", "الثالث الابتدائي", "الرابع الابتدائي", "الخامس الابتدائي", "السادس الابتدائي"] },
  { id: "preparatory", label: "إعدادي", grades: ["الأول الإعدادي", "الثاني الإعدادي", "الثالث الإعدادي"] },
  { id: "secondary", label: "ثانوي", grades: ["الأول الثانوي", "الثاني الثانوي", "الثالث الثانوي"] },
] as const;

export type AcademicStage = { id: string; label: string; grades: readonly string[] };

export class CenterAcademicStageRepository {
  private static defaults(): AcademicStage[] {
    return DEFAULT_ACADEMIC_STAGES.map((stage) => ({ ...stage, grades: [...stage.grades] }));
  }

  static getStages(): AcademicStage[] {
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) return this.defaults();
    const row = DatabaseService.getDb().getFirstSync<{ stagesJson: string }>(
      "SELECT stages_json as stagesJson FROM center_academic_stages WHERE center_id = ?",
      [centerId],
    );
    if (!row?.stagesJson) return this.defaults();
    try {
      const parsed = JSON.parse(row.stagesJson);
      if (!Array.isArray(parsed)) {
        return this.defaults();
      }
      // Keep disabled defaults and preserve stages/grades added by the center.
      const defaults = this.defaults();
      return defaults.map((defaultStage) => {
        const saved = parsed.find((stage: any) => stage?.id === defaultStage.id);
        return { ...defaultStage, grades: Array.isArray(saved?.grades) ? saved.grades.filter((g: any) => typeof g === "string") : [] };
      }).concat(parsed
        .filter((stage: any) => stage && typeof stage.id === "string" && !defaults.some((item) => item.id === stage.id))
        .map((stage: any) => ({ id: stage.id, label: String(stage.label || "مرحلة"), grades: Array.isArray(stage.grades) ? stage.grades.filter((g: any) => typeof g === "string") : [] })));
    } catch {
      return this.defaults();
    }
  }

  static saveStages(stages: AcademicStage[]): void {
    const centerId = useAuthStore.getState().activeCenterId;
    if (!centerId) throw new Error("يجب تحديد السنتر أولاً.");
    const seen = new Set<string>();
    const cleaned = stages
      .filter((stage) => stage && typeof stage.id === "string" && typeof stage.label === "string")
      .map((stage) => ({
        id: stage.id.trim(),
        label: stage.label.trim(),
        grades: Array.from(new Set((stage.grades || []).map((grade) => String(grade).trim()).filter(Boolean))),
      }))
      .filter((stage) => stage.id && stage.label && !seen.has(stage.id) && (seen.add(stage.id), true));
    DatabaseService.getDb().runSync(
      `INSERT INTO center_academic_stages (center_id, stages_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(center_id) DO UPDATE SET stages_json = excluded.stages_json, updated_at = excluded.updated_at`,
      [centerId, JSON.stringify(cleaned), new Date().toISOString()],
    );
  }

  static addStage(label: string, grades: string[] = []): AcademicStage[] {
    const cleanLabel = label.trim();
    if (!cleanLabel) throw new Error("اسم المرحلة مطلوب.");
    const stages = this.getStages();
    if (stages.some((stage) => stage.label.trim() === cleanLabel)) throw new Error("هذه المرحلة موجودة بالفعل.");
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const next = [...stages, { id, label: cleanLabel, grades: Array.from(new Set(grades.map((grade) => grade.trim()).filter(Boolean))) }];
    this.saveStages(next);
    return next;
  }

  static addGrade(stageId: string, grade: string): AcademicStage[] {
    const cleanGrade = grade.trim();
    if (!cleanGrade) throw new Error("اسم الصف مطلوب.");
    const stages = this.getStages();
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) throw new Error("المرحلة غير موجودة.");
    if (stage.grades.some((item) => item.trim() === cleanGrade)) throw new Error("هذا الصف موجود بالفعل.");
    const next = stages.map((item) => item.id === stageId ? { ...item, grades: [...item.grades, cleanGrade] } : item);
    this.saveStages(next);
    return next;
  }
}

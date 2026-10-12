export const STUDENT_COLOR_OPTIONS = [
  { id: "lavender", label: "بنفسجي", background: "#F2ECFA", accent: "#8065A8" },
  { id: "sand", label: "رملي", background: "#F7F0E4", accent: "#A17B45" },
  { id: "slate", label: "رمادي", background: "#EEF1F4", accent: "#687786" },
  { id: "rose", label: "وردي", background: "#F8EDF2", accent: "#A86F89" },
  { id: "aqua", label: "فيروزي", background: "#EAF3F2", accent: "#5D8983" },
  { id: "peach", label: "خوخي", background: "#F8EEE8", accent: "#A9785E" },
] as const;

export type StudentColor = (typeof STUDENT_COLOR_OPTIONS)[number]["id"];

export function isStudentColor(value: unknown): value is StudentColor {
  return STUDENT_COLOR_OPTIONS.some((option) => option.id === value);
}

export function getStudentColorPresentation(value?: string | null) {
  const option = STUDENT_COLOR_OPTIONS.find((candidate) => candidate.id === value);
  return option
    ? { backgroundColor: option.background, accentColor: option.accent }
    : { backgroundColor: undefined, accentColor: undefined };
}

import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing, Typography, useTheme } from "../../core/theme";
import {
  GradeBookRepository,
  GradeExam,
  GradeScore,
  SessionGradeOption,
  SessionGradeRoster,
  SessionGradeStudentItem,
} from "../../features/grades/GradeBookRepository";
import { saveGradeEdit } from "../../features/grades/gradeScoreEdit";
import { mergeGradeScoreDrafts } from "../../features/grades/gradeScoreDrafts";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { NotificationService } from "../../features/notifications/NotificationService";
import { getStudentColorPresentation } from "../../features/students/studentColor";
import { Group, Student } from "../../shared/types";
import { smartSearch } from "../../shared/utils/smartSearch";
import { LocalDataEvents } from "../../core/database/localDataEvents";
import { useLocalDataRevision } from "../../core/database/useLocalDataRevision";

export default function GradesScreen() {
  const localDataRevision = useLocalDataRevision();
  const lastLoadedRevisionRef = useRef(localDataRevision);
  const hasInitialLoadedRef = useRef(false);
  const isFocusedRef = useRef(true);
  const { colors } = useTheme();
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const styles = useMemo(() => createStyles(), [colors]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const selectedGroupRef = useRef<Group | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [exams, setExams] = useState<GradeExam[]>([]);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [groupSessions, setGroupSessions] = useState<Array<{ id: string; sessionDate: string; startTime: string }>>([]);
  const [selectedExamSessionId, setSelectedExamSessionId] = useState("");
  const savedScoresRef = useRef<Record<string, string>>({});
  const [examName, setExamName] = useState("");
  const [maxScore, setMaxScore] = useState("100");
  const [showExamForm, setShowExamForm] = useState(false);
  const [scoreMin, setScoreMin] = useState("");
  const [scoreMax, setScoreMax] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [debouncedStudentSearch, setDebouncedStudentSearch] = useState("");
  const [sentExamIds, setSentExamIds] = useState<Record<string, boolean>>({});

  // Session-based grade recording state (PART 2, 3, 4, 6)
  const [sessionMode, setSessionMode] = useState<"none" | "select_session" | "record_session">("none");
  const [sessionExamId, setSessionExamId] = useState<string>("");
  const [chronologicalSessions, setChronologicalSessions] = useState<SessionGradeOption[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [sessionRoster, setSessionRoster] = useState<SessionGradeRoster | null>(null);
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({});
  const [sessionSearchInput, setSessionSearchInput] = useState("");
  const [debouncedSessionSearch, setDebouncedSessionSearch] = useState("");
  const [sessionFeedback, setSessionFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const scheduleLabel = (groupId: string) => GroupScheduleRepository.getSchedulesForGroup(groupId)
    .filter((schedule) => schedule.status !== "inactive")
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((schedule) => {
      const dayName = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"][schedule.dayOfWeek];
      return schedule.endTime
        ? `${dayName} ${schedule.startTime} – ${schedule.endTime}`
        : `${dayName} ${schedule.startTime}`;
    })
    .join(" • ") || "موعد غير محدد";

  const loadGroup = useCallback((group: Group, preserveDrafts = false) => {
    const nextStudents = GradeBookRepository.getStudentsForGroup(group.id);
    const nextExams = GradeBookRepository.getExams(group.id, group.grade);
    const nextSessions = GradeBookRepository.getSessionsForGroup(group.id);
    const nextScores = GradeBookRepository.getScores(nextExams.map((e) => e.id), nextStudents.map((s) => s.id));
    const values: Record<string, string> = {};
    for (const exam of nextExams) {
      for (const student of nextStudents) {
        values[`${exam.id}:${student.id}`] = "";
      }
    }
    nextScores.forEach((row: GradeScore) => { values[`${row.examId}:${row.studentId}`] = row.score === null ? "" : String(row.score); });
    const previousSavedScores = savedScoresRef.current;
    savedScoresRef.current = values;
    setStudents(nextStudents); setExams(nextExams);
    setScores((current) => preserveDrafts
      ? mergeGradeScoreDrafts(current, previousSavedScores, values)
      : values);
    setGroupSessions(nextSessions);
    setSelectedExamSessionId((current) => nextSessions.some((session) => session.id === current) ? current : "");
    const sent: Record<string, boolean> = {};
    nextExams.forEach((exam) => { sent[exam.id] = nextStudents.some((student) => NotificationService.hasGradeNotification(exam.id, student.id)); });
    setSentExamIds(sent);
  }, []);

  const load = useCallback(() => {
    try {
      const nextGroups = GradeBookRepository.getGroups();
      setGroups(nextGroups);
      const current = selectedGroupRef.current;
      if (current) {
        const fresh = nextGroups.find((group) => group.id === current.id) || nextGroups[0] || null;
        selectedGroupRef.current = fresh; setSelectedGroup(fresh);
        if (fresh) loadGroup(fresh, fresh.id === current.id);
      }
    } catch (error: any) { Alert.alert("خطأ", error?.message || "تعذر تحميل رصد الدرجات."); }
  }, [loadGroup]);

  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      const currentRevision = LocalDataEvents.getRevision();
      if (!hasInitialLoadedRef.current || lastLoadedRevisionRef.current !== currentRevision) {
        hasInitialLoadedRef.current = true;
        lastLoadedRevisionRef.current = currentRevision;
        load();
      }
      return () => {
        isFocusedRef.current = false;
      };
    }, [load]),
  );

  useEffect(() => {
    if (!isFocusedRef.current) return;
    if (localDataRevision > 0 && lastLoadedRevisionRef.current !== localDataRevision) {
      lastLoadedRevisionRef.current = localDataRevision;
      load();
    }
  }, [localDataRevision, load]);
  useFocusEffect(useCallback(() => {
    if (!groupId) return;
    try {
      const group = GradeBookRepository.getGroups().find((item) => item.id === String(groupId));
      if (group) selectGroup(group);
    } catch {}
  }, [groupId]));

  // Debounce smart student search in main gradebook
  useEffect(() => {
    if (!studentSearch.trim()) {
      setDebouncedStudentSearch("");
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedStudentSearch(studentSearch);
    }, 200);
    return () => clearTimeout(timer);
  }, [studentSearch]);

  // Debounce smart student search in session grade recording (PART 4)
  useEffect(() => {
    if (!sessionSearchInput.trim()) {
      setDebouncedSessionSearch("");
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSessionSearch(sessionSearchInput);
    }, 200);
    return () => clearTimeout(timer);
  }, [sessionSearchInput]);

  const selectGroup = (group: Group) => {
    const preserveDrafts = selectedGroupRef.current?.id === group.id;
    selectedGroupRef.current = group;
    setSelectedGroup(group);
    if (!preserveDrafts) {
      setSessionMode("none");
      setSessionExamId("");
      setSelectedSessionId("");
      setSessionRoster(null);
      setSessionDrafts({});
      setSessionSearchInput("");
      setDebouncedSessionSearch("");
      setSessionFeedback(null);
    }
    loadGroup(group, preserveDrafts);
  };

  const openSessionSelector = () => {
    if (!selectedGroup) return;
    setSessionFeedback(null);
    if (!exams.length) {
      setSessionFeedback({ type: "error", message: "أنشئ امتحاناً واحداً على الأقل أولاً لتتمكن من رصد درجات الجلسة." });
      return;
    }
    try {
      const ordered = GradeBookRepository.getSessionsForGroupChronological(selectedGroup.id);
      setChronologicalSessions(ordered);
      setSessionExamId((prev) => (prev && exams.some((e) => e.id === prev) ? prev : exams[exams.length - 1].id));
      setSessionMode("select_session");
    } catch (error: any) {
      setSessionFeedback({ type: "error", message: error?.message || "تعذر تحميل جلسات المجموعة." });
    }
  };

  const loadSessionRoster = useCallback((examId: string, sessionId: string) => {
    const roster = GradeBookRepository.getSessionGradeRoster(examId, sessionId);
    setSessionRoster(roster);
    const nextDrafts: Record<string, string> = {};
    for (const st of roster.gradedStudents) {
      nextDrafts[st.studentId] = st.score === null ? "" : String(st.score);
    }
    for (const st of roster.ungradedStudents) {
      nextDrafts[st.studentId] = "";
    }
    setSessionDrafts(nextDrafts);
  }, []);

  const handleSelectSessionForGrading = (session: SessionGradeOption) => {
    if (!sessionExamId) return;
    setSessionFeedback(null);
    try {
      setSelectedSessionId(session.id);
      setSessionSearchInput("");
      setDebouncedSessionSearch("");
      loadSessionRoster(sessionExamId, session.id);
      setSessionMode("record_session");
    } catch (error: any) {
      setSessionFeedback({ type: "error", message: error?.message || "تعذر تحميل طلاب الجلسة." });
    }
  };

  const handleSaveSessionStudentGrade = (student: SessionGradeStudentItem) => {
    if (!sessionRoster || !selectedSessionId) return;
    const rawDraft = sessionDrafts[student.studentId] ?? "";
    const previousValue = student.score === null ? "" : String(student.score);
    const result = saveGradeEdit(rawDraft, previousValue, (nextValue) =>
      GradeBookRepository.setSessionScore(sessionRoster.exam, selectedSessionId, student.studentId, nextValue),
    );
    if (result.saved) {
      loadSessionRoster(sessionRoster.exam.id, selectedSessionId);
      if (selectedGroup) loadGroup(selectedGroup, true);
      setSessionFeedback({
        type: "success",
        message: rawDraft.trim() === ""
          ? `تم تحديث حالة درجة الطالب «${student.studentName}» إلى غير مرصود.`
          : `تم حفظ درجة الطالب «${student.studentName}» (${rawDraft.trim()} / ${sessionRoster.exam.maxScore}) بنجاح.`,
      });
    } else {
      setSessionDrafts((prev) => ({ ...prev, [student.studentId]: previousValue }));
      setSessionFeedback({
        type: "error",
        message: result.error instanceof Error ? result.error.message : "تعذر حفظ الدرجة.",
      });
    }
  };

  const filteredGradedSessionStudents = useMemo(() => {
    const list = sessionRoster?.gradedStudents || [];
    if (!debouncedSessionSearch.trim()) return list;
    return smartSearch(list, debouncedSessionSearch, [
      { get: (s) => s.studentName, weight: 3 },
      { get: (s) => s.studentCode, weight: 2 },
    ]);
  }, [sessionRoster, debouncedSessionSearch]);

  const filteredUngradedSessionStudents = useMemo(() => {
    const list = sessionRoster?.ungradedStudents || [];
    if (!debouncedSessionSearch.trim()) return list;
    return smartSearch(list, debouncedSessionSearch, [
      { get: (s) => s.studentName, weight: 3 },
      { get: (s) => s.studentCode, weight: 2 },
    ]);
  }, [sessionRoster, debouncedSessionSearch]);
  const createExam = () => {
    if (!selectedGroup) return;
    try {
      const createdExam = GradeBookRepository.createExam(examName, selectedGroup.id, selectedGroup.grade, Number(maxScore), selectedExamSessionId || null);
      // SQLite is the source of truth, but update the mounted screen from the
      // mutation result immediately as well. This keeps the new exam visible
      // even when the screen was opened before the local invalidation event.
      setExams((current) => current.some((exam) => exam.id === createdExam.id) ? current : [...current, createdExam]);
      setExamName(""); setMaxScore("100"); setSelectedExamSessionId(""); setShowExamForm(false); loadGroup(selectedGroup, true);
    }
    catch (error: any) { Alert.alert("بيانات غير صحيحة", error?.message || "تعذر إضافة الامتحان."); }
  };
  const saveScore = (exam: GradeExam, student: Student, value: string) => {
    const key = `${exam.id}:${student.id}`;
    const result = saveGradeEdit(value, savedScoresRef.current[key] || "", (nextValue) =>
      GradeBookRepository.setScore(exam, student.id, nextValue),
    );
    if (result.saved) {
      savedScoresRef.current = { ...savedScoresRef.current, [key]: result.value };
      setScores((current) => ({ ...current, [key]: result.value }));
      return;
    }
    setScores((current) => ({ ...current, [key]: result.value }));
    Alert.alert(
      "درجة غير صحيحة",
      result.error instanceof Error ? result.error.message : "تعذر حفظ الدرجة.",
    );
  };
  const visibleStudents = useMemo(() => {
    const filtered = smartSearch(students, debouncedStudentSearch, [
      { get: (student) => student.fullName, weight: 3 },
      { get: (student) => student.studentCode },
      { get: (student) => student.cardCode },
      { get: (student) => student.phone },
    ]).filter((student) => {
      const min = scoreMin.trim() === "" ? null : Number(scoreMin);
      const max = scoreMax.trim() === "" ? null : Number(scoreMax);
      if (min === null && max === null) return true;
      const values = exams.map((exam) => Number(scores[`${exam.id}:${student.id}`])).filter((value) => Number.isFinite(value));
      return values.some((value) => (min === null || value >= min) && (max === null || value <= max));
    });
    const isGraded = (student: Student) =>
      exams.some((exam) => {
        const raw = scores[`${exam.id}:${student.id}`];
        return raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
      });
    const graded: Student[] = [];
    const ungraded: Student[] = [];
    for (const student of filtered) {
      if (isGraded(student)) graded.push(student);
      else ungraded.push(student);
    }
    return [...graded, ...ungraded];
  }, [students, exams, scores, scoreMin, scoreMax, debouncedStudentSearch]);
  const gradeStats = useMemo(() => {
    const values = students.flatMap((student) => exams.map((exam) => Number(scores[`${exam.id}:${student.id}`])).filter((value) => Number.isFinite(value)));
    return { count: values.length, average: values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1) : "0" };
  }, [students, exams, scores]);
  const gradedStudentCount = useMemo(
    () =>
      students.filter((student) =>
        exams.some((exam) => {
          const raw = scores[`${exam.id}:${student.id}`];
          return raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
        }),
      ).length,
    [students, exams, scores],
  );
  const ungradedStudentCount = Math.max(0, students.length - gradedStudentCount);
  const completion = students.length && exams.length ? Math.round((gradeStats.count / (students.length * exams.length)) * 100) : 0;
  const sendExamGrades = async (exam: GradeExam) => {
    const rows = students.map((student) => ({ student, value: scores[`${exam.id}:${student.id}`] })).filter((row) => row.value !== undefined && row.value !== "");
    if (!rows.length) return Alert.alert("لا توجد درجات", "سجل درجات هذا الامتحان أولاً.");
    try {
      if (sentExamIds[exam.id]) {
        const confirmed = await new Promise<boolean>((resolve) => Alert.alert("تم إرسال الدرجات مسبقًا", "هل تريد إعادة الإرسال؟", [{ text: "إلغاء", style: "cancel", onPress: () => resolve(false) }, { text: "إرسال مرة أخرى", onPress: () => resolve(true) }]));
        if (!confirmed) return;
      }
      for (const { student, value } of rows) {
        const event = NotificationService.notifyGrades({ operationId: `op-g-${exam.id.slice(-8)}-${student.id.slice(-8)}-${Date.now().toString(36).slice(-5)}`, studentId: student.id, examId: exam.id, sessionId: exam.sessionId, examName: exam.name, score: Number(value), maxScore: exam.maxScore, summary: `${exam.name}: ${value}/${exam.maxScore}` });
        await NotificationService.sendPendingDeliveries(event.id);
      }
      setSentExamIds((current) => ({ ...current, [exam.id]: true }));
      Alert.alert("تم تجهيز الرسائل", `تم تجهيز درجات ${exam.name} للإرسال لعدد ${rows.length} طالب.`);
    }
    catch (error: any) { Alert.alert("تعذر إرسال الدرجات", error?.message || "راجع صلاحية الإشعارات."); }
  };

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    {sessionMode === "select_session" && selectedGroup ? (
      <View style={styles.sessionFlowContainer}>
        <View style={styles.hero}>
          <TouchableOpacity onPress={() => { setSessionMode("none"); setSessionFeedback(null); }} style={styles.backButton}>
            <Ionicons name="chevron-forward" size={22} color={Colors.slate900} />
          </TouchableOpacity>
          <View style={styles.heroCopy}>
            <Text style={styles.kicker}>{selectedGroup.name}</Text>
            <Text style={styles.title}>رصد درجات جلسة</Text>
            <Text style={styles.subtitle}>اختر الامتحان والجلسة لعرض الطلاب الحاضرين فقط</Text>
          </View>
        </View>

        {sessionFeedback ? (
          <View style={[styles.sessionFeedbackBanner, sessionFeedback.type === "error" ? styles.sessionFeedbackError : styles.sessionFeedbackSuccess]}>
            <Text style={[styles.sessionFeedbackText, sessionFeedback.type === "error" ? { color: Colors.dangerText } : { color: Colors.successText }]}>{sessionFeedback.message}</Text>
            <TouchableOpacity onPress={() => setSessionFeedback(null)}>
              <Ionicons name="close" size={18} color={Colors.slate600} />
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.sessionPanelCard}>
          <Text style={styles.sessionSectionLabel}>الامتحان المختار</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.examChipsRow}>
            {exams.map((exam) => {
              const active = sessionExamId === exam.id;
              return (
                <TouchableOpacity
                  key={exam.id}
                  onPress={() => setSessionExamId(exam.id)}
                  style={[styles.examSelectChip, active && styles.examSelectChipActive]}
                >
                  <Text style={[styles.examSelectChipText, active && styles.examSelectChipTextActive]}>
                    {exam.name} (من {exam.maxScore})
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        <View style={styles.sessionPanelCard}>
          <Text style={styles.sessionSectionLabel}>اختر الجلسة (مرتبة من الأقدم إلى الأحدث)</Text>
          {chronologicalSessions.length === 0 ? (
            <Text style={styles.empty}>لا توجد جلسات مسجلة لهذه المجموعة.</Text>
          ) : (
            chronologicalSessions.map((session) => (
              <TouchableOpacity
                key={session.id}
                style={styles.sessionSelectCard}
                onPress={() => handleSelectSessionForGrading(session)}
              >
                <View style={styles.sessionSelectHeader}>
                  <View style={styles.sessionOrderBadge}>
                    <Text style={styles.sessionOrderBadgeText}>{session.sessionNumber}</Text>
                  </View>
                  <Text style={styles.sessionOrdinalTitle}>{session.sessionOrdinalTitle}</Text>
                  <View style={[styles.sessionStatusPill, session.status === "open" ? styles.sessionStatusOpen : styles.sessionStatusClosed]}>
                    <Text style={[styles.sessionStatusText, session.status === "open" ? { color: Colors.primary } : { color: Colors.slate600 }]}>
                      {session.sessionStatusLabel}
                    </Text>
                  </View>
                </View>
                <View style={styles.sessionMetaRow}>
                  <Text style={styles.sessionDatePill}>{session.sessionDateFormatted}</Text>
                  {session.sessionTimeLabel ? <Text style={styles.sessionTimePill}>{session.sessionTimeLabel}</Text> : null}
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>
      </View>
    ) : sessionMode === "record_session" && sessionRoster ? (
      <View style={styles.sessionFlowContainer}>
        <View style={styles.compactHeaderCard}>
          <View style={styles.compactHeaderTop}>
            <TouchableOpacity onPress={() => { setSessionMode("select_session"); setSessionFeedback(null); }} style={styles.backButton}>
              <Ionicons name="chevron-forward" size={18} color={Colors.slate900} />
            </TouchableOpacity>
            <View style={styles.compactHeaderCopy}>
              <Text style={styles.compactTitle} numberOfLines={1}>
                {selectedGroup?.name} — {sessionRoster.session.sessionOrdinalTitle}
              </Text>
              <Text style={styles.compactMeta} numberOfLines={1}>
                {selectedGroup?.subjectName || "—"} · {selectedGroup?.teacherName || "—"} · {selectedGroup ? scheduleLabel(selectedGroup.id) : "—"}
              </Text>
            </View>
            <TouchableOpacity onPress={() => { setSessionMode("none"); setSessionFeedback(null); }} style={styles.changeSessionBtn}>
              <Text style={styles.changeSessionBtnText}>الجدول</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.compactPillsRow}>
            <Text style={styles.compactPillPrimary}>{sessionRoster.exam.name} (من {sessionRoster.exam.maxScore})</Text>
            <Text style={styles.compactPillNeutral}>{sessionRoster.session.sessionDateFormatted}</Text>
            {sessionRoster.session.sessionTimeLabel ? <Text style={styles.compactPillNeutral}>{sessionRoster.session.sessionTimeLabel}</Text> : null}
          </View>
        </View>

        {sessionFeedback ? (
          <View style={[styles.sessionFeedbackBanner, sessionFeedback.type === "error" ? styles.sessionFeedbackError : styles.sessionFeedbackSuccess]}>
            <Text style={[styles.sessionFeedbackText, sessionFeedback.type === "error" ? { color: Colors.dangerText } : { color: Colors.successText }]}>{sessionFeedback.message}</Text>
            <TouchableOpacity onPress={() => setSessionFeedback(null)}>
              <Ionicons name="close" size={16} color={Colors.slate600} />
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Compact Grading Progress Bar */}
        <View style={styles.compactStatsBar}>
          <View style={styles.compactStatItem}>
            <Text style={styles.compactStatValue}>{sessionRoster.stats.totalEligible}</Text>
            <Text style={styles.compactStatLabel}>عدد الطلاب</Text>
          </View>
          <View style={styles.compactStatItem}>
            <Text style={[styles.compactStatValue, { color: Colors.successText }]}>{sessionRoster.stats.gradedCount}</Text>
            <Text style={styles.compactStatLabel}>تم الرصد</Text>
          </View>
          <View style={styles.compactStatItem}>
            <Text style={[styles.compactStatValue, { color: Colors.primary }]}>{sessionRoster.stats.ungradedCount}</Text>
            <Text style={styles.compactStatLabel}>لم يتم الرصد</Text>
          </View>
          <View style={styles.compactStatItem}>
            <Text style={[styles.compactStatValue, { color: Colors.accent }]}>
              {sessionRoster.stats.totalEligible ? Math.round((sessionRoster.stats.gradedCount / sessionRoster.stats.totalEligible) * 100) : 0}%
            </Text>
            <Text style={styles.compactStatLabel}>نسبة الرصد</Text>
          </View>
        </View>

        {/* Smart Student Search Immediately Above Student List */}
        <View style={styles.sessionSearchCard}>
          <Ionicons name="search-outline" size={16} color={Colors.slate500} />
          <TextInput
            style={styles.sessionSearchInput}
            value={sessionSearchInput}
            onChangeText={setSessionSearchInput}
            placeholder="ابحث باسم الطالب أو كوده..."
            placeholderTextColor={Colors.slate400}
            textAlign="right"
          />
          {sessionSearchInput ? (
            <TouchableOpacity onPress={() => { setSessionSearchInput(""); setDebouncedSessionSearch(""); }}>
              <Ionicons name="close-circle" size={16} color={Colors.slate500} />
            </TouchableOpacity>
          ) : null}
        </View>

        {sessionRoster.stats.totalEligible === 0 ? (
          <View style={styles.emptyCard}>
            <Ionicons name="people-outline" size={24} color={Colors.primary} />
            <Text style={styles.emptyTitle}>لا يوجد طلاب حاضرون في هذه الجلسة</Text>
            <Text style={styles.empty}>يظهر هنا فقط الطلاب المسجل حضورهم الفعلي في الجلسة المختارة.</Text>
          </View>
        ) : (
          <>
            {/* Section 1: Students Already Graded */}
            <View style={styles.sessionPanelCard}>
              <Text style={styles.sessionSectionLabel}>
                تم رصد درجاتهم ({filteredGradedSessionStudents.length})
              </Text>
              {filteredGradedSessionStudents.length === 0 ? (
                <Text style={styles.empty}>لا يوجد طلاب مطابقون في هذه القائمة.</Text>
              ) : (
                filteredGradedSessionStudents.map((student) => (
                  <View key={student.studentId} style={[styles.sessionStudentCard, styles.sessionStudentCardGraded]}>
                    <View style={styles.sessionStudentTop}>
                      <View style={styles.sessionStudentInfo}>
                        <Text style={styles.sessionStudentName}>{student.studentName}</Text>
                        <View style={styles.sessionStudentBadges}>
                          <Text style={styles.codeBadge}>كود: {student.studentCode}</Text>
                          <Text style={styles.gradedStatusBadge}>تم الرصد</Text>
                          {student.isMakeup ? <Text style={styles.makeupBadge}>تعويض</Text> : null}
                        </View>
                      </View>
                      <Text style={styles.recordedScoreLabel}>
                        {student.score} / {sessionRoster.exam.maxScore}
                      </Text>
                    </View>
                    <View style={styles.sessionGradeInputRow}>
                      <TextInput
                        style={styles.sessionGradeInput}
                        value={sessionDrafts[student.studentId] ?? ""}
                        onChangeText={(val) => setSessionDrafts((prev) => ({ ...prev, [student.studentId]: val }))}
                        keyboardType="decimal-pad"
                        placeholder="الدرجة"
                        placeholderTextColor={Colors.slate400}
                        textAlign="center"
                      />
                      <TouchableOpacity
                        style={styles.sessionSaveGradeBtn}
                        onPress={() => handleSaveSessionStudentGrade(student)}
                      >
                        <Text style={styles.sessionSaveGradeBtnText}>حفظ التعديل</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </View>

            {/* Section 2: Students Not Yet Graded */}
            <View style={styles.sessionPanelCard}>
              <Text style={styles.sessionSectionLabel}>
                لم يتم رصد درجاتهم ({filteredUngradedSessionStudents.length})
              </Text>
              {filteredUngradedSessionStudents.length === 0 ? (
                <Text style={styles.empty}>لا يوجد طلاب متبقون في هذه القائمة.</Text>
              ) : (
                filteredUngradedSessionStudents.map((student) => (
                  <View key={student.studentId} style={[styles.sessionStudentCard, styles.sessionStudentCardUngraded]}>
                    <View style={styles.sessionStudentTop}>
                      <View style={styles.sessionStudentInfo}>
                        <Text style={styles.sessionStudentName}>{student.studentName}</Text>
                        <View style={styles.sessionStudentBadges}>
                          <Text style={styles.codeBadge}>كود: {student.studentCode}</Text>
                          <Text style={styles.ungradedStatusBadge}>لم يتم الرصد</Text>
                          {student.isMakeup ? <Text style={styles.makeupBadge}>تعويض</Text> : null}
                        </View>
                      </View>
                      <Text style={styles.maxScoreHint}>من {sessionRoster.exam.maxScore}</Text>
                    </View>
                    <View style={styles.sessionGradeInputRow}>
                      <TextInput
                        style={styles.sessionGradeInput}
                        value={sessionDrafts[student.studentId] ?? ""}
                        onChangeText={(val) => setSessionDrafts((prev) => ({ ...prev, [student.studentId]: val }))}
                        keyboardType="decimal-pad"
                        placeholder="أدخل الدرجة"
                        placeholderTextColor={Colors.slate400}
                        textAlign="center"
                      />
                      <TouchableOpacity
                        style={styles.sessionSaveGradeBtn}
                        onPress={() => handleSaveSessionStudentGrade(student)}
                      >
                        <Text style={styles.sessionSaveGradeBtnText}>حفظ الدرجة</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </View>
    ) : (
      <>
        <View style={styles.hero}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="chevron-forward" size={18} color={Colors.slate900} />
          </TouchableOpacity>
          <View style={styles.heroIcon}>
            <Ionicons name="school-outline" size={20} color={Colors.primary} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.kicker}>الأداء الأكاديمي</Text>
            <Text style={styles.title}>رصد الدرجات</Text>
          </View>
        </View>

        {!groupId ? (
          <>
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>اختر المجموعة ({groups.length})</Text>
              <Ionicons name="layers-outline" size={16} color={Colors.primary} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.groupRow}>
              {groups.map((group) => (
                <TouchableOpacity
                  key={group.id}
                  onPress={() => selectGroup(group)}
                  style={[styles.groupCard, selectedGroup?.id === group.id && styles.groupCardActive]}
                >
                  <Text style={[styles.groupChipText, selectedGroup?.id === group.id && styles.groupChipTextActive]} numberOfLines={1}>
                    {group.name}
                  </Text>
                  <Text style={[styles.groupGrade, selectedGroup?.id === group.id && styles.groupChipTextActive]} numberOfLines={1}>
                    {group.grade}
                  </Text>
                  <Text style={[styles.groupMeta, selectedGroup?.id === group.id && styles.groupChipTextActive]} numberOfLines={1}>
                    {scheduleLabel(group.id)}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {!groups.length ? <Text style={styles.empty}>لا توجد مجموعات نشطة.</Text> : null}
          </>
        ) : null}

        {selectedGroup ? (
          <>
            {/* 1. Compact Group and Exam Information */}
            <View style={styles.selectedHeader}>
              <View style={styles.selectedIdentity}>
                <View style={styles.selectedIcon}>
                  <Ionicons name="ribbon-outline" size={18} color={Colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.selectedTitle} numberOfLines={1}>{selectedGroup.name}</Text>
                  <Text style={styles.selectedMeta} numberOfLines={2}>
                    {selectedGroup.subjectName || "—"} · {selectedGroup.teacherName || "—"} · {selectedGroup.grade} · {scheduleLabel(selectedGroup.id)}
                  </Text>
                </View>
              </View>
              <View style={styles.headerActionsRow}>
                <TouchableOpacity style={styles.sessionActionButton} onPress={openSessionSelector}>
                  <Ionicons name="calendar-outline" size={14} color={Colors.primary} />
                  <Text style={styles.sessionActionText}>رصد درجات جلسة</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.addExamButton} onPress={() => setShowExamForm((value) => !value)}>
                  <Ionicons name={showExamForm ? "close" : "add"} size={15} color={Colors.white} />
                  <Text style={styles.addExamText}>{showExamForm ? "إلغاء" : "امتحان جديد"}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {Object.values(sentExamIds).some(Boolean) ? (
              <Text style={styles.filterHint}>تم إرسال درجات امتحان مسبقًا — سيظهر تأكيد قبل إعادة الإرسال</Text>
            ) : null}

            {sessionFeedback ? (
              <View style={[styles.sessionFeedbackBanner, sessionFeedback.type === "error" ? styles.sessionFeedbackError : styles.sessionFeedbackSuccess]}>
                <Text style={[styles.sessionFeedbackText, sessionFeedback.type === "error" ? { color: Colors.dangerText } : { color: Colors.successText }]}>{sessionFeedback.message}</Text>
                <TouchableOpacity onPress={() => setSessionFeedback(null)}>
                  <Ionicons name="close" size={16} color={Colors.slate600} />
                </TouchableOpacity>
              </View>
            ) : null}

            {showExamForm ? (
              <View style={styles.examForm}>
                <Text style={styles.formLabel}>إضافة امتحان</Text>
                <View style={styles.formFields}>
                  <TextInput style={styles.input} value={examName} onChangeText={setExamName} placeholder="اسم الامتحان" placeholderTextColor={Colors.slate400} textAlign="right" />
                  <TextInput style={styles.scoreInput} value={maxScore} onChangeText={setMaxScore} keyboardType="decimal-pad" placeholder="النهائية" placeholderTextColor={Colors.slate400} textAlign="center" />
                  <TouchableOpacity style={styles.saveExam} onPress={createExam}>
                    <Ionicons name="checkmark" size={15} color={Colors.white} />
                    <Text style={styles.saveExamText}>حفظ</Text>
                  </TouchableOpacity>
                </View>
                {groupSessions.length ? (
                  <>
                    <Text style={styles.formLabel}>الحصة المرتبطة بالامتحان</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.groupRow}>
                      {groupSessions.map((session) => (
                        <TouchableOpacity
                          key={session.id}
                          onPress={() => setSelectedExamSessionId(session.id)}
                          style={[styles.groupCard, selectedExamSessionId === session.id && styles.groupCardActive]}
                        >
                          <Text style={[styles.groupChipText, selectedExamSessionId === session.id && styles.groupChipTextActive]}>
                            {session.sessionDate} · {session.startTime}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </>
                ) : (
                  <Text style={styles.formHint}>لا توجد حصص لهذه المجموعة؛ يمكن ربط الامتحان بحصة لاحقًا.</Text>
                )}
              </View>
            ) : null}

            {/* 2. Compact Grading Progress */}
            <View style={styles.compactStatsBar}>
              <View style={styles.compactStatItem}>
                <Text style={styles.compactStatValue}>{students.length}</Text>
                <Text style={styles.compactStatLabel}>عدد الطلاب</Text>
              </View>
              <View style={styles.compactStatItem}>
                <Text style={[styles.compactStatValue, { color: Colors.successText }]}>{gradedStudentCount}</Text>
                <Text style={styles.compactStatLabel}>تم الرصد</Text>
              </View>
              <View style={styles.compactStatItem}>
                <Text style={[styles.compactStatValue, { color: Colors.primary }]}>{ungradedStudentCount}</Text>
                <Text style={styles.compactStatLabel}>لم يتم الرصد</Text>
              </View>
              <View style={styles.compactStatItem}>
                <Text style={[styles.compactStatValue, { color: Colors.accent }]}>{completion}%</Text>
                <Text style={styles.compactStatLabel}>نسبة الرصد</Text>
              </View>
            </View>

            {exams.length ? (
              <View style={styles.progressPanel}>
                {exams.map((exam) => {
                  const recorded = students.filter((student) => {
                    const value = scores[`${exam.id}:${student.id}`];
                    return value !== undefined && value !== "" && Number.isFinite(Number(value));
                  }).length;
                  return (
                    <View key={`progress-${exam.id}`} style={styles.progressRow}>
                      <Text style={styles.progressExamName} numberOfLines={1}>{exam.name} (من {exam.maxScore})</Text>
                      <Text style={styles.progressText}>تم رصد {recorded} من {students.length}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/* 3. Compact Grade Range Filters */}
            <View style={styles.filterCard}>
              <View style={styles.filterCompactRow}>
                <Text style={styles.filterTitle}>نطاق الدرجات:</Text>
                <TextInput style={styles.filterInput} value={scoreMin} onChangeText={setScoreMin} keyboardType="decimal-pad" placeholder="من" placeholderTextColor={Colors.slate400} />
                <Text style={styles.filterDash}>—</Text>
                <TextInput style={styles.filterInput} value={scoreMax} onChangeText={setScoreMax} keyboardType="decimal-pad" placeholder="إلى" placeholderTextColor={Colors.slate400} />
                <Text style={styles.filterCount}>{visibleStudents.length} طالب</Text>
                {(scoreMin || scoreMax) ? (
                  <TouchableOpacity onPress={() => { setScoreMin(""); setScoreMax(""); }} hitSlop={8}>
                    <Text style={styles.clearFilter}>مسح</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>

            {/* 4. Student Search Field Immediately Above Student List */}
            <View style={styles.sessionSearchCard}>
              <Ionicons name="search-outline" size={16} color={Colors.slate500} />
              <TextInput
                style={styles.sessionSearchInput}
                value={studentSearch}
                onChangeText={setStudentSearch}
                placeholder="ابحث بالاسم أو الكود أو الهاتف..."
                placeholderTextColor={Colors.slate400}
                textAlign="right"
              />
              {studentSearch ? (
                <TouchableOpacity onPress={() => { setStudentSearch(""); setDebouncedStudentSearch(""); }}>
                  <Ionicons name="close-circle" size={16} color={Colors.slate500} />
                </TouchableOpacity>
              ) : null}
            </View>

            {/* 5. Student List Immediately Below Search */}
            {exams.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tableWrap}>
                <View>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.studentCell, styles.headerCell]}>الطالب</Text>
                    {exams.map((exam) => (
                      <View key={exam.id} style={styles.examCell}>
                        <Text style={styles.headerCell} numberOfLines={1}>{exam.name}</Text>
                        <Text style={styles.maxText}>من {exam.maxScore}</Text>
                        <TouchableOpacity onPress={() => sendExamGrades(exam)} style={styles.examSendButton}>
                          <Ionicons name="send-outline" size={11} color={Colors.white} />
                          <Text style={styles.examSendText}>إرسال</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                  {visibleStudents.length === 0 ? (
                    <Text style={styles.empty}>لا يوجد طلاب مطابقون للبحث أو التصفية.</Text>
                  ) : (
                    visibleStudents.map((student, index) => {
                      const studentColor = getStudentColorPresentation(student.studentColor);
                      return (
                        <View key={student.id} style={[styles.tableRow, index % 2 === 1 && styles.tableRowAlt]}>
                          <View style={styles.studentCell}>
                            <View style={[styles.avatar, studentColor.backgroundColor ? { backgroundColor: studentColor.backgroundColor, borderColor: studentColor.accentColor } : null]}>
                              <Text style={[styles.avatarText, studentColor.accentColor ? { color: studentColor.accentColor } : null]}>
                                {student.fullName?.trim()?.charAt(0) || "ط"}
                              </Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.studentName} numberOfLines={1}>{student.fullName}</Text>
                              {student.studentCode ? <Text style={styles.studentCodeSub} numberOfLines={1}>كود: {student.studentCode}</Text> : null}
                            </View>
                          </View>
                          {exams.map((exam) => (
                            <TextInput
                              key={exam.id}
                              style={styles.markInput}
                              value={scores[`${exam.id}:${student.id}`] || ""}
                              onChangeText={(value) => setScores((current) => ({ ...current, [`${exam.id}:${student.id}`]: value }))}
                              onBlur={() => saveScore(exam, student, scores[`${exam.id}:${student.id}`] || "")}
                              keyboardType="decimal-pad"
                              placeholder="—"
                              placeholderTextColor={Colors.slate400}
                              textAlign="center"
                            />
                          ))}
                        </View>
                      );
                    })
                  )}
                </View>
              </ScrollView>
            ) : (
              <View style={styles.emptyCard}>
                <Ionicons name="document-text-outline" size={24} color={Colors.primary} />
                <Text style={styles.emptyTitle}>لا توجد امتحانات بعد</Text>
                <Text style={styles.empty}>أضف أول امتحان لهذه المجموعة لتبدأ الرصد.</Text>
              </View>
            )}
          </>
        ) : (
          <View style={styles.emptyCard}>
            <Ionicons name="people-outline" size={24} color={Colors.primary} />
            <Text style={styles.emptyTitle}>ابدأ باختيار مجموعة</Text>
            <Text style={styles.empty}>ستظهر هنا قائمة الطلاب والامتحانات الخاصة بها.</Text>
          </View>
        )}
      </>
    )}
  </ScrollView></SafeAreaView>;
}

const createStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.md, gap: 8, paddingBottom: 32 },
  hero: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: Colors.primaryMuted, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: Colors.primaryLight },
  backButton: { width: 32, height: 32, borderRadius: 9, backgroundColor: Colors.white, alignItems: "center", justifyContent: "center" },
  heroCopy: { flex: 1 },
  heroIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: Colors.white },
  kicker: { color: Colors.primary, fontSize: 11, fontWeight: "800", textAlign: "right" },
  title: { ...Typography.h3, color: Colors.slate900, textAlign: "right", fontSize: 17 },
  subtitle: { color: Colors.slate600, fontSize: 11, textAlign: "right", marginTop: 2 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  sectionTitle: { color: Colors.slate900, fontSize: 14, fontWeight: "800", textAlign: "right" },
  groupRow: { gap: 8, paddingVertical: 2 },
  groupCard: { width: 138, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, gap: 2 },
  groupCardActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  groupChipText: { color: Colors.slate800, fontSize: 13, fontWeight: "800", textAlign: "right" },
  groupGrade: { color: Colors.primary, fontSize: 11, fontWeight: "700", textAlign: "right" },
  groupMeta: { color: Colors.slate500, fontSize: 10, textAlign: "right" },
  groupChipTextActive: { color: Colors.white },
  selectedHeader: { gap: 8, backgroundColor: Colors.white, padding: 10, borderRadius: 14, borderWidth: 1, borderColor: Colors.border },
  selectedIdentity: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  selectedIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" },
  selectedTitle: { color: Colors.slate900, fontSize: 15, fontWeight: "800", textAlign: "right" },
  selectedMeta: { color: Colors.slate500, fontSize: 11, textAlign: "right", marginTop: 2 },
  headerActionsRow: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  addExamButton: { flex: 1, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: Colors.primary, borderRadius: 9, paddingHorizontal: 10, minHeight: 34 },
  addExamText: { color: Colors.white, fontWeight: "800", fontSize: 12 },
  sessionActionButton: { flex: 1, flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: Colors.primaryLight, borderRadius: 9, borderWidth: 1, borderColor: Colors.primaryMuted, paddingHorizontal: 10, minHeight: 34 },
  sessionActionText: { color: Colors.primary, fontWeight: "800", fontSize: 12 },
  examForm: { backgroundColor: Colors.white, borderRadius: 12, padding: 10, borderWidth: 1, borderColor: Colors.primaryLight, gap: 8 },
  formLabel: { color: Colors.slate800, fontSize: 12, fontWeight: "800", textAlign: "right" },
  formHint: { color: Colors.slate500, fontSize: 11, textAlign: "right" },
  formFields: { flexDirection: "row", alignItems: "center", gap: 6 },
  input: { flex: 1, height: 38, borderWidth: 1, borderColor: Colors.border, borderRadius: 9, paddingHorizontal: 10, color: Colors.slate900, fontSize: 13 },
  scoreInput: { width: 68, height: 38, borderWidth: 1, borderColor: Colors.border, borderRadius: 9, color: Colors.slate900, fontSize: 13 },
  saveExam: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: Colors.success, borderRadius: 9, paddingHorizontal: 12, height: 38 },
  saveExamText: { color: Colors.white, fontWeight: "800", fontSize: 12 },
  compactHeaderCard: { backgroundColor: Colors.primaryMuted, borderRadius: 14, padding: 10, borderWidth: 1, borderColor: Colors.primaryLight, gap: 6 },
  compactHeaderTop: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  compactHeaderCopy: { flex: 1, alignItems: "flex-end" },
  compactTitle: { color: Colors.slate900, fontSize: 15, fontWeight: "900", textAlign: "right" },
  compactMeta: { color: Colors.slate600, fontSize: 11, textAlign: "right", marginTop: 1 },
  compactPillsRow: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6 },
  compactPillPrimary: { fontSize: 11, fontWeight: "800", color: Colors.primary, backgroundColor: Colors.white, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 },
  compactPillNeutral: { fontSize: 11, fontWeight: "700", color: Colors.slate700, backgroundColor: Colors.white, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 },
  compactStatsBar: { flexDirection: "row-reverse", backgroundColor: Colors.white, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, paddingVertical: 7, paddingHorizontal: 6 },
  compactStatItem: { flex: 1, alignItems: "center", justifyContent: "center" },
  compactStatValue: { color: Colors.slate900, fontSize: 15, fontWeight: "900" },
  compactStatLabel: { color: Colors.slate500, fontSize: 10, fontWeight: "700", marginTop: 1 },
  progressPanel: { backgroundColor: Colors.white, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 10, paddingVertical: 6, gap: 4 },
  progressRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center", paddingVertical: 2 },
  progressExamName: { color: Colors.slate700, fontSize: 11, fontWeight: "700", flex: 1, textAlign: "right" },
  progressText: { color: Colors.primary, fontSize: 11, fontWeight: "800", marginRight: 8 },
  filterCard: { backgroundColor: Colors.white, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 10, paddingVertical: 7 },
  filterCompactRow: { flexDirection: "row-reverse", alignItems: "center", gap: 6 },
  filterTitle: { color: Colors.slate800, fontSize: 12, fontWeight: "800", textAlign: "right" },
  filterHint: { color: Colors.slate500, fontSize: 11, textAlign: "right" },
  clearFilter: { color: Colors.primary, fontWeight: "800", fontSize: 11 },
  filterInput: { width: 54, height: 32, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, color: Colors.slate900, textAlign: "center", fontSize: 12, paddingVertical: 2 },
  filterDash: { color: Colors.slate500, fontSize: 11 },
  filterCount: { flex: 1, color: Colors.primary, fontWeight: "800", textAlign: "left", fontSize: 11 },
  tableWrap: { backgroundColor: Colors.white, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, overflow: "hidden", minWidth: "100%" },
  tableHeader: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.primaryLight, borderBottomWidth: 1, borderBottomColor: Colors.border, minHeight: 46 },
  tableRow: { flexDirection: "row", alignItems: "center", minHeight: 48, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tableRowAlt: { backgroundColor: Colors.slate50 },
  studentCell: { width: 210, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  studentName: { color: Colors.slate900, fontWeight: "700", fontSize: 12, textAlign: "right" },
  studentCodeSub: { color: Colors.slate500, fontSize: 10, textAlign: "right" },
  avatar: { width: 26, height: 26, borderRadius: 8, backgroundColor: Colors.primaryLight, alignItems: "center", justifyContent: "center" },
  avatarText: { color: Colors.primary, fontSize: 11, fontWeight: "900" },
  examCell: { width: 92, padding: 6, alignItems: "center" },
  headerCell: { color: Colors.slate900, fontWeight: "900", textAlign: "center", fontSize: 11 },
  maxText: { color: Colors.slate600, fontSize: 10, marginTop: 1 },
  markInput: { width: 60, height: 34, marginHorizontal: 16, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, color: Colors.slate900, backgroundColor: Colors.white, fontWeight: "800", fontSize: 13 },
  examSendButton: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: Colors.primary, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, marginTop: 3 },
  examSendText: { color: Colors.white, fontSize: 9, fontWeight: "800" },
  emptyCard: { alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: Colors.white, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, padding: 20 },
  emptyTitle: { color: Colors.slate800, fontSize: 14, fontWeight: "800", textAlign: "center" },
  empty: { color: Colors.slate500, fontSize: 12, textAlign: "center", padding: 6, lineHeight: 18 },
  sessionFlowContainer: { gap: 8 },
  sessionFeedbackBanner: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, gap: 8 },
  sessionFeedbackSuccess: { backgroundColor: Colors.successLight, borderColor: Colors.success },
  sessionFeedbackError: { backgroundColor: Colors.dangerLight, borderColor: Colors.danger },
  sessionFeedbackText: { flex: 1, fontSize: 12, fontWeight: "700", textAlign: "right", lineHeight: 17 },
  sessionPanelCard: { backgroundColor: Colors.white, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: 10, gap: 8 },
  sessionSectionLabel: { color: Colors.slate900, fontSize: 13, fontWeight: "900", textAlign: "right" },
  examChipsRow: { flexDirection: "row-reverse", gap: 6, paddingVertical: 2 },
  examSelectChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.slate50 },
  examSelectChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  examSelectChipText: { color: Colors.slate800, fontSize: 12, fontWeight: "700" },
  examSelectChipTextActive: { color: Colors.white },
  sessionSelectCard: { backgroundColor: Colors.slate50, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: 10, gap: 6 },
  sessionSelectHeader: { flexDirection: "row-reverse", alignItems: "center", gap: 8 },
  sessionOrderBadge: { width: 26, height: 26, borderRadius: 8, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  sessionOrderBadgeText: { color: Colors.white, fontSize: 12, fontWeight: "900" },
  sessionOrdinalTitle: { flex: 1, color: Colors.slate900, fontSize: 13, fontWeight: "800", textAlign: "right" },
  sessionStatusPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  sessionStatusOpen: { backgroundColor: Colors.primaryLight, borderColor: Colors.primaryMuted },
  sessionStatusClosed: { backgroundColor: Colors.white, borderColor: Colors.border },
  sessionStatusText: { fontSize: 10, fontWeight: "800" },
  sessionMetaRow: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 6, alignItems: "center" },
  sessionDatePill: { fontSize: 11, fontWeight: "800", color: Colors.primary, backgroundColor: Colors.primaryLight, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  sessionTimePill: { fontSize: 11, fontWeight: "700", color: Colors.slate600, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  changeSessionBtn: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border },
  changeSessionBtnText: { fontSize: 11, fontWeight: "800", color: Colors.primary },
  sessionSearchCard: { flexDirection: "row-reverse", alignItems: "center", gap: 8, backgroundColor: Colors.white, borderRadius: 11, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 10, minHeight: 40 },
  sessionSearchInput: { flex: 1, color: Colors.slate900, fontSize: 13, paddingVertical: 6 },
  sessionStudentCard: { borderRadius: 10, borderWidth: 1, padding: 9, gap: 6 },
  sessionStudentCardGraded: { backgroundColor: Colors.white, borderColor: Colors.successLight },
  sessionStudentCardUngraded: { backgroundColor: Colors.slate50, borderColor: Colors.border },
  sessionStudentTop: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 8 },
  sessionStudentInfo: { flex: 1, alignItems: "flex-end", gap: 4 },
  sessionStudentName: { color: Colors.slate900, fontSize: 13, fontWeight: "800", textAlign: "right" },
  sessionStudentBadges: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 5 },
  codeBadge: { fontSize: 10, fontWeight: "700", color: Colors.slate600, backgroundColor: Colors.white, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  gradedStatusBadge: { fontSize: 10, fontWeight: "800", color: Colors.successText, backgroundColor: Colors.successLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  ungradedStatusBadge: { fontSize: 10, fontWeight: "800", color: Colors.warningText, backgroundColor: Colors.warningLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  makeupBadge: { fontSize: 10, fontWeight: "800", color: Colors.primary, backgroundColor: Colors.primaryLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  recordedScoreLabel: { color: Colors.successText, fontSize: 13, fontWeight: "900" },
  maxScoreHint: { color: Colors.slate500, fontSize: 11, fontWeight: "700" },
  sessionGradeInputRow: { flexDirection: "row-reverse", alignItems: "center", gap: 6 },
  sessionGradeInput: { flex: 1, height: 36, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, backgroundColor: Colors.white, color: Colors.slate900, fontWeight: "800", fontSize: 13 },
  sessionSaveGradeBtn: { backgroundColor: Colors.primary, borderRadius: 8, paddingHorizontal: 12, minHeight: 36, alignItems: "center", justifyContent: "center" },
  sessionSaveGradeBtnText: { color: Colors.white, fontSize: 12, fontWeight: "800" },
});

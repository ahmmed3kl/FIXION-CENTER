import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@expo/ui/community/datetime-picker";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
    Alert,
    FlatList,
    Modal,
    RefreshControl,
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { Strings } from "../../core/localization";
import {
    PermissionService,
    resolveUserPermissions
} from "../../core/permissions";
import { SyncEngine } from "../../core/sync";
import { Colors, Spacing, Typography } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { GroupRepository } from "../../features/groups/GroupRepository";
import { GroupScheduleRepository } from "../../features/groups/GroupScheduleRepository";
import { SessionGenerationService } from "../../features/sessions/SessionGenerationService";
import { SubjectRepository } from "../../features/subjects/SubjectRepository";
import { TeacherRepository } from "../../features/teachers/TeacherRepository";
import { TeacherSubjectRepository } from "../../features/teachers/TeacherSubjectRepository";
import { smartSearch } from "../../shared/utils/smartSearch";
import { AcademicStage, CenterAcademicStageRepository, DEFAULT_ACADEMIC_STAGES } from "../../features/academic/CenterAcademicStageRepository";
import {
    AppButton,
    AppCard,
    AppInput,
    EmptyState,
    StatusBadge,
} from "../../shared/components";
import {
    Group,
    GroupSchedule,
    Session,
    Subject,
    Teacher,
} from "../../shared/types";

type AcademicTab = "teachers" | "subjects" | "groups" | "stages";

const DAYS_OF_WEEK = [
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

export default function AcademicScreen() {
  const router = useRouter();
  const currentUser = useAuthStore((s) => s.currentUser);
  const activeCenterId = useAuthStore((s) => s.activeCenterId);
  const permissions = resolveUserPermissions(currentUser);

  const [activeTab, setActiveTab] = useState<AcademicTab>("teachers");
  const [refreshing, setRefreshing] = useState(false);

  // Data lists
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [showTodayGroups, setShowTodayGroups] = useState(false);
  const [todayGroupIds, setTodayGroupIds] = useState<string[]>([]);
  const [groupTeacherFilter, setGroupTeacherFilter] = useState<string>("");
  const [teacherSearch, setTeacherSearch] = useState("");
  const [todaySessions, setTodaySessions] = useState<Session[]>([]);
  const [academicStages, setAcademicStages] = useState<AcademicStage[]>(() => DEFAULT_ACADEMIC_STAGES.map((stage) => ({ ...stage, grades: [...stage.grades] })));

  // Selection & Modals
  const [isAddTeacherOpen, setIsAddTeacherOpen] = useState(false);
  const [isAddSubjectOpen, setIsAddSubjectOpen] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null);
  const [teacherSubjectIds, setTeacherSubjectIds] = useState<string[]>([]);
  const [isAddGroupOpen, setIsAddGroupOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [groupSchedules, setGroupSchedules] = useState<GroupSchedule[]>([]);
  const [isAddScheduleOpen, setIsAddScheduleOpen] = useState(false);

  // Forms State
  const [teacherName, setTeacherName] = useState("");
  const [teacherPhone, setTeacherPhone] = useState("");
  const [teacherNotes, setTeacherNotes] = useState("");

  const [subjectName, setSubjectName] = useState("");
  const [subjectCode, setSubjectCode] = useState("");

  const [groupName, setGroupName] = useState("");
  const [groupTeacherId, setGroupTeacherId] = useState("");
  const [groupSubjectId, setGroupSubjectId] = useState("");
  const [groupGrade, setGroupGrade] = useState("الصف الثالث الثانوي");
  const [groupSessionPrice, setGroupSessionPrice] = useState("100");
  const [groupMonthlyPrice, setGroupMonthlyPrice] = useState("400");
  const [groupDuration, setGroupDuration] = useState("120");
  const [groupLateThreshold, setGroupLateThreshold] = useState("15");
  const [groupNameCustomized, setGroupNameCustomized] = useState(false);
  const [selectedScheduleDays, setSelectedScheduleDays] = useState<number[]>([]);
  const [scheduleTimes, setScheduleTimes] = useState<Record<number, { start: string; end: string }>>({});
  const [timePicker, setTimePicker] = useState<{ day: number; field: "start" | "end" } | null>(null);
  const [timeDraftHour, setTimeDraftHour] = useState(17);
  const [timeDraftMinute, setTimeDraftMinute] = useState(0);

  const [schedDay, setSchedDay] = useState(0);
  const [schedStart, setSchedStart] = useState("14:00");
  const [schedEnd, setSchedEnd] = useState("16:00");

  // Session Generation State
  const todayStr = new Date().toISOString().split("T")[0];
  const nextWeekStr = new Date(Date.now() + 7 * 86400000)
    .toISOString()
    .split("T")[0];
  const [genFromDate, setGenFromDate] = useState(todayStr);
  const [genToDate, setGenToDate] = useState(nextWeekStr);
  const [generatedSessions, setGeneratedSessions] = useState<Session[]>([]);

  const generatedGroupName = () => {
    const teacher = teachers.find((item) => item.id === groupTeacherId)?.name;
    const subject = subjects.find((item) => item.id === groupSubjectId)?.name;
    return [groupGrade.trim(), subject, teacher].filter(Boolean).join(" - ");
  };

  const filteredTeachers = smartSearch(teachers, teacherSearch, [{ get: (teacher) => teacher.name, weight: 1.2 }, { get: (teacher) => teacher.phone }]);

  const formatTimeForName = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
    const suffix = hour >= 12 ? "م" : "ص";
    const displayHour = hour % 12 || 12;
    return `${String(displayHour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${suffix}`;
  };

  const selectTime = (hour: number, minute: number) => {
    if (!timePicker) return;
    const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    setScheduleTimes((current) => ({ ...current, [timePicker.day]: { ...(current[timePicker.day] || { start: "17:00", end: "19:00" }), [timePicker.field]: value } }));
    setTimePicker(null);
  };

  const openTimePicker = (day: number, field: "start" | "end") => {
    const value = scheduleTimes[day]?.[field] || (field === "start" ? "17:00" : "19:00");
    setTimeDraftHour(Number(value.split(":")[0]) || 17);
    setTimeDraftMinute(Number(value.split(":")[1]) || 0);
    setTimePicker({ day, field });
  };

  const pickerDate = timePicker ? (() => {
    const value = scheduleTimes[timePicker.day]?.[timePicker.field] || (timePicker.field === "start" ? "17:00" : "19:00");
    const [hour, minute] = value.split(":").map(Number);
    const date = new Date();
    date.setHours(hour || 0, minute || 0, 0, 0);
    return date;
  })() : new Date();

  useEffect(() => {
    if (!groupNameCustomized) {
      const name = generatedGroupName();
      if (name) setGroupName(name);
    }
  }, [groupGrade, groupTeacherId, groupSubjectId, teachers, subjects, groupNameCustomized, selectedScheduleDays, scheduleTimes]);

  const loadData = () => {
    try {
      setTeachers(TeacherRepository.getAll());
      setSubjects(SubjectRepository.getAll());
      setGroups(GroupRepository.getAll(true));
      setTodayGroupIds(GroupRepository.getGroupsForDay(new Date().getDay()).map((group) => group.id));
      setTodaySessions(SessionGenerationService.getSessionsForDate(todayStr));
      setAcademicStages(CenterAcademicStageRepository.getStages());
    } catch (e: any) {
      console.error("Academic loadData error:", e);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      if (activeCenterId) {
        await SyncEngine.syncCenterNow(activeCenterId);
      }
    } catch (e) {
      console.warn("Academic onRefresh sync notice:", e);
    } finally {
      loadData();
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
    if (activeCenterId) {
      SyncEngine.syncCenterNow(activeCenterId)
        .then(() => {
          loadData();
        })
        .catch(() => {});
    }
  }, [activeCenterId]);

  // 1. Teachers Actions
  const handleCreateTeacher = () => {
    if (!teacherName.trim()) {
      Alert.alert("تنبيه", "اسم المعلم مطلوب.");
      return;
    }
    try {
      const teacher = editingTeacher
        ? TeacherRepository.updateTeacher(editingTeacher.id, { name: teacherName.trim(), phone: teacherPhone.trim() || undefined, notes: teacherNotes.trim() || undefined })
        : TeacherRepository.createTeacher({ name: teacherName.trim(), phone: teacherPhone.trim() || undefined, notes: teacherNotes.trim() || undefined });
      for (const subject of SubjectRepository.getAll(true)) {
        const assigned = TeacherSubjectRepository.isTeacherAssignedToSubject(teacher.id, subject.id);
        if (teacherSubjectIds.includes(subject.id) && !assigned) TeacherSubjectRepository.assignTeacherToSubject(teacher.id, subject.id);
        if (!teacherSubjectIds.includes(subject.id) && assigned) TeacherSubjectRepository.removeTeacherFromSubject(teacher.id, subject.id);
      }
      Alert.alert("تم بنجاح", "تم إضافة المعلم بنجاح.");
      setIsAddTeacherOpen(false);
      setEditingTeacher(null); setTeacherSubjectIds([]);
      setTeacherName("");
      setTeacherPhone("");
      setTeacherNotes("");
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل إضافة المعلم");
    }
  };

  // 2. Subjects Actions
  const handleCreateSubject = () => {
    if (!subjectName.trim() || !subjectCode.trim()) {
      Alert.alert("تنبيه", "اسم المادة وكود المادة مطلوبان.");
      return;
    }
    try {
      if (editingSubject) SubjectRepository.updateSubject(editingSubject.id, { name: subjectName.trim(), code: subjectCode.trim() });
      else SubjectRepository.createSubject({ name: subjectName.trim(), code: subjectCode.trim() });
      Alert.alert("تم بنجاح", "تم إضافة المادة الدراسية بنجاح.");
      setIsAddSubjectOpen(false);
      setEditingSubject(null);
      setSubjectName("");
      setSubjectCode("");
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل إضافة المادة");
    }
  };

  const openTeacherEditor = (teacher: Teacher) => { setEditingTeacher(teacher); setTeacherName(teacher.name); setTeacherPhone(teacher.phone || ""); setTeacherNotes(teacher.notes || ""); try { setTeacherSubjectIds(TeacherSubjectRepository.getSubjectsForTeacher(teacher.id).map((s) => s.id)); } catch { setTeacherSubjectIds([]); } setIsAddTeacherOpen(true); };
  const openSubjectEditor = (subject: Subject) => { setEditingSubject(subject); setSubjectName(subject.name); setSubjectCode(subject.code); setIsAddSubjectOpen(true); };
  const toggleGroupStatus = (group: Group) => { try { group.status === "active" ? GroupRepository.deactivateGroup(group.id) : GroupRepository.reactivateGroup(group.id); loadData(); Alert.alert("تم بنجاح", "تم تحديث حالة المجموعة."); } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحديث حالة المجموعة."); } };
  const openGroupEditor = (group: Group) => {
    setEditingGroup(group);
    setGroupName(group.name);
    setGroupTeacherId(group.teacherId);
    setGroupSubjectId(group.subjectId);
    setGroupGrade(group.grade);
    setGroupSessionPrice(String(group.sessionPrice));
    setGroupMonthlyPrice(String(group.monthlyPrice));
    setGroupDuration(String(group.sessionDurationMinutes));
    setGroupLateThreshold(String(group.lateAfterMinutes));
    const generated = [group.grade, group.subjectName, group.teacherName].filter(Boolean).join(" - ");
    setGroupNameCustomized(group.name !== generated);
    try {
      const schedules = GroupScheduleRepository.getSchedulesForGroup(group.id);
      setSelectedScheduleDays(schedules.map((schedule) => schedule.dayOfWeek));
      setScheduleTimes(Object.fromEntries(schedules.map((schedule) => [schedule.dayOfWeek, { start: schedule.startTime, end: schedule.endTime }])));
    } catch {
      setSelectedScheduleDays([]);
      setScheduleTimes({});
    }
    setIsAddGroupOpen(true);
  };
  const deleteGroup = (group: Group) => { Alert.alert("تأكيد الحذف", "سيتم الحذف فقط إذا لم توجد تسجيلات.", [{ text: "إلغاء", style: "cancel" }, { text: "حذف", style: "destructive", onPress: () => { try { GroupRepository.deleteGroup(group.id); loadData(); Alert.alert("تم بنجاح", "تم حذف المجموعة."); } catch (e: any) { Alert.alert("لا يمكن الحذف", e?.message || "استخدم التعطيل للحفاظ على السجل."); } } }]); };
  const deleteTeacher = (teacher: Teacher) => { Alert.alert("تأكيد الحذف", "سيتم الحذف فقط إذا لم توجد سجلات مرتبطة.", [{ text: "إلغاء", style: "cancel" }, { text: "حذف", style: "destructive", onPress: () => { try { TeacherRepository.deleteTeacher(teacher.id); loadData(); Alert.alert("تم بنجاح", "تم حذف المدرس."); } catch (e: any) { Alert.alert("لا يمكن الحذف", e?.message || "استخدم التعطيل للحفاظ على السجل."); } } }]); };
  const deleteSubject = (subject: Subject) => { Alert.alert("تأكيد الحذف", "سيتم الحذف فقط إذا لم توجد سجلات مرتبطة.", [{ text: "إلغاء", style: "cancel" }, { text: "حذف", style: "destructive", onPress: () => { try { SubjectRepository.deleteSubject(subject.id); loadData(); Alert.alert("تم بنجاح", "تم حذف المادة."); } catch (e: any) { Alert.alert("لا يمكن الحذف", e?.message || "استخدم التعطيل للحفاظ على السجل."); } } }]); };
  const toggleTeacherStatus = (teacher: Teacher) => { try { teacher.status === "active" ? TeacherRepository.deactivateTeacher(teacher.id) : TeacherRepository.reactivateTeacher(teacher.id); loadData(); Alert.alert("تم بنجاح", "تم تحديث حالة المدرس."); } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحديث حالة المدرس."); } };
  const toggleSubjectStatus = (subject: Subject) => { try { subject.status === "active" ? SubjectRepository.deactivateSubject(subject.id) : SubjectRepository.reactivateSubject(subject.id); loadData(); Alert.alert("تم بنجاح", "تم تحديث حالة المادة."); } catch (e: any) { Alert.alert("خطأ", e?.message || "تعذر تحديث حالة المادة."); } };

  // 3. Groups Actions
  const handleCreateGroup = () => {
    if (selectedScheduleDays.length === 0) {
      Alert.alert("تنبيه", "يرجى اختيار يوم واحد للمجموعة على الأقل.");
      return;
    }
    if (selectedScheduleDays.some((day) => !scheduleTimes[day]?.start || !scheduleTimes[day]?.end || scheduleTimes[day].end <= scheduleTimes[day].start)) {
      Alert.alert("تنبيه", "يجب تحديد وقت صحيح لكل يوم مختار.");
      return;
    }
    if (!groupName.trim() || !groupTeacherId || !groupSubjectId || !groupGrade.trim()) {
      Alert.alert("تنبيه", "يرجى استكمال جميع بيانات المجموعة المطلوبة.");
      return;
    }

    try {
      // First ensure teacher is assigned to subject
      if (
        !TeacherSubjectRepository.isTeacherAssignedToSubject(
          groupTeacherId,
          groupSubjectId,
        )
      ) {
        TeacherSubjectRepository.assignTeacherToSubject(
          groupTeacherId,
          groupSubjectId,
        );
      }

      let savedGroup: Group;
      if (editingGroup) savedGroup = GroupRepository.updateGroup(editingGroup.id, {
        name: groupName.trim(), teacherId: groupTeacherId, subjectId: groupSubjectId, grade: groupGrade.trim(), sessionPrice: parseFloat(groupSessionPrice) || 0, monthlyPrice: parseFloat(groupMonthlyPrice) || 0, sessionDurationMinutes: parseInt(groupDuration, 10) || 120, lateAfterMinutes: parseInt(groupLateThreshold, 10) || 15,
      }); else savedGroup = GroupRepository.createGroup({
        name: groupName.trim(),
        teacherId: groupTeacherId,
        subjectId: groupSubjectId,
        grade: groupGrade.trim(),
        sessionPrice: parseFloat(groupSessionPrice) || 0,
        monthlyPrice: parseFloat(groupMonthlyPrice) || 0,
        sessionDurationMinutes: parseInt(groupDuration, 10) || 120,
        lateAfterMinutes: parseInt(groupLateThreshold, 10) || 15,
      });

      if (editingGroup) {
        for (const schedule of GroupScheduleRepository.getSchedulesForGroup(editingGroup.id)) {
          GroupScheduleRepository.deactivateSchedule(schedule.id);
        }
      }
      for (const day of selectedScheduleDays) {
        const time = scheduleTimes[day];
        GroupScheduleRepository.createSchedule({ groupId: savedGroup.id, dayOfWeek: day, startTime: time.start, endTime: time.end });
      }
      Alert.alert("تم بنجاح", editingGroup ? "تم تحديث المجموعة بنجاح." : "تم إنشاء المجموعة بنجاح.");
      setIsAddGroupOpen(false);
      setEditingGroup(null);
      setGroupName("");
      setGroupNameCustomized(false);
      setSelectedScheduleDays([]);
      setScheduleTimes({});
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل إنشاء المجموعة");
    }
  };

  const openGroupSchedules = (group: Group) => {
    setSelectedGroup(group);
    try {
      const scheds = GroupScheduleRepository.getSchedulesForGroup(group.id);
      setGroupSchedules(scheds);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateSchedule = () => {
    if (!selectedGroup) return;
    if (schedEnd <= schedStart) {
      Alert.alert("خطأ", "وقت الانتهاء يجب أن يكون بعد وقت البدء.");
      return;
    }

    try {
      GroupScheduleRepository.createSchedule({
        groupId: selectedGroup.id,
        dayOfWeek: schedDay,
        startTime: schedStart,
        endTime: schedEnd,
      });

      Alert.alert("تم بنجاح", "تم إضافة الموعد الأسبوعي بنجاح.");
      setIsAddScheduleOpen(false);
      openGroupSchedules(selectedGroup);
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل إضافة الموعد");
    }
  };

  // 4. Session Generation Actions
  const handleGenerateSessions = () => {
    try {
      const created = SessionGenerationService.generateSessionsForRange(
        genFromDate,
        genToDate,
      );
      setGeneratedSessions(created);
      Alert.alert(
        "تم بنجاح",
        `تم توليد (${created.length}) حصة للفترة المحددة بنجاح.`,
      );
      loadData();
    } catch (e: any) {
      Alert.alert("خطأ", e?.message || "فشل توليد الحصص");
    }
  };

  const handleCancelSession = (sessionId: string) => {
    Alert.alert("تأكيد الإلغاء", "هل أنت متأكد من رغبتك في إلغاء هذه الحصة؟", [
      { text: "تراجع", style: "cancel" },
      {
        text: "نعم، إلغاء الحصة",
        style: "destructive",
        onPress: () => {
          try {
            SessionGenerationService.cancelSession(sessionId);
            loadData();
          } catch (e: any) {
            Alert.alert("خطأ", e?.message || "فشل إلغاء الحصة");
          }
        },
      },
    ]);
  };

  const canCreateTeacher = PermissionService.hasPermission(
    permissions,
    "teachers.create",
  );
  const canUpdateTeacher = PermissionService.hasPermission(permissions, "teachers.update");
  const canDeactivateTeacher = PermissionService.hasPermission(permissions, "teachers.deactivate");
  const canCreateSubject = PermissionService.hasPermission(
    permissions,
    "subjects.create",
  );
  const canUpdateSubject = PermissionService.hasPermission(permissions, "subjects.update");
  const canDeactivateSubject = PermissionService.hasPermission(permissions, "subjects.deactivate");
  const canCreateGroup = PermissionService.hasPermission(
    permissions,
    "groups.create",
  );
  const canUpdateGroup = PermissionService.hasPermission(permissions, "groups.update");
  const canDeactivateGroup = PermissionService.hasPermission(permissions, "groups.deactivate");
  const canGenSessions = PermissionService.hasPermission(
    permissions,
    "sessions.generate",
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{Strings.tabAcademic}</Text>
        {PermissionService.hasPermission(permissions, "packages.view") && (
          <TouchableOpacity style={styles.headerPackagesButton} onPress={() => router.push("/(main)/packages") }>
            <Ionicons name="pricetags-outline" size={18} color={Colors.white} />
            <Text style={styles.headerPackagesText}>الباقات</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Segmented Control Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === "teachers" && styles.tabButtonActive,
          ]}
          onPress={() => setActiveTab("teachers")}
        >
          <Text
            style={[
              styles.tabButtonText,
              activeTab === "teachers" && styles.tabButtonTextActive,
            ]}
          >
            المعلمون
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === "subjects" && styles.tabButtonActive,
          ]}
          onPress={() => setActiveTab("subjects")}
        >
          <Text
            style={[
              styles.tabButtonText,
              activeTab === "subjects" && styles.tabButtonTextActive,
            ]}
          >
            المواد
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === "groups" && styles.tabButtonActive,
          ]}
          onPress={() => setActiveTab("groups")}
        >
          <Text
            style={[
              styles.tabButtonText,
              activeTab === "groups" && styles.tabButtonTextActive,
            ]}
          >
            المجموعات
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, activeTab === "stages" && styles.tabButtonActive]} onPress={() => setActiveTab("stages")}>
          <Text style={[styles.tabButtonText, activeTab === "stages" && styles.tabButtonTextActive]}>المراحل</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        {/* TAB 1: TEACHERS */}
        {activeTab === "teachers" && (
          <View style={{ flex: 1 }}>
            <View style={styles.tabActionHeader}>
              <Text style={styles.tabActionTitle}>
                قائمة المعلمين ({teachers.length})
              </Text>
              {canCreateTeacher && (
                <TouchableOpacity
                  style={styles.addButton}
                  onPress={() => setIsAddTeacherOpen(true)}
                >
                  <Ionicons name="add" size={18} color={Colors.white} />
                  <Text style={styles.addButtonText}>إضافة معلم</Text>
                </TouchableOpacity>
              )}
            </View>

            <FlatList
              data={teachers}
              keyExtractor={(item) => item.id}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  colors={[Colors.primary]}
                  tintColor={Colors.primary}
                />
              }
              ListEmptyComponent={
                <EmptyState message="لا يوجد معلمون مسجلون" />
              }
              renderItem={({ item }) => (
                <AppCard style={styles.itemCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.itemMeta}>
                      {item.phone || "بدون رقم هاتف"}
                    </Text>
                    {item.notes && (
                      <Text style={styles.itemNotes}>{item.notes}</Text>
                    )}
                  </View>
                  <StatusBadge
                    text={item.status === "active" ? "نشط" : "معطل"}
                    type={item.status === "active" ? "success" : "neutral"}
                  />
                  {(canUpdateTeacher || canDeactivateTeacher) && <View style={styles.itemActions}>
                    {canUpdateTeacher && <TouchableOpacity onPress={() => openTeacherEditor(item)}><Ionicons name="create-outline" size={20} color={Colors.primary} /></TouchableOpacity>}
                    {canDeactivateTeacher && <TouchableOpacity onPress={() => toggleTeacherStatus(item)}><Ionicons name={item.status === "active" ? "pause-circle-outline" : "play-circle-outline"} size={20} color={item.status === "active" ? Colors.danger : Colors.success} /></TouchableOpacity>}
                    {canDeactivateTeacher && <TouchableOpacity onPress={() => deleteTeacher(item)}><Ionicons name="trash-outline" size={20} color={Colors.danger} /></TouchableOpacity>}
                  </View>}
                </AppCard>
              )}
            />
          </View>
        )}

        {/* TAB 2: SUBJECTS */}
        {activeTab === "subjects" && (
          <View style={{ flex: 1 }}>
            <View style={styles.tabActionHeader}>
              <Text style={styles.tabActionTitle}>
                المواد الدراسية ({subjects.length})
              </Text>
              {canCreateSubject && (
                <TouchableOpacity
                  style={styles.addButton}
                  onPress={() => setIsAddSubjectOpen(true)}
                >
                  <Ionicons name="add" size={18} color={Colors.white} />
                  <Text style={styles.addButtonText}>إضافة مادة</Text>
                </TouchableOpacity>
              )}
            </View>

            <FlatList
              data={subjects}
              keyExtractor={(item) => item.id}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  colors={[Colors.primary]}
                  tintColor={Colors.primary}
                />
              }
              ListEmptyComponent={<EmptyState message="لا توجد مواد مسجلة" />}
              renderItem={({ item }) => (
                <AppCard style={styles.itemCard}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.codeBadge}>الكود: {item.code}</Text>
                  </View>
                  <StatusBadge
                    text={item.status === "active" ? "نشطة" : "معطلة"}
                    type={item.status === "active" ? "success" : "neutral"}
                  />
                  {(canUpdateSubject || canDeactivateSubject) && <View style={styles.itemActions}>
                    {canUpdateSubject && <TouchableOpacity onPress={() => openSubjectEditor(item)}><Ionicons name="create-outline" size={20} color={Colors.primary} /></TouchableOpacity>}
                    {canDeactivateSubject && <TouchableOpacity onPress={() => toggleSubjectStatus(item)}><Ionicons name={item.status === "active" ? "pause-circle-outline" : "play-circle-outline"} size={20} color={item.status === "active" ? Colors.danger : Colors.success} /></TouchableOpacity>}
                    {canDeactivateSubject && <TouchableOpacity onPress={() => deleteSubject(item)}><Ionicons name="trash-outline" size={20} color={Colors.danger} /></TouchableOpacity>}
                  </View>}
                </AppCard>
              )}
            />
          </View>
        )}

        {/* TAB 3: GROUPS */}
        {activeTab === "groups" && (
          <View style={{ flex: 1 }}>
            <View style={styles.tabActionHeader}>
              <Text style={styles.tabActionTitle}>
                المجموعات الدراسية ({groups.length})
              </Text>
              {canCreateGroup && (
                <TouchableOpacity
                  style={styles.addButton}
                  onPress={() => {
                    setEditingGroup(null);
                    setGroupName("");
                    setGroupNameCustomized(false);
                    setSelectedScheduleDays([]);
                    setScheduleTimes({});
                    setIsAddGroupOpen(true);
                  }}
                >
                  <Ionicons name="add" size={18} color={Colors.white} />
                  <Text style={styles.addButtonText}>مجموعة جديدة</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.groupFilterRow}>
              <TouchableOpacity style={[styles.filterChip, !showTodayGroups && styles.filterChipActive]} onPress={() => setShowTodayGroups(false)}>
                <Text style={[styles.filterChipText, !showTodayGroups && styles.filterChipTextActive]}>كل المجموعات</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.filterChip, showTodayGroups && styles.filterChipActive]} onPress={() => setShowTodayGroups(true)}>
                <Text style={[styles.filterChipText, showTodayGroups && styles.filterChipTextActive]}>مجموعات اليوم</Text>
              </TouchableOpacity>
            </View>
            <AppInput label="بحث/فلترة بالمدرس" placeholder="اكتب اسم المدرس" value={teacherSearch} onChangeText={setTeacherSearch} containerStyle={styles.groupTeacherSearch} />
            <ScrollView horizontal style={{ marginBottom: Spacing.sm }}>
              <TouchableOpacity style={[styles.filterChip, !groupTeacherFilter && styles.filterChipActive]} onPress={() => setGroupTeacherFilter("")}><Text style={[styles.filterChipText, !groupTeacherFilter && styles.filterChipTextActive]}>كل المدرسين</Text></TouchableOpacity>
              {filteredTeachers.map((teacher) => <TouchableOpacity key={teacher.id} style={[styles.filterChip, groupTeacherFilter === teacher.id && styles.filterChipActive]} onPress={() => setGroupTeacherFilter(teacher.id)}><Text style={[styles.filterChipText, groupTeacherFilter === teacher.id && styles.filterChipTextActive]}>{teacher.name}</Text></TouchableOpacity>)}
            </ScrollView>

            <FlatList
              data={(showTodayGroups ? groups.filter((group) => todayGroupIds.includes(group.id)) : groups).filter((group) => !groupTeacherFilter || group.teacherId === groupTeacherFilter)}
              keyExtractor={(item) => item.id}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  colors={[Colors.primary]}
                  tintColor={Colors.primary}
                />
              }
              ListEmptyComponent={
                <EmptyState message="لا توجد مجموعات مسجلة" />
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => router.push({ pathname: "/(main)/group-details", params: { groupId: item.id } })}
                >
                  <AppCard style={styles.itemCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{item.name}</Text>
                      <Text style={styles.itemMeta}>
                        {item.teacherName} • {item.subjectName} • {item.grade}
                      </Text>
                      <View style={styles.priceRow}>
                        <Text style={styles.priceTag}>
                          حصة: {item.sessionPrice} ج.م
                        </Text>
                        <Text style={styles.priceTag}>
                          شهر: {item.monthlyPrice} ج.م
                        </Text>
                        <Text style={styles.priceTag}>
                          تأخير: {item.lateAfterMinutes} د
                        </Text>
                      </View>
                    </View>
                    <Ionicons
                      name="chevron-back"
                      size={20}
                      color={Colors.slate400}
                    />
                    {(canUpdateGroup || canDeactivateGroup) && <View style={styles.itemActions}>
                      {canUpdateGroup && <TouchableOpacity onPress={(e) => { e.stopPropagation(); openGroupEditor(item); }}><Ionicons name="create-outline" size={20} color={Colors.primary} /></TouchableOpacity>}
                      {canDeactivateGroup && <TouchableOpacity onPress={(e) => { e.stopPropagation(); toggleGroupStatus(item); }}><Ionicons name={item.status === "active" ? "pause-circle-outline" : "play-circle-outline"} size={20} color={item.status === "active" ? Colors.danger : Colors.success} /></TouchableOpacity>}
                      {canDeactivateGroup && <TouchableOpacity onPress={(e) => { e.stopPropagation(); deleteGroup(item); }}><Ionicons name="trash-outline" size={20} color={Colors.danger} /></TouchableOpacity>}
                    </View>}
                  </AppCard>
                </TouchableOpacity>
              )}
            />
          </View>
        )}

        {/* TAB 4: CENTER ACADEMIC STAGES */}
        {activeTab === "stages" && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: Spacing.xl }}>
            <AppCard style={styles.generatorCard}>
              <Text style={styles.sectionHeaderTitle}>المراحل الدراسية التي يقدمها السنتر</Text>
              <Text style={styles.generatorDesc}>اختر المراحل المتاحة عند تسجيل الطلاب. الصفوف التابعة لكل مرحلة جاهزة تلقائيًا.</Text>
              {academicStages.map((stage) => <TouchableOpacity key={stage.id} style={[styles.stageSelectCard, stage.grades.length > 0 && styles.stageSelectCardActive]} onPress={() => setAcademicStages((current) => current.map((item) => item.id === stage.id ? { ...item, grades: item.grades.length > 0 ? [] : [...(DEFAULT_ACADEMIC_STAGES.find((defaultStage) => defaultStage.id === stage.id)?.grades || [])] } : item))}>
                <Text style={styles.stageCardName}>{stage.grades.length > 0 ? "✓ " : "□ "}{stage.label}</Text>
                <Text style={styles.stageCardGrades}>{stage.grades.length > 0 ? stage.grades.join(" • ") : "غير مفعلة"}</Text>
              </TouchableOpacity>)}
              <AppButton title="حفظ مراحل السنتر" onPress={() => { try { CenterAcademicStageRepository.saveStages(academicStages); Alert.alert("تم بنجاح", "تم حفظ المراحل الدراسية للسنتر."); } catch (error: any) { Alert.alert("خطأ", error?.message || "تعذر حفظ المراحل."); } }} />
            </AppCard>
          </ScrollView>
        )}

        {/* TAB 4: SESSIONS & GENERATION (disabled; attendance starts sessions automatically) */}
        {false && (
          <ScrollView style={{ flex: 1 }}>
            {/* Session Generation Box */}
            {false && <AppCard style={styles.generatorCard}>
              <View style={styles.generatorHeader}>
                <Ionicons
                  name="calendar-outline"
                  size={20}
                  color={Colors.primary}
                />
                <Text style={styles.generatorTitle}>
                  توليد الحصص والمحاضرات آلياً
                </Text>
              </View>
              <Text style={styles.generatorDesc}>
                يتم توليد الحصص بناءً على جداول المجموعات وتثبيت لقطة تاريخية
                للمادة، المعلم، الأسعار، وقائمة الطلاب المتوقعين.
              </Text>

              <View
                style={{
                  flexDirection: "row",
                  gap: 10,
                  marginVertical: Spacing.sm,
                }}
              >
                <AppInput
                  label="من تاريخ"
                  value={genFromDate}
                  onChangeText={setGenFromDate}
                  containerStyle={{ flex: 1 }}
                />
                <AppInput
                  label="إلى تاريخ"
                  value={genToDate}
                  onChangeText={setGenToDate}
                  containerStyle={{ flex: 1 }}
                />
              </View>

              {canGenSessions && (
                <AppButton
                  title="توليد حصص الفترة المحددة"
                  onPress={handleGenerateSessions}
                  style={{ marginTop: Spacing.xs }}
                />
              )}
            </AppCard>}

            {/* Today's Sessions List */}
            <View style={{ marginTop: Spacing.lg }}>
              <Text style={styles.sectionHeaderTitle}>
                حصص اليوم ({todaySessions.length})
              </Text>
              {todaySessions.length === 0 ? (
                <EmptyState message="لا توجد حصص مجدولة لليوم" />
              ) : (
                todaySessions.map((s) => (
                  <AppCard key={s.id} style={styles.sessionCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sessionGroupName}>{s.groupName}</Text>
                      <Text style={styles.sessionMeta}>
                        {s.teacherName} • {s.subjectName}
                      </Text>
                      <Text style={styles.sessionTime}>
                        الموعد: {s.startTime} - {s.endTime} • السعر:{" "}
                        {s.sessionPrice} ج.م
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 8 }}>
                      <StatusBadge
                        text={
                          s.status === "open"
                            ? "مفتوحة"
                            : s.status === "cancelled"
                              ? "ملغاة"
                              : "مغلقة"
                        }
                        type={
                          s.status === "open"
                            ? "success"
                            : s.status === "cancelled"
                              ? "danger"
                              : "neutral"
                        }
                      />
                      {s.status === "open" && (
                        <TouchableOpacity
                          onPress={() => handleCancelSession(s.id)}
                          style={styles.cancelSessionBtn}
                        >
                          <Text style={styles.cancelSessionBtnText}>
                            إلغاء الحصة
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </AppCard>
                ))
              )}
            </View>
          </ScrollView>
        )}
      </View>

      {/* Add Teacher Modal */}
      <Modal visible={isAddTeacherOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editingTeacher ? "تعديل بيانات المدرس" : "إضافة معلم جديد"}</Text>
            <AppInput
              label="اسم المعلم *"
              placeholder="مثال: أ/ حسام البدري"
              value={teacherName}
              onChangeText={setTeacherName}
              containerStyle={styles.formField}
            />
            <AppInput
              label="رقم الهاتف"
              placeholder="010xxxxxxxx"
              value={teacherPhone}
              onChangeText={setTeacherPhone}
              keyboardType="phone-pad"
              containerStyle={styles.formField}
            />
            <AppInput
              label="ملاحظات"
              placeholder="ملاحظات..."
              value={teacherNotes}
              onChangeText={setTeacherNotes}
              containerStyle={styles.formField}
            />
            <Text style={styles.inputLabel}>المواد التي يدرسها</Text>
            <ScrollView horizontal style={{ marginBottom: Spacing.sm }}>
              {subjects.filter((s) => s.status === "active").map((subject) => <TouchableOpacity key={subject.id} style={[styles.chip, teacherSubjectIds.includes(subject.id) && styles.chipActive]} onPress={() => setTeacherSubjectIds((ids) => ids.includes(subject.id) ? ids.filter((id) => id !== subject.id) : [...ids, subject.id])}><Text style={[styles.chipText, teacherSubjectIds.includes(subject.id) && styles.chipTextActive]}>{subject.name}</Text></TouchableOpacity>)}
            </ScrollView>
            <View
              style={{ flexDirection: "row", gap: 8, marginTop: Spacing.md }}
            >
              <AppButton
                title={editingTeacher ? "حفظ التعديل" : "حفظ"}
                onPress={handleCreateTeacher}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsAddTeacherOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Add Subject Modal */}
      <Modal visible={isAddSubjectOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editingSubject ? "تعديل المادة" : "إضافة مادة دراسية"}</Text>
            <AppInput
              label="اسم المادة *"
              placeholder="مثال: كيمياء"
              value={subjectName}
              onChangeText={setSubjectName}
              containerStyle={styles.formField}
            />
            <AppInput
              label="كود المادة *"
              placeholder="مثال: CHEM"
              value={subjectCode}
              onChangeText={setSubjectCode}
              containerStyle={styles.formField}
            />
            <View
              style={{ flexDirection: "row", gap: 8, marginTop: Spacing.md }}
            >
              <AppButton
                title={editingSubject ? "حفظ التعديل" : "حفظ"}
                onPress={handleCreateSubject}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsAddSubjectOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      {/* Add Group Modal */}
      <Modal visible={isAddGroupOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <ScrollView style={{ maxHeight: 520 }}>
              <Text style={styles.modalTitle}>{editingGroup ? "تعديل المجموعة" : "إنشاء مجموعة دراسية جديدة"}</Text>

              <AppInput
                label="اسم المجموعة *"
                placeholder="مثال: فيزياء - 3 ثانوي (مجموعة أ)"
                value={groupName}
                onChangeText={(value) => { setGroupNameCustomized(true); setGroupName(value); }}
                containerStyle={styles.formField}
              />

              <Text style={styles.inputLabel}>المعلم المسؤول *:</Text>
              <AppInput label="بحث عن مدرس" value={teacherSearch} onChangeText={setTeacherSearch} containerStyle={styles.formField} />
              <ScrollView horizontal style={{ marginBottom: Spacing.sm }}>
                {filteredTeachers.map((t) => (
                  <TouchableOpacity
                    key={t.id}
                    style={[
                      styles.chip,
                      groupTeacherId === t.id && styles.chipActive,
                    ]}
                    onPress={() => setGroupTeacherId(t.id)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        groupTeacherId === t.id && styles.chipTextActive,
                      ]}
                    >
                      {t.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={styles.inputLabel}>المادة الدراسية *:</Text>
              <ScrollView horizontal style={{ marginBottom: Spacing.sm }}>
                {subjects.map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    style={[
                      styles.chip,
                      groupSubjectId === s.id && styles.chipActive,
                    ]}
                    onPress={() => setGroupSubjectId(s.id)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        groupSubjectId === s.id && styles.chipTextActive,
                      ]}
                    >
                      {s.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <AppInput
                label="المرحلة الدراسية *"
                value={groupGrade}
                onChangeText={setGroupGrade}
                containerStyle={styles.formField}
              />

              <Text style={styles.inputLabel}>أيام وجدول المجموعة *</Text>
              <View style={styles.weekDaysGrid}>
                {DAYS_OF_WEEK.map((day, index) => {
                  const selected = selectedScheduleDays.includes(index);
                  return (
                    <TouchableOpacity
                      key={day}
                      style={[styles.weekDayChip, selected && styles.weekDayChipActive]}
                      onPress={() => {
                        setSelectedScheduleDays((current) => selected ? current.filter((item) => item !== index) : [...current, index]);
                        if (!scheduleTimes[index]) setScheduleTimes((current) => ({ ...current, [index]: { start: "17:00", end: "19:00" } }));
                      }}
                    >
                      <Text style={[styles.weekDayText, selected && styles.weekDayTextActive]}>{day}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {selectedScheduleDays.slice().sort((a, b) => a - b).map((day) => (
                <View key={day} style={styles.dayTimeRow}>
                  <Text style={styles.dayTimeLabel}>{DAYS_OF_WEEK[day]}</Text>
                  {(["start", "end"] as const).map((field) => (
                    <TouchableOpacity key={field} style={styles.timePickerButton} onPress={() => openTimePicker(day, field)}>
                      <Text style={styles.timePickerLabel}>{field === "start" ? "من" : "إلى"}</Text>
                      <Text style={styles.timePickerValue}>{formatTimeForName(scheduleTimes[day]?.[field] || (field === "start" ? "17:00" : "19:00"))}</Text>
                      <Ionicons name="time-outline" size={16} color={Colors.primary} />
                    </TouchableOpacity>
                  ))}
                </View>
              ))}

              <View style={{ flexDirection: "row", gap: 8 }}>
                <AppInput
                  label="سعر الحصة (ج.م)"
                  value={groupSessionPrice}
                  onChangeText={setGroupSessionPrice}
                  keyboardType="numeric"
                  inputKind="decimal"
                  containerStyle={{ flex: 1 }}
                />
                <AppInput
                  label="الاشتراك الشهري (ج.م)"
                  value={groupMonthlyPrice}
                  onChangeText={setGroupMonthlyPrice}
                  keyboardType="numeric"
                  inputKind="decimal"
                  containerStyle={{ flex: 1 }}
                />
              </View>

              <View
                style={{ flexDirection: "row", gap: 8, marginTop: Spacing.sm }}
              >
                <AppInput
                  label="مدة الحصة (دقيقة)"
                  value={groupDuration}
                  onChangeText={setGroupDuration}
                  keyboardType="numeric"
                  inputKind="integer"
                  containerStyle={{ flex: 1 }}
                />
                <AppInput
                  label="مهلة التأخير (دقيقة)"
                  value={groupLateThreshold}
                  onChangeText={setGroupLateThreshold}
                  keyboardType="numeric"
                  inputKind="integer"
                  containerStyle={{ flex: 1 }}
                />
              </View>
            </ScrollView>

            <View
              style={{ flexDirection: "row", gap: 8, marginTop: Spacing.md }}
            >
              <AppButton
                title={editingGroup ? "حفظ التعديل" : "إنشاء المجموعة"}
                onPress={handleCreateGroup}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsAddGroupOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!timePicker} animationType="fade" transparent onRequestClose={() => setTimePicker(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.timePickerCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>اختيار الوقت</Text>
              <TouchableOpacity onPress={() => setTimePicker(null)}><Ionicons name="close" size={24} color={Colors.slate500} /></TouchableOpacity>
            </View>
            <Text style={styles.modalSubtitle}>اختر الساعة والدقيقة من القوائم</Text>
            <DateTimePicker
              value={pickerDate}
              mode="time"
              presentation="dialog"
              onValueChange={(_event: unknown, selectedDate?: Date) => {
                if (!selectedDate || !timePicker) return;
                const value = `${String(selectedDate.getHours()).padStart(2, "0")}:${String(selectedDate.getMinutes()).padStart(2, "0")}`;
                setScheduleTimes((current) => ({ ...current, [timePicker.day]: { ...(current[timePicker.day] || { start: "17:00", end: "19:00" }), [timePicker.field]: value } }));
                setTimePicker(null);
              }}
            />
            {false && <View style={styles.timeColumns}>
              <ScrollView style={styles.timeColumn} contentContainerStyle={styles.timeColumnContent}>
                {Array.from({ length: 24 }, (_, hour) => (
                  <TouchableOpacity key={hour} style={[styles.timeOption, timeDraftHour === hour && styles.timeOptionActive]} onPress={() => setTimeDraftHour(hour)}>
                    <Text style={styles.timeOptionText}>{String(hour).padStart(2, "0")}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <Text style={styles.timeSeparator}>:</Text>
              <ScrollView style={styles.timeColumn} contentContainerStyle={styles.timeColumnContent}>
                {[0, 15, 30, 45].map((minute) => (
                  <TouchableOpacity key={minute} style={[styles.timeOption, timeDraftMinute === minute && styles.timeOptionActive]} onPress={() => setTimeDraftMinute(minute)}>
                    <Text style={styles.timeOptionText}>{String(minute).padStart(2, "0")}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>}
            <AppButton title="تأكيد الوقت" onPress={() => selectTime(timeDraftHour, timeDraftMinute)} />
            <AppButton title="إلغاء" variant="outline" onPress={() => setTimePicker(null)} style={{ marginTop: Spacing.sm }} />
          </View>
        </View>
      </Modal>

      {/* Group Details & Weekly Schedules Modal */}
      {selectedGroup && (
        <Modal visible={!!selectedGroup} animationType="slide" transparent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.modalTitle}>{selectedGroup.name}</Text>
                  <Text style={styles.modalSubtitle}>
                    {selectedGroup.teacherName} • {selectedGroup.subjectName}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => setSelectedGroup(null)}>
                  <Ionicons name="close" size={24} color={Colors.slate500} />
                </TouchableOpacity>
              </View>

              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: Spacing.sm,
                }}
              >
                <Text style={styles.sectionHeaderTitle}>
                  المواعيد الأسبوعية
                </Text>
                <TouchableOpacity
                  style={styles.smallActionBtn}
                  onPress={() => setIsAddScheduleOpen(true)}
                >
                  <Ionicons name="add" size={14} color={Colors.white} />
                  <Text style={styles.smallActionBtnText}>إضافة موعد</Text>
                </TouchableOpacity>
              </View>

              <ScrollView style={{ maxHeight: 250 }}>
                {groupSchedules.length === 0 ? (
                  <Text style={styles.emptyText}>
                    لم يتم تحديد مواعيد أسبوعية لهذه المجموعة بعد.
                  </Text>
                ) : (
                  groupSchedules.map((sched) => (
                    <View key={sched.id} style={styles.schedItem}>
                      <Text style={styles.schedDay}>
                        {DAYS_OF_WEEK[sched.dayOfWeek]}
                      </Text>
                      <Text style={styles.schedTime}>
                        {sched.startTime} - {sched.endTime}
                      </Text>
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

      {/* Add Schedule Modal */}
      <Modal visible={isAddScheduleOpen} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.smallModalCard}>
            <Text style={styles.modalTitle}>إضافة موعد أسبوعي</Text>
            <Text style={styles.inputLabel}>يوم الأسبوع:</Text>
            <ScrollView horizontal style={{ marginBottom: Spacing.md }}>
              {DAYS_OF_WEEK.map((day, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={[styles.chip, schedDay === idx && styles.chipActive]}
                  onPress={() => setSchedDay(idx)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      schedDay === idx && styles.chipTextActive,
                    ]}
                  >
                    {day}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View
              style={{ flexDirection: "row", gap: 8, marginBottom: Spacing.md }}
            >
              <AppInput
                label="وقت البدء (HH:MM)"
                value={schedStart}
                onChangeText={setSchedStart}
                containerStyle={{ flex: 1 }}
              />
              <AppInput
                label="وقت الانتهاء (HH:MM)"
                value={schedEnd}
                onChangeText={setSchedEnd}
                containerStyle={{ flex: 1 }}
              />
            </View>

            <View style={{ flexDirection: "row", gap: 8 }}>
              <AppButton
                title="إضافة الموعد"
                onPress={handleCreateSchedule}
                style={{ flex: 1 }}
              />
              <AppButton
                title="إلغاء"
                variant="outline"
                onPress={() => setIsAddScheduleOpen(false)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    ...Typography.h2,
    color: Colors.slate900,
    fontWeight: "700",
  },
  headerPackagesButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  headerPackagesText: { color: Colors.white, fontWeight: "700" },
  tabBar: {
    flexDirection: "row",
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingHorizontal: Spacing.sm,
  },
  tabButton: {
    flex: 1,
    paddingVertical: Spacing.sm,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabButtonActive: {
    borderBottomColor: Colors.primary,
  },
  tabButtonText: {
    fontSize: 13,
    color: Colors.slate500,
    fontWeight: "600",
  },
  tabButtonTextActive: {
    color: Colors.primary,
    fontWeight: "700",
  },
  content: {
    flex: 1,
    padding: Spacing.lg,
  },
  tabActionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.md,
  },
  tabActionTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.slate800,
  },
  addButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  addButtonText: {
    color: Colors.white,
    fontSize: 12,
    fontWeight: "600",
  },
  itemCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  itemActions: { flexDirection: "row", alignItems: "center", gap: 10, marginLeft: 8 },
  itemName: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.slate900,
  },
  itemMeta: {
    fontSize: 12,
    color: Colors.slate500,
    marginTop: 2,
  },
  itemNotes: {
    fontSize: 11,
    color: Colors.slate400,
    marginTop: 2,
  },
  codeBadge: {
    fontSize: 11,
    fontWeight: "700",
    color: Colors.primary,
    backgroundColor: Colors.primaryLight + "20",
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 4,
  },
  priceRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
  },
  priceTag: {
    fontSize: 11,
    color: Colors.slate600,
    backgroundColor: Colors.slate100,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  generatorCard: {
    padding: Spacing.md,
    backgroundColor: Colors.white,
    borderColor: Colors.primaryLight + "40",
  },
  generatorHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  generatorTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.primaryDark,
  },
  generatorDesc: {
    fontSize: 12,
    color: Colors.slate600,
    lineHeight: 18,
    marginBottom: Spacing.sm,
  },
  stageSelectCard: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.slate50,
  },
  stageSelectCardActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight + "18",
  },
  stageCardName: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.slate900,
  },
  stageCardGrades: {
    fontSize: 11,
    color: Colors.slate600,
    marginTop: 4,
    lineHeight: 18,
  },
  sectionHeaderTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.slate800,
    marginBottom: Spacing.sm,
  },
  sessionCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  sessionGroupName: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.slate900,
  },
  sessionMeta: {
    fontSize: 12,
    color: Colors.slate500,
    marginTop: 2,
  },
  sessionTime: {
    fontSize: 11,
    color: Colors.slate700,
    fontWeight: "600",
    marginTop: 4,
  },
  cancelSessionBtn: {
    backgroundColor: Colors.dangerLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  cancelSessionBtnText: {
    color: Colors.danger,
    fontSize: 11,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: Spacing.lg,
  },
  modalCard: {
    width: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
  },
  smallModalCard: {
    width: "100%",
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: Spacing.lg,
  },
  modalTitle: {
    ...Typography.h2,
    fontWeight: "700",
    color: Colors.slate900,
    marginBottom: Spacing.md,
  },
  modalSubtitle: {
    fontSize: 12,
    color: Colors.slate500,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.md,
  },
  formField: {
    marginBottom: Spacing.sm,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.slate700,
    marginBottom: 4,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Colors.slate100,
    marginRight: 6,
  },
  chipActive: {
    backgroundColor: Colors.primary,
  },
  chipText: {
    fontSize: 12,
    color: Colors.slate700,
  },
  chipTextActive: {
    color: Colors.white,
    fontWeight: "700",
  },
  weekDaysGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: Spacing.sm,
  },
  groupFilterRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: Spacing.sm,
  },
  groupTeacherSearch: { marginBottom: Spacing.xs },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.slate200,
    backgroundColor: Colors.white,
  },
  filterChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  filterChipText: {
    fontSize: 12,
    color: Colors.slate600,
  },
  filterChipTextActive: {
    color: Colors.white,
    fontWeight: "700",
  },
  weekDayChip: {
    width: "30%",
    alignItems: "center",
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.slate200,
    backgroundColor: Colors.slate50,
  },
  weekDayChipActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  weekDayText: {
    fontSize: 12,
    color: Colors.slate700,
  },
  weekDayTextActive: {
    color: Colors.white,
    fontWeight: "700",
  },
  dayTimeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: Spacing.sm,
  },
  dayTimeLabel: {
    width: 58,
    fontSize: 11,
    fontWeight: "700",
    color: Colors.slate700,
    textAlign: "right",
  },
  timePickerButton: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderColor: Colors.slate200,
    borderRadius: 10,
    paddingHorizontal: 8,
    justifyContent: "center",
    backgroundColor: Colors.white,
  },
  timePickerLabel: { fontSize: 10, color: Colors.slate500 },
  timePickerValue: { fontSize: 14, fontWeight: "700", color: Colors.slate800, marginTop: 2 },
  timePickerCard: { width: "90%", maxHeight: "75%", backgroundColor: Colors.white, borderRadius: 18, padding: Spacing.lg },
  timeColumns: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginVertical: Spacing.md },
  timeColumn: { height: 220, width: 100 },
  timeColumnContent: { alignItems: "center", paddingVertical: 4 },
  timeOption: { width: 76, paddingVertical: 10, alignItems: "center", borderRadius: 10, marginBottom: 4 },
  timeOptionActive: { backgroundColor: Colors.primaryLight },
  timeOptionText: { fontSize: 18, fontWeight: "700", color: Colors.slate800 },
  timeSeparator: { fontSize: 26, fontWeight: "800", color: Colors.primary, marginHorizontal: 4 },
  dayTimeInput: {
    flex: 1,
    marginBottom: 0,
  },
  smallActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  smallActionBtnText: {
    color: Colors.white,
    fontSize: 11,
    fontWeight: "600",
  },
  emptyText: {
    fontSize: 12,
    color: Colors.slate400,
    fontStyle: "italic",
    marginVertical: 8,
  },
  schedItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: Colors.slate50,
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
  },
  schedDay: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.slate800,
  },
  schedTime: {
    fontSize: 13,
    color: Colors.slate600,
  },
});

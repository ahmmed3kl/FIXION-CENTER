# FIXION — نظام إدارة المراكز التعليمية (Mobile App)

تطبيق موبايل احترافي موجه لإدارة وتشغيل المراكز التعليمية (Educational Centers Management)، مصمم ومبني ليعمل بكفاءة عالية وبدون انقطاع وفق مبدأ **Offline-First**.

---

## 1. التقنيات الأساسية (Tech Stack)

- **Framework:** React Native + Expo (أحدث إصدار مستقر Expo SDK 57)
- **Language:** TypeScript (Strict Mode)
- **Routing:** Expo Router (File-based routing)
- **Client State:** Zustand (إدارة جلسة المستخدم، المركز النشط، التوثيق)
- **Server State:** TanStack Query (لإدارة الكاش والمزامنة المستقبلية)
- **Local Storage:**
  - **SQLite (expo-sqlite):** قاعدة البيانات المحلية والمفهرسة، وتخزين طابور العمليات وسجل المراجعة.
  - **Expo SecureStore:** التخزين الآمن المشفر لجلسة المستخدم، الـ Tokens، ومعرف الجهاز الثابت (`device_id`).
- **Hardware / Scanner:** `expo-camera` لقراءة باركود وكيوآر كروت الطلاب، مع دعم الإدخال اليدوي.
- **Forms & Validation:** React Hook Form + Zod.
- **Networking:** Axios مع طبقة `ApiClient` ومحولات أخطاء وتوثيق.
- **Testing:** Jest + ts-jest.

---

## 2. بنية المشروع (Clean Architecture)

تم اعتماد معمارية طبقية تفصل الواجهات (`UI`) تمامًا عن قواعد البيانات وقواعد العمل (`Business Logic`):

```text
UI (Screens / Components)
  ↓
Hooks / Use Cases / Domain Services
  ↓
Repositories
  ↓
Local Data Source (SQLite) & Remote Data Source (ApiClient)
  ↓
Sync Queue (sync_operations) & Audit Log (audit_logs)
```

### هيكل المجلدات:

```text
src/
├── app/
│   ├── _layout.tsx                     # Root Layout (Theme, QueryClient, Auth Guard)
│   ├── (auth)/
│   │   ├── _layout.tsx
│   │   ├── login.tsx                   # تسجيل الدخول مع حسابات تجريبية
│   │   └── select-center.tsx           # اختيار وتبديل المركز النشط
│   └── (main)/
│       ├── _layout.tsx                 # شريط التبويبات الرئيسي (RTL)
│       ├── index.tsx                   # لوحة التحكم (إحصائيات الحضور والتحصيل وزر المسح)
│       ├── scanner.tsx                 # مسح الكارت + الحصص المؤهلة + الحضور + الموقف المالي
│       └── students.tsx                # قائمة الطلاب المفهرسة للمركز النشط
│
├── core/
│   ├── theme/                          # نظام الألوان، مقاييس الخطوط، المسافات، ThemeProvider
│   ├── localization/                   # دعم RTL الكامل، القاموس العربي الموحد (ar.ts)، التنسيقات
│   ├── storage/                        # SecureStorageService (Session tokens, device_id)
│   ├── device/                         # DeviceService (توليد وحفظ device_id ثابت)
│   ├── database/                       # DatabaseService (SQLite، المخطط، القيود الفريدة، التغذية)
│   ├── permissions/                    # PermissionService، مصفوفة الصلاحيات، PermissionGate
│   ├── sync/                           # SyncRepository، SyncEngine، طابور sync_operations
│   ├── audit/                          # AuditService لتسجيل الأحداث الحساسة في audit_logs
│   ├── connectivity/                   # ConnectivityService (online, offline, syncing, degraded)
│   ├── api/                            # ApiClient واجهة مجردة جاهزة لربط الـ Backend المستقبلي
│   └── errors/                         # هرمية أخطاء AppError والترجمة العربية
│
├── features/
│   ├── auth/                           # useAuthStore (Zustand: المستخدم الحالي، المركز النشط)
│   ├── dashboard/                      # DashboardService وحسابات الطلاب المتوقعين
│   ├── scanner/                        # ScannerService (تطبيع الكارت، كشف التأخير)
│   ├── attendance/                     # AttendanceRepository (تسجيل الحضور أوفلاين + مزامنة + تدقيق)
│   ├── students/                       # StudentRepository (عزل بيانات المراكز)
│   └── payments/                       # PaymentRepository (النموذج المالي المبني على الأحداث)
│
├── shared/
│   ├── components/                     # AppButton, AppInput, AppCard, StatusBadge, SyncIndicator
│   └── types/                          # تعريفات الكيانات والأنواع المشتركة
│
└── config/
    └── env.ts                          # فحص المتغيرات البيئية عبر Zod
```

---

## 3. القرارات المعمارية الأساسية

### أ. تطبيع كود الكارت (Card Code Normalization)

- **الحفاظ التام على الأصفار البادئة:** الكود `00125` يبقى `00125` ولا يتم تحويله إلى `125`، للحفاظ على هوية الكارت والباركود المطبوع بدقة.
- تحويل الأرقام المشرقية/العربية (`٠١٢٣٤٥٦٧٨٩`) إلى أرقام لاتينية قياسية (`0123456789`).
- إزالة الفراغات وأحرف التحكم غير المرئية.

### ب. النموذج المالي القائم على الأحداث (Event-Driven Financials)

- **لا يوجد جدول `student_balances` كمصدر حقيقة.**
- الموقف المالي للطالب يُحسب ديناميكيًا من سجلات الاشتراكات والدورات (`student_subscriptions`) مطروحًا منها أحداث الدفع الفعلية (`payments`).
- كل عملية دفع تحمل معرّف `operation_id` لتحقيق خاصية الـ Idempotency، وهي سجلات غير قابلة للحذف المباشر (Immutable Events)، مع دعم عمليات التسوية والعكس (Reversal) مستقبلاً.

### ج. عزل بيانات المراكز المتعددة (Multi-Center Isolation)

- لا تثق طبقة البيانات بأي `center_id` قادم من الشاشات كمعامل حر.
- يتم استنتاج `activeCenterId` حصريًا من سياق التوثيق المحمي داخل الـ Repositories.
- تطبيق قيد فريد `UNIQUE(center_id, card_code)` يضمن استقلالية كروت وطلاب كل مركز دون أي تداخل.

### د. دقة إحصائيات لوحة التحكم والطلاب المتوقعين

- إضافة جدول `session_expected_students` لربط الطلاب المقيدين بكل حصة.
- إحصائيات الحضور والغياب اليومية مبنية على من كان متوقعًا حضوره فعليًا وليست مجرد افتراض عشوائي.

### هـ. مسار الحضور بدون إنترنت (Zero-Internet Attendance Flow)

1. مسح الكارت عبر الكاميرا أو كتابة الكود يدويًا.
2. البحث السريع في SQLite عبر الفهرس `idx_students_card`.
3. جلب الحصص المؤهلة لهذا الطالب اليوم:
   - إن كانت حصة واحدة: تُحدد تلقائيًا.
   - إن كانت أكثر من حصة: تُعرض للاختيار.
4. حساب وقت الحضور الفعلي ومقارنته بموعد بدء الحصة لاحتساب حالة التأخير (حاضر / متأخر).
5. منع الحضور المكرر عبر قيد قاعدة البيانات `UNIQUE(session_id, student_id)`.
6. حفظ الحضور فورًا في جدول `attendance`.
7. إنشاء عملية مزامنة في `sync_operations` بحالة `pending`.
8. تسجيل الحدث في `audit_logs` مع هوية الجهاز والمستخدم.
9. عرض الموقف المالي المحسوب والاشتراك الحالي وإمكانية تسجيل دفعة سريعة.

---

## 4. التشغيل والاختبارات

### تثبيت الاعتمادات:

```bash
npm install
```

### فحص الـ TypeScript:

```bash
npx tsc --noEmit
```

### تشغيل حزمة الاختبارات الآلية (Jest):

```bash
npm test
```

تغطي الاختبارات الآلية:

- تطبيع أكواد الكروت والحفاظ على الأصفار البادئة.
- البحث عن الطلاب وعزل المراكز النشطة.
- فحص مصفوفة الصلاحيات (Admin, Secretary, Accountant).
- حساب الحضور والتأخير.
- منع تسجيل الحضور المكرر لنفس الحصة.
- دعم أنواع الحضور (`present` و `makeup`) مع `originalAbsenceId`.
- تسجيل الحضور في SQLite وإدراج عملية المزامنة وسجل التدقيق.
- احتساب الرصيد المالي ديناميكيًا من الأحداث المالية.
- احتساب حضور وغياب لوحة التحكم استنادًا لـ `session_expected_students`.

### تشغيل خادم التطوير (Expo):

```bash
npx expo start
```

- اضغط `a` لفتح التطبيق على محاكي Android أو جهاز متصل.
- اضغط `i` لفتح التطبيق على محاكي iOS.
- امسح كود الـ QR عبر تطبيق **Expo Go** على الموبايل لتجربة التطبيق المباشرة.

---

## 5. بيانات الحسابات التجريبية

| الحساب                     | رقم الموبايل  | كلمة المرور | الصلاحيات                                    |
| -------------------------- | ------------- | ----------- | -------------------------------------------- |
| **المدير (Admin)**         | `01000000001` | `123456`    | إدارة كاملة + الوصول لمركز النور ومركز الأمل |
| **السكرتارية (Secretary)** | `01000000002` | `123456`    | تسجيل الحضور، عرض الطلاب، تسجيل المدفوعات    |
| **المحاسب (Accountant)**   | `01000000003` | `123456`    | العمليات المالية، التقارير (بدون تسجيل حضور) |

### أكواد كروت الطلاب التجريبية:

- كود `00125` في مركز النور: الطالب **أحمد محمد محمود** (حصة رياضيات 2:00 م، اشتراك 400 جنيه، مدفوع 250 جنيه، متبقي 150 جنيه).
- كود `00126` في مركز النور: الطالبة **سارة علي حسن**.
- كود `00127` في مركز النور: الطالب **عمر خالد إبراهيم**.
- كود `00125` في مركز الأمل: الطالب **مصطفى كمال الدين** (اختبار عزل المراكز لنفس الكود).

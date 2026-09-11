# دليل نشر سيرفر FIXION على منصة Render السحابية

هذا الدليل يوضح خطوات نشر خادم الـ API الخلفي الخاص بنظام **FIXION** على منصة **Render** السحابية وربطه بقاعدة بيانات **Neon Serverless PostgreSQL** ومستودع GitHub:
👉 `https://github.com/ahmmed3kl/FIXION-CENTER`

---

## الخطوة 1: رفع الكود إلى مستودع GitHub

تأكد من عمل Commit و Push للكود إلى المستودع:

```bash
git add .
git commit -m "feat: setup cloud deployment for render and neon"
git branch -M main
git remote add origin https://github.com/ahmmed3kl/FIXION-CENTER.git
git push -u origin main
```

---

## الخطوة 2: إنشاء الخدمة على Render

1. افتح موقع [Render Dashboard](https://dashboard.render.com/) وسجّل الدخول بحساب GitHub الخاص بك.
2. اضغط على زر **New +** في أعلى اليمين، ثم اختر **Web Service**.
3. اختر خيار **Build and deploy from a Git repository**.
4. اختر مستودعك: **`ahmmed3kl/FIXION-CENTER`** (أو الصق الرابط `https://github.com/ahmmed3kl/FIXION-CENTER`).

---

## الخطوة 3: ضبط إعدادات الخدمة (Configuration)

املأ الحقول في شاشة الإعداد كما يلي:

| الحقل              | القيمة المطلوبة          | ملاحظات هامة                                                                                  |
| :----------------- | :----------------------- | :-------------------------------------------------------------------------------------------- |
| **Name**           | `fixion-backend`         | اسم الخدمة على Render                                                                         |
| **Region**         | `Ohio (US East)`         | **مهم جداً**: لتكون في نفس منطقة قاعدة بيانات Neon (us-east-2) لتقليل زمن الاستجابة (Latency) |
| **Branch**         | `main`                   | الفرع المعتمد                                                                                 |
| **Root Directory** | `backend`                | **هام للغاية**: يحدد أن كود السيرفر موجود داخل مجلد `backend`                                 |
| **Runtime**        | `Node`                   | بيئة التشغيل                                                                                  |
| **Build Command**  | `npm install --omit=dev` | لتثبيت حزم الإنتاج فقط وتوفير المساحة والوقت                                                  |
| **Start Command**  | `npm start`              | يشغّل الخادم `node src/server.js`                                                             |
| **Instance Type**  | `Free`                   | مجاني تماماً                                                                                  |

---

## الخطوة 4: إضافة متغيرات البيئة (Environment Variables)

انزل لأسفل الشاشة إلى قسم **Environment Variables** وأضف المتغيرات التالية:

1. **`DATABASE_URL`**
   ```text
   postgresql://neondb_owner:npg_CvDl5LXdj0RZ@ep-spring-queen-a50g0aeo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
2. **`JWT_SECRET`**
   ```text
   fixion_secret_key_prod_jwt_2026_super_secure_enterprise_grade_token_signing
   ```
3. **`APP_ENV`**
   ```text
   production
   ```
4. **`CORS_ORIGIN`**
   ```text
   *
   ```

_(ملاحظة: يقوم Render بتمرير المنفذ `PORT` تلقائياً، وخادمنا يقرأه تلقائياً)._

---

## الخطوة 5: إعداد فحص الصحة (Health Check)

في قسم **Advanced**، ستجد حقل **Health Check Path**:

- ضع فيه: `/v1/health`

اضغط على زر **Create Web Service** في أسفل الصفحة.

---

## الخطوة 6: التحقق من نجاح النشر (Live Verification)

بعد اكتمال عملية البناء والتشغيل (يستغرق حوالي دقيقة إلى دقيقتين)، سيعطيك Render رابطاً دائماً مثل:
`https://fixion-backend.onrender.com`

قم بفتح الرابط التالي في المتصفح:
`https://fixion-backend.onrender.com/v1/health`

ستظهر لك الاستجابة الرسمية التالية:

```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-09-12T00:30:00.000Z"
}
```

---

## الخطوة 7: ربط تطبيق الموبايل بالسيرفر السحابي

الآن كل ما تحتاجه هو توجيه تطبيق الموبايل إلى هذا الرابط بدلاً من الرابط المحلي:

1. افتح ملف `.env` في المجلد الرئيسي لمشروع الموبايل.
2. اكتب الإعدادات التالية (مع استبدال الرابط برابطك الحقيقي من Render):
   ```env
   EXPO_PUBLIC_API_URL=https://fixion-backend.onrender.com/v1
   EXPO_PUBLIC_APP_ENV=production
   EXPO_PUBLIC_ENABLE_MOCK_DATA=false
   ```
3. الآن قم بتشغيل التطبيق:
   ```bash
   npx expo start
   ```
   سيتصل التطبيق مباشرة بالسحابة وبقاعدة بيانات Neon من أي مكان في العالم!

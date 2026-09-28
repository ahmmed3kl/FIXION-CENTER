import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, platformApi } from "../api/client";
import { clearSession } from "../auth/authStore";
import type { PlatformOverview } from "../types";

type Metric = { label: string; value: (data: PlatformOverview) => number; tone: string };
const primaryMetrics: Metric[] = [
  { label: "إجمالي السناتر", value: data => data.centers.total, tone: "blue" },
  { label: "السناتر النشطة", value: data => data.centers.active, tone: "teal" },
  { label: "إجمالي الطلاب", value: data => data.students.total, tone: "violet" },
  { label: "الأجهزة النشطة", value: data => data.devices.active, tone: "slate" },
];

function isHealthy(status: string) { return status === "ok" || status === "connected" || status === "healthy"; }
function healthLabel(label: string, status: string) { return isHealthy(status) ? `${label} — ${label === "قاعدة البيانات" ? "متصلة" : "تعمل"}` : `${label} — تحتاج مراجعة`; }

function MetricCard({ metric, data }: { metric: Metric; data: PlatformOverview }) {
  return <article className={`metric-card ${metric.tone}`}><span>{metric.label}</span><strong>{metric.value(data).toLocaleString("ar-EG")}</strong><i aria-hidden="true" /></article>;
}

export function DashboardPage() {
  const navigate = useNavigate(); const [data, setData] = useState<PlatformOverview | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); setError(""); try { setData(await platformApi.overview()); } catch (err) { if (err instanceof ApiError && err.status === 401) { clearSession(); navigate("/login", { replace: true }); return; } setError(err instanceof ApiError ? err.message : "حدث خطأ في الخادم، حاول مرة أخرى."); } finally { setLoading(false); } }, [navigate]);
  useEffect(() => { void load(); const refresh = () => void load(); window.addEventListener("fixion:refresh-dashboard", refresh); return () => window.removeEventListener("fixion:refresh-dashboard", refresh); }, [load]);
  return <section className="dashboard-page">
    <div className="page-heading dashboard-heading"><div><p className="eyebrow">نظرة عامة</p><h2>ملخص منصة FIXION</h2><p className="muted">صورة تشغيلية مختصرة لحالة السناتر والموارد المتصلة.</p></div></div>
    {error && <div className="alert error page-alert" role="alert">{error}</div>}
    {loading && !data ? <div className="panel loading-state">جارٍ تحميل بيانات المنصة...</div> : data ? <>
      <section className="primary-metrics" aria-label="المؤشرات الأساسية">{primaryMetrics.map(metric => <MetricCard key={metric.label} metric={metric} data={data} />)}</section>
      <div className="dashboard-grid">
        <section className="dashboard-section health-section"><div className="section-heading"><div><p className="section-kicker">المراقبة</p><h3>حالة النظام</h3></div><span className="live-indicator"><i /> مباشر</span></div><p className="section-description">حالة الخدمات الأساسية في آخر استجابة من الخادم.</p><div className="health-list">{[["واجهة برمجة التطبيقات", data.health.api], ["قاعدة البيانات", data.health.database], ["المزامنة", data.health.sync]].map(([label, status]) => <div className="health-row" key={label}><span className={`status-dot ${isHealthy(status) ? "healthy" : "warning"}`} /><div><strong>{healthLabel(label, status)}</strong><small>{isHealthy(status) ? "لا توجد مؤشرات على تعطل الخدمة" : "يرجى مراجعة حالة الخدمة"}</small></div><span className={`health-state ${isHealthy(status) ? "good" : "warn"}`}>{isHealthy(status) ? "تعمل" : "تحذير"}</span></div>)}</div></section>
        <section className="dashboard-section operations-section"><div className="section-heading"><div><p className="section-kicker">المتابعة</p><h3>المؤشرات التشغيلية</h3></div></div><p className="section-description">عمليات تحتاج إلى انتباه فريق الإدارة.</p><div className="operation-list"><button type="button" className="operation-row" onClick={() => navigate("/sync")}><span className="operation-icon amber">⌁</span><span><strong>عمليات معلقة</strong><small>تنتظر المزامنة مع الخادم</small></span><b>{data.sync.pending.toLocaleString("ar-EG")}</b></button><button type="button" className="operation-row" onClick={() => navigate("/sync")}><span className="operation-icon red">!</span><span><strong>عمليات فاشلة</strong><small>تحتاج إلى مراجعة من سجل المزامنة</small></span><b>{data.sync.failed.toLocaleString("ar-EG")}</b></button><button type="button" className="operation-row" onClick={() => navigate("/centers")}><span className="operation-icon teal">✓</span><span><strong>السناتر الموقوفة</strong><small>يمكن مراجعة حالتها من إدارة السناتر</small></span><b>{data.centers.suspended.toLocaleString("ar-EG")}</b></button></div></section>
      </div>
      <section className="quick-actions"><div><p className="section-kicker">الوصول السريع</p><h3>إجراءات سريعة</h3></div><div className="quick-action-list"><button type="button" onClick={() => navigate("/centers")}><span>◉</span>إدارة السناتر</button><button type="button" onClick={() => navigate("/sync")}><span>⌁</span>متابعة المزامنة</button><button type="button" onClick={() => navigate("/health")}><span>✦</span>فحص حالة النظام</button></div></section>
    </> : <div className="panel empty-state">لا تتوفر بيانات المنصة.</div>}
  </section>;
}

export function PlaceholderPage({ title }: { title: string }) { return <section className="panel"><p className="eyebrow">قريبًا</p><h2>{title}</h2><p className="muted">هذه الشاشة محجوزة للمرحلة التالية من بناء لوحة المنصة.</p></section>; }

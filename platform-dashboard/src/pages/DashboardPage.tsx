import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, platformApi } from "../api/client";
import { clearSession } from "../auth/authStore";
import type { PlatformOverview } from "../types";

const metricLabels = ["إجمالي المراكز", "إجمالي الطلاب", "المراكز النشطة", "المراكز الموقوفة", "الأجهزة النشطة", "عمليات معلقة", "عمليات فاشلة"];

export function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await platformApi.overview()); }
    catch (err) { if (err instanceof ApiError && err.status === 401) { clearSession(); navigate("/login", { replace: true }); return; } setError(err instanceof ApiError ? err.message : "حدث خطأ في الخادم، حاول مرة أخرى."); }
    finally { setLoading(false); }
  }, [navigate]);
  useEffect(() => { void load(); }, [load]);
  const values = data ? [data.centers.total, data.students.total, data.centers.active, data.centers.suspended, data.devices.active, data.sync.pending, data.sync.failed] : [];
  return <section><div className="page-heading"><div><p className="eyebrow">نظرة عامة</p><h2>حالة منصة FIXION</h2><p className="muted">بيانات المنصة من الـ API المركزي.</p></div><button className="refresh-button" onClick={() => void load()} disabled={loading}>↻ تحديث البيانات</button></div>{error && <div className="alert error page-alert" role="alert">{error}</div>}{loading && !data ? <div className="panel loading-state">جارٍ تحميل بيانات المنصة...</div> : <><div className="kpi-grid">{metricLabels.map((label, index) => <article className="kpi-card" key={label}><span className="muted">{label}</span><strong>{values[index] ?? "—"}</strong></article>)}</div><article className="panel"><div className="panel-heading"><div><h3>حالة النظام</h3><p className="muted">آخر استجابة من خدمات المنصة.</p></div><span className="role-badge">بيانات مباشرة</span></div><div className="health-grid">{data && [["API", data.health.api], ["قاعدة البيانات", data.health.database], ["المزامنة", data.health.sync]].map(([label, status]) => <div className="health-item" key={label}><span className={`status-dot ${status === "ok" || status === "connected" ? "healthy" : "warning"}`} /><span>{label}</span><span className="muted">{status}</span></div>)}</div></article></>}</section>;
}

export function PlaceholderPage({ title }: { title: string }) { return <section className="panel"><p className="eyebrow">قريبًا</p><h2>{title}</h2><p className="muted">هذه الشاشة محجوزة للمرحلة التالية من بناء لوحة المنصة.</p></section>; }

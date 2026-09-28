import { useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { clearSession, getSession } from "./auth/authStore";
import { AuditLogsPage } from "./pages/AuditLogsPage";
import { CardRangesPage } from "./pages/CardRangesPage";
import { CentersPage, CenterDetailsPage } from "./pages/CentersPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DevicesPage } from "./pages/DevicesPage";
import { HealthPage } from "./pages/HealthPage";
import { LoginPage } from "./pages/LoginPage";
import { ServicesPage } from "./pages/ServicesPage";
import { SyncPage } from "./pages/SyncPage";
import { UsersPage } from "./pages/UsersPage";

const links = [
  ["الرئيسية", "/dashboard", "⌂"], ["المراكز", "/centers", "◉"], ["المستخدمون", "/users", "♙"],
  ["الخدمات", "/services", "▣"], ["نطاقات البطاقات", "/card-ranges", "▤"], ["الأجهزة", "/devices", "▥"],
  ["المزامنة", "/sync", "⌁"], ["سجل التدقيق", "/audit-logs", "◌"], ["صحة النظام", "/health", "✦"],
] as const;
const pageNames: Record<string, string> = Object.fromEntries(links.map(([label, path]) => [path, label]));

function ProtectedRoute() { const location = useLocation(); return getSession() ? <Outlet /> : <Navigate to="/login" replace state={{ from: location.pathname }} />; }

function AppShell() {
  const navigate = useNavigate(); const location = useLocation(); const session = getSession(); const [sidebarOpen, setSidebarOpen] = useState(false);
  const activePage = location.pathname.startsWith("/centers/") ? "المراكز" : pageNames[location.pathname] ?? "الرئيسية";
  const adminName = session?.admin.name ?? session?.admin.email ?? "المسؤول";
  const go = (path: string) => { navigate(path); setSidebarOpen(false); };
  return <div className="app-shell">
    <button className={`sidebar-backdrop${sidebarOpen ? " visible" : ""}`} aria-label="إغلاق القائمة" onClick={() => setSidebarOpen(false)} />
    <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
      <div className="brand"><img className="brand-logo" src="/branding/fixion-icon.png" alt="FIXION" /><div><strong>FIXION</strong><span>منصة الإدارة</span></div></div>
      <div className="sidebar-section-label">إدارة المنصة</div>
      <nav aria-label="التنقل الرئيسي">{links.map(([label, path, icon]) => <button className={`nav-item${location.pathname === path || (path === "/centers" && location.pathname.startsWith("/centers/")) ? " active" : ""}`} key={path} onClick={() => go(path)}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span></button>)}</nav>
      <div className="sidebar-footer"><div className="sidebar-status"><i />الخادم متصل</div><div className="sidebar-account"><span className="account-avatar">{adminName.slice(0, 1).toUpperCase()}</span><div><strong>{adminName}</strong><small>مسؤول المنصة</small></div></div><button className="logout-button" onClick={() => { clearSession(); navigate("/login", { replace: true }); }}>تسجيل الخروج</button></div>
    </aside>
    <div className="main-column"><header className="topbar"><div className="topbar-context"><button className="menu-button" aria-label="فتح القائمة" onClick={() => setSidebarOpen(true)}>☰</button><div><span className="breadcrumb">FIXION / لوحة الإدارة</span><h1>{activePage}</h1></div></div><div className="topbar-tools">{location.pathname === "/dashboard" && <button className="header-refresh" type="button" aria-label="تحديث البيانات" onClick={() => window.dispatchEvent(new Event("fixion:refresh-dashboard"))}>↻ <span>تحديث البيانات</span></button>}<div className="account"><span className="account-avatar">{adminName.slice(0, 1).toUpperCase()}</span><div><strong>{adminName}</strong><span>مسؤول المنصة</span></div></div></div></header><main className="page-content"><Outlet /></main></div>
  </div>;
}

export default function App() { return <Routes><Route path="/login" element={<LoginPage />} /><Route element={<ProtectedRoute />}><Route element={<AppShell />}><Route path="/dashboard" element={<DashboardPage />} /><Route path="/centers" element={<CentersPage />} /><Route path="/centers/:centerId" element={<CenterDetailsPage />} /><Route path="/users" element={<UsersPage />} /><Route path="/services" element={<ServicesPage />} /><Route path="/card-ranges" element={<CardRangesPage />} /><Route path="/devices" element={<DevicesPage />} /><Route path="/sync" element={<SyncPage />} /><Route path="/audit-logs" element={<AuditLogsPage />} /><Route path="/health" element={<HealthPage />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Route></Route><Route path="/" element={<Navigate to="/dashboard" replace />} /></Routes>; }

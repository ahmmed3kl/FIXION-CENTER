import { FormEvent, useEffect, useState } from "react";
import { ApiError, platformApi } from "../api/client";
import type { Center, CenterUser } from "../types";

const editableRoles = [
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "assistant", label: "Assistant" },
] as const;

type EditableRole = (typeof editableRoles)[number]["value"];

export function UsersPage() {
  const [centers, setCenters] = useState<Center[]>([]);
  const [centerId, setCenterId] = useState("");
  const [users, setUsers] = useState<CenterUser[]>([]);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formUser, setFormUser] = useState<CenterUser | null | undefined>(undefined);
  const [resetUser, setResetUser] = useState<CenterUser | null>(null);

  useEffect(() => {
    void platformApi.centers({ pageSize: 100 }).then((response) => {
      setCenters(response.items);
      if (response.items[0]) setCenterId(response.items[0].id);
    }).catch((cause) => setError(cause instanceof ApiError ? cause.message : "تعذر تحميل المراكز."));
  }, []);

  async function load() {
    if (!centerId) return;
    setLoading(true);
    setError("");
    try {
      const response = await platformApi.users(centerId, { search, role });
      setUsers(response.items);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "تعذر تحميل المستخدمين.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 300);
    return () => window.clearTimeout(timer);
  }, [centerId, search, role]);

  async function toggle(user: CenterUser) {
    if (!window.confirm(user.status === "active" ? "هل أنت متأكد من تعطيل هذا الحساب؟" : "هل تريد إعادة تفعيل هذا الحساب؟")) return;
    try {
      await platformApi.setUserStatus(centerId, user.id, user.status === "active" ? "inactive" : "active");
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "تعذر تحديث الحساب.");
    }
  }

  return (
    <section>
      <div className="page-heading">
        <div><p className="eyebrow">إدارة المنصة</p><h2>مستخدمو المراكز</h2><p className="muted">إدارة حسابات Admin وManager وAssistant للمراكز.</p></div>
        <button className="primary-button compact" onClick={() => setFormUser(null)} disabled={!centerId}>+ إضافة مستخدم</button>
      </div>
      <div className="toolbar">
        <select value={centerId} onChange={(event) => setCenterId(event.target.value)} aria-label="اختر المركز">
          <option value="">اختر المركز</option>{centers.map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}
        </select>
        <input placeholder="بحث بالاسم أو البريد" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="بحث بالاسم أو البريد" />
        <select value={role} onChange={(event) => setRole(event.target.value)} aria-label="تصفية حسب الدور">
          <option value="">كل الأدوار</option>{editableRoles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      {error && <div className="alert error page-alert">{error}</div>}
      {loading ? <div className="panel loading-state">جارٍ تحميل المستخدمين...</div> : users.length === 0 ? <div className="panel empty-state">لا يوجد مستخدمون مطابقون للبحث</div> : (
        <div className="panel table-wrap"><table><thead><tr><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>الحالة</th><th>تاريخ الإنشاء</th><th>إجراء</th></tr></thead><tbody>
          {users.map((user) => <tr key={user.id}>
            <td>{user.full_name}</td><td>{user.email}</td><td>{user.role}</td>
            <td><span className={`status-badge ${user.status}`}>{user.status === "active" ? "نشط" : "غير نشط"}</span></td>
            <td>{new Date(user.created_at).toLocaleDateString("ar-EG")}</td>
            <td className="user-actions">
              <button className="text-button" onClick={() => setFormUser(user)}>تعديل</button>
              <button className="text-button" onClick={() => setResetUser(user)}>إعادة كلمة المرور</button>
              <button className="text-button" onClick={() => void toggle(user)}>{user.status === "active" ? "تعطيل" : "تفعيل"}</button>
            </td>
          </tr>)}
        </tbody></table></div>
      )}
      {formUser !== undefined && <UserForm key={formUser?.id || "create"} centerId={centerId} user={formUser} onClose={() => setFormUser(undefined)} onSaved={() => { setFormUser(undefined); void load(); }} />}
      {resetUser && <PasswordResetForm centerId={centerId} user={resetUser} onClose={() => setResetUser(null)} onSaved={() => setResetUser(null)} />}
    </section>
  );
}

function UserForm({ centerId, user, onClose, onSaved }: { centerId: string; user: CenterUser | null | undefined; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(user?.full_name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>(user?.role || "assistant");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const creating = !user;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (user) {
        await platformApi.updateUser(centerId, user.id, { name, email, role });
      } else {
        await platformApi.createUser(centerId, { name, email, password, role });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : user ? "تعذر تعديل المستخدم." : "تعذر إنشاء المستخدم.");
    } finally {
      setSaving(false);
    }
  }

  const legacyRole = Boolean(user && !editableRoles.some((item) => item.value === user.role));
  return <div className="modal-backdrop"><form className="modal-card" onSubmit={submit}>
    <h3>{user ? "تعديل بيانات المستخدم" : "إضافة مستخدم"}</h3>
    <label>الاسم<input required minLength={2} maxLength={255} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>البريد الإلكتروني<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    <label>الدور<select value={role} onChange={(event) => setRole(event.target.value as EditableRole)}>
      {legacyRole && <option value={user!.role} disabled>{user!.role}</option>}
      {editableRoles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select></label>
    {creating && <label>كلمة المرور<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} autoComplete="new-password" /><small>12 حرفًا على الأقل، مع حرف ورقم.</small></label>}
    {error && <div className="alert error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>إلغاء</button><button className="primary-button" disabled={saving}>{saving ? "جارٍ الحفظ..." : "حفظ"}</button></div>
  </form></div>;
}

function PasswordResetForm({ centerId, user, onClose, onSaved }: { centerId: string; user: CenterUser; onClose: () => void; onSaved: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setError("كلمتا المرور غير متطابقتين."); return; }
    setSaving(true);
    setError("");
    try {
      await platformApi.resetUserPassword(centerId, user.id, password);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "تعذر إعادة تعيين كلمة المرور.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="modal-backdrop"><form className="modal-card" onSubmit={submit}>
    <h3>إعادة كلمة مرور {user.full_name}</h3>
    <label>كلمة المرور الجديدة<input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} autoComplete="new-password" /><small>12 حرفًا على الأقل، مع حرف ورقم.</small></label>
    <label>تأكيد كلمة المرور<input required type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} autoComplete="new-password" /></label>
    {error && <div className="alert error">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>إلغاء</button><button className="primary-button" disabled={saving}>{saving ? "جارٍ الحفظ..." : "تحديث كلمة المرور"}</button></div>
  </form></div>;
}
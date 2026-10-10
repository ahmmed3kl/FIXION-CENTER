import { useEffect, useState } from "react";
import { ApiError, platformApi } from "../api/client";
import type { Center, Device } from "../types";

export function deviceModel(device: Device): string {
  const name = device.device_name?.trim();
  if (
    !name ||
    /^(?:موديل غير معروف|unknown(?: device)?|device|mobile tablet\/phone)$/i.test(name) ||
    /^(ANDROID|IOS|IPADOS|WEB)-Device-[A-Za-z0-9]{4}$/i.test(name) ||
    /^dev-[0-9a-f-]{30,}$/i.test(name) ||
    /^user-[0-9a-f-]{30,}$/i.test(name) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(name)
  ) {
    return "موديل غير معروف";
  }
  return name;
}

export function lastAccount(device: Device): string {
  return device.full_name?.trim() || device.user_email?.trim() || "بيانات الحساب غير متاحة";
}

function lastSeen(device: Device): string {
  if (!device.last_seen_at) return "غير معروف";
  const parsed = new Date(device.last_seen_at);
  return Number.isNaN(parsed.getTime())
    ? "غير معروف"
    : new Intl.DateTimeFormat("ar-EG", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}

function statusLabel(status: Device["status"]): string {
  return status === "active" ? "نشط" : status === "revoked" ? "ملغى" : "معلق";
}

export function DevicesPage() {
  const [centers, setCenters] = useState<Center[]>([]);
  const [centerId, setCenterId] = useState("");
  const [items, setItems] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [copiedDeviceId, setCopiedDeviceId] = useState("");

  useEffect(() => {
    void platformApi
      .centers({ pageSize: 100 })
      .then((response) => {
        setCenters(response.items);
        if (response.items[0]) setCenterId(response.items[0].id);
      })
      .catch((cause) =>
        setError(cause instanceof ApiError ? cause.message : "تعذر تحميل المراكز."),
      );
  }, []);

  async function load() {
    if (!centerId) return;
    try {
      setItems((await platformApi.devices(centerId)).items);
      setError("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "تعذر تحميل الأجهزة.");
    }
  }

  useEffect(() => {
    void load();
  }, [centerId]);

  async function toggle(device: Device) {
    if (
      !window.confirm(
        device.status === "active"
          ? "هل أنت متأكد من تعطيل هذا الجهاز؟"
          : "هل تريد إعادة تفعيل هذا الجهاز؟",
      )
    ) {
      return;
    }
    try {
      await platformApi.setDeviceStatus(
        centerId,
        device.id,
        device.status === "active" ? "revoked" : "active",
      );
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "تعذر تحديث الجهاز.");
    }
  }

  async function copyDeviceId(deviceId: string) {
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopiedDeviceId(deviceId);
      window.setTimeout(() => setCopiedDeviceId(""), 1800);
    } catch {
      setError("تعذر نسخ معرّف الجهاز من هذا المتصفح.");
    }
  }

  function technicalDetails(device: Device) {
    return (
      <details className="device-technical-details">
        <summary>بيانات تقنية</summary>
        <div className="device-technical-value">
          <code dir="ltr">{device.id}</code>
          <button
            className="text-button"
            type="button"
            onClick={() => void copyDeviceId(device.id)}
          >
            {copiedDeviceId === device.id ? "تم النسخ" : "نسخ المعرّف"}
          </button>
        </div>
      </details>
    );
  }

  return (
    <section className="devices-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">إدارة المنصة</p>
          <h2>الأجهزة</h2>
          <p className="muted">حالة الأجهزة والمزامنة لكل مركز.</p>
        </div>
        <button className="secondary-button" onClick={() => void load()}>
          تحديث
        </button>
      </div>
      <div className="toolbar">
        <select
          aria-label="اختر المركز"
          value={centerId}
          onChange={(event) => setCenterId(event.target.value)}
        >
          <option value="">اختر المركز</option>
          {centers.map((center) => (
            <option key={center.id} value={center.id}>
              {center.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="panel table-wrap devices-table">
        <table>
          <thead>
            <tr>
              <th>موديل الجهاز</th>
              <th>آخر حساب استخدم الجهاز</th>
              <th>الحالة</th>
              <th>آخر ظهور</th>
              <th>فاشلة</th>
              <th>إجراء</th>
            </tr>
          </thead>
          <tbody>
            {items.map((device) => (
              <tr key={device.id}>
                <td>
                  <strong dir="auto">{deviceModel(device)}</strong>
                  {technicalDetails(device)}
                </td>
                <td>
                  <span dir="auto">{lastAccount(device)}</span>
                  <small>آخر حساب معروف، وليس بالضرورة النشط الآن</small>
                  {device.full_name && device.user_email && (
                    <small dir="ltr">{device.user_email}</small>
                  )}
                </td>
                <td>{statusLabel(device.status)}</td>
                <td dir="auto">{lastSeen(device)}</td>
                <td>{device.failed_operations ?? 0}</td>
                <td>
                  <button
                    className="text-button"
                    onClick={() => void toggle(device)}
                  >
                    {device.status === "active" ? "تعطيل" : "تفعيل"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="empty-state">لا توجد أجهزة</div>}
      </div>

      <div className="device-card-list">
        {items.map((device) => (
          <article className="device-card" key={device.id}>
            <div className="device-card-heading">
              <strong dir="auto">{deviceModel(device)}</strong>
              <span className={`status-badge ${device.status}`}>
                {statusLabel(device.status)}
              </span>
            </div>
            <dl className="device-fields">
              <div className="device-field">
                <dt>معرّف الجهاز للتشخيص</dt>
                <dd>{technicalDetails(device)}</dd>
              </div>
              <div className="device-field">
                <dt>آخر حساب استخدم الجهاز</dt>
                <dd dir="auto">{lastAccount(device)}</dd>
              </div>
              {device.full_name && device.user_email && (
                <div className="device-field">
                  <dt>البريد الإلكتروني</dt>
                  <dd dir="ltr">{device.user_email}</dd>
                </div>
              )}
              <div className="device-field">
                <dt>آخر ظهور</dt>
                <dd dir="auto">{lastSeen(device)}</dd>
              </div>
              <div className="device-field">
                <dt>عمليات مزامنة فاشلة</dt>
                <dd>{device.failed_operations ?? 0}</dd>
              </div>
            </dl>
            <p className="device-account-note">
              هذا آخر حساب مسجّل على الجهاز، وليس بالضرورة الحساب النشط الآن.
            </p>
            <button
              className="secondary-button device-action"
              onClick={() => void toggle(device)}
            >
              {device.status === "active" ? "تعطيل الجهاز" : "تفعيل الجهاز"}
            </button>
          </article>
        ))}
        {!items.length && <div className="empty-state">لا توجد أجهزة</div>}
      </div>
    </section>
  );
}

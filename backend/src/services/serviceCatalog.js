const SERVICE_CATALOG = Object.freeze({
  attendance: { name: "Attendance", description: "الحضور والانصراف", availability: "available" },
  payments: { name: "Payments", description: "المدفوعات", availability: "available" },
  packages: { name: "Packages", description: "الباقات", availability: "available" },
  makeup: { name: "Makeup", description: "التعويض", availability: "available" },
  notifications: { name: "Notifications", description: "الإشعارات", availability: "available" },
  reports: { name: "Reports", description: "التقارير", availability: "available" },
  whatsapp: { name: "WhatsApp", description: "رسائل WhatsApp", availability: "not_configured" },
  sms: { name: "SMS", description: "الرسائل النصية", availability: "not_configured" },
});
const ENTITY_SERVICE = { attendance: "attendance", attendance_marked: "attendance", session: "attendance", payment: "payments", payment_collected: "payments", payment_reversal: "payments", debt_adjustment: "payments", package: "packages", package_subject: "packages", package_subscription: "packages", package_teacher_override: "packages", debt_cycle: "packages", advance_coverage: "packages", subscription: "packages", makeup: "makeup", notification: "notifications", notification_event: "notifications", notification_delivery: "notifications", report: "reports" };
function getServiceKeyForEntity(entityType, operationType) { const entity = String(entityType || "").toLowerCase(); if (ENTITY_SERVICE[entity]) return ENTITY_SERVICE[entity]; const operation = String(operationType || "").toLowerCase(); if (operation.startsWith("payment.")) return "payments"; if (operation.startsWith("attendance.")) return "attendance"; if (operation.startsWith("package.")) return "packages"; if (operation.startsWith("notification.")) return "notifications"; if (operation.startsWith("makeup.")) return "makeup"; if (operation.startsWith("report.")) return "reports"; return null; }
module.exports = { SERVICE_CATALOG, getServiceKeyForEntity };

export class AppError extends Error {
  public readonly code: string;
  public readonly userMessage: string;

  constructor(
    message: string,
    code = "APP_ERROR",
    userMessage = "حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.",
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NetworkError extends AppError {
  constructor(
    message = "Network error",
    userMessage = "لا يمكن الاتصال بالخادم. يرجى التحقق من اتصال الإنترنت.",
  ) {
    super(message, "NETWORK_ERROR", userMessage);
    this.name = "NetworkError";
  }
}

export class DatabaseError extends AppError {
  constructor(
    message: string,
    userMessage = "حدث خطأ أثناء قراءة أو حفظ البيانات محليًا.",
  ) {
    super(message, "DATABASE_ERROR", userMessage);
    this.name = "DatabaseError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    message = "Unauthorized",
    userMessage = "انتهت صلاحية الجلسة. يرجى تسجيل الدخول مجددًا.",
  ) {
    super(message, "UNAUTHORIZED", userMessage);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = "Forbidden",
    userMessage = "ليس لديك الصلاحية الكافية لإتمام هذا الإجراء.",
  ) {
    super(message, "FORBIDDEN", userMessage);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, userMessage = "البيانات المدخلة غير صحيحة.") {
    super(message, "VALIDATION_ERROR", userMessage);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, userMessage = "العنصر المطلوب غير موجود.") {
    super(message, "NOT_FOUND", userMessage);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(
    message: string,
    userMessage = "يوجد تضارب في البيانات المسجلة يحتاج إلى مراجعة.",
  ) {
    super(message, "CONFLICT_ERROR", userMessage);
    this.name = "ConflictError";
  }
}

export class SyncError extends AppError {
  constructor(message: string, userMessage = "حدث خطأ أثناء مزامنة البيانات.") {
    super(message, "SYNC_ERROR", userMessage);
    this.name = "SyncError";
  }
}

export function getUserErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.userMessage;
  }
  if (error instanceof Error) {
    return error.message || "حدث خطأ غير متوقع.";
  }
  return "حدث خطأ غير متوقع. يرجى إعادة المحاولة.";
}

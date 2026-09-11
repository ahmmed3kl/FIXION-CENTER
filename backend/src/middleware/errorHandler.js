class AppError extends Error {
  constructor(code, message, userMessage, statusCode = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
    this.statusCode = statusCode;
  }
}

function errorHandler(err, req, res, next) {
  // If it's our structured domain error
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        userMessage: err.userMessage,
      },
    });
  }

  // Handle PostgreSQL duplicate key constraint violation (23505)
  if (err.code === "23505") {
    return res.status(409).json({
      error: {
        code: "CONFLICT",
        message: "A duplicate record already exists.",
        userMessage: "هذا السجل مسجل بالفعل في النظام ولا يمكن تكراره.",
      },
    });
  }

  // Handle PostgreSQL foreign key constraint violation (23503)
  if (err.code === "23503") {
    return res.status(400).json({
      error: {
        code: "FOREIGN_KEY_VIOLATION",
        message: "Referenced entity does not exist.",
        userMessage: "البيانات المرتبطة غير موجودة أو تم حذفها.",
      },
    });
  }

  // Default internal server error - never leak SQL, stack traces, or credentials
  console.error("[Internal Server Error]", err.message);
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected internal error occurred.",
      userMessage: "حدث خطأ غير متوقع في الخادم. يرجى المحاولة لاحقاً.",
    },
  });
}

module.exports = {
  AppError,
  errorHandler,
};

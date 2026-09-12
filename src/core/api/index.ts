import axios, {
    AxiosInstance,
    AxiosResponse,
    InternalAxiosRequestConfig,
} from "axios";
import { env } from "../../config/env";
import { DeviceService } from "../device";
import {
    AppError,
    ConflictError,
    ForbiddenError,
    NetworkError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
} from "../errors";
import { SecureStorageService } from "../storage";

export * from "./contracts";
export * from "./SyncApiAdapter";

export type UnauthorizedHandler = () => void | Promise<void>;

export class ApiClient {
  private static instance: AxiosInstance | null = null;
  private static onUnauthorizedCallback: UnauthorizedHandler | null = null;

  static setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
    this.onUnauthorizedCallback = handler;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  static setCustomInstance(custom: AxiosInstance): void {
    this.instance = custom;
  }

  static getInstance(): AxiosInstance {
    if (!this.instance) {
      this.instance = axios.create({
        baseURL: env.apiUrl,
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      // Request interceptor: Attach session token, center context, and device id
      this.instance.interceptors.request.use(
        async (config: InternalAxiosRequestConfig) => {
          // 1. Session token
          const token = await SecureStorageService.getItem("session_token");
          if (token && config.headers) {
            config.headers.Authorization = `Bearer ${token}`;
          }

          // 2. Active Center ID header
          const activeCenterId =
            await SecureStorageService.getItem("active_center_id");
          if (
            activeCenterId &&
            config.headers &&
            !config.headers["X-Center-Id"]
          ) {
            config.headers["X-Center-Id"] = activeCenterId;
          }

          // 3. Device ID header
          const deviceId = DeviceService.getDeviceIdSync();
          if (deviceId && config.headers && !config.headers["X-Device-Id"]) {
            config.headers["X-Device-Id"] = deviceId;
          }

          // 4. Client app version header
          if (config.headers && !config.headers["X-App-Version"]) {
            config.headers["X-App-Version"] = env.appVersion;
          }

          return config;
        },
        (error) => Promise.reject(error),
      );

      // Response interceptor: Map errors to domain errors with Arabic user messaging
      this.instance.interceptors.response.use(
        (response: AxiosResponse) => response,
        async (error) => {
          if (!error.response) {
            return Promise.reject(
              new NetworkError(
                error.message || "Network error",
                "لا يمكن الاتصال بالخادم. يرجى التحقق من اتصال الإنترنت.",
              ),
            );
          }

          const status = error.response.status;
          const serverData = error.response.data;
          const serverErr = serverData?.error;

          let serverMessage = "خطأ غير متوقع في استجابة الخادم";
          let serverUserMessage: string | undefined;

          if (serverErr && typeof serverErr === "object") {
            serverMessage = serverErr.message || JSON.stringify(serverErr);
            serverUserMessage = serverErr.userMessage;
          } else if (typeof serverErr === "string") {
            serverMessage = serverErr;
          } else if (serverData?.message) {
            serverMessage = typeof serverData.message === "object" ? JSON.stringify(serverData.message) : String(serverData.message);
          }

          if (status === 401) {
            if (ApiClient.onUnauthorizedCallback) {
              try {
                await ApiClient.onUnauthorizedCallback();
              } catch {}
            }
            return Promise.reject(
              new UnauthorizedError(
                serverMessage,
                serverUserMessage || "انتهت صلاحية الجلسة أو تم تسجيل الخروج. يرجى إعادة تسجيل الدخول.",
              ),
            );
          }

          if (status === 403) {
            return Promise.reject(
              new ForbiddenError(
                serverMessage,
                serverUserMessage || "ليس لديك الصلاحية الكافية لإتمام هذا الإجراء.",
              ),
            );
          }

          if (status === 404) {
            return Promise.reject(
              new NotFoundError(
                serverMessage,
                serverUserMessage || "العنصر المطلوب غير موجود على الخادم.",
              ),
            );
          }

          if (status === 409) {
            return Promise.reject(
              new ConflictError(
                serverMessage,
                serverUserMessage || "يوجد تضارب في البيانات المسجلة على الخادم.",
              ),
            );
          }

          if (status === 400 || status === 422) {
            return Promise.reject(
              new ValidationError(
                serverMessage,
                serverUserMessage || serverMessage || "البيانات المدخلة غير صحيحة.",
              ),
            );
          }

          if (status >= 500) {
            return Promise.reject(
              new AppError(
                serverMessage,
                `HTTP_${status}`,
                serverUserMessage || "حدث خطأ في الخادم أثناء معالجة الطلب. يرجى المحاولة لاحقاً.",
              ),
            );
          }

          return Promise.reject(
            new AppError(
              serverMessage,
              `HTTP_${status}`,
              serverUserMessage || serverMessage,
            ),
          );
        },
      );
    }
    return this.instance;
  }
}

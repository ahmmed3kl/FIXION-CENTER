import { create } from "zustand";
import { ApiClient } from "../../core/api";
import { AuditService } from "../../core/audit";
import { DeviceRepository, DeviceService } from "../../core/device";
import { ForbiddenError } from "../../core/errors";
import { SecureStorageService } from "../../core/storage";
import { SyncEngine } from "../../core/sync";
import { Center, User } from "../../shared/types";
import { AuthRepository } from "./AuthRepository";

// Automatically logout when receiving a 401 Unauthorized from API
ApiClient.setUnauthorizedHandler(async () => {
  await useAuthStore.getState().logout();
});

interface AuthState {
  currentUser: User | null;
  activeCenterId: string | null;
  activeCenter: Center | null;
  availableCenters: Center[];
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (phone: string, password?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  selectCenter: (centerId: string) => Promise<void>;
  restoreSession: () => Promise<boolean>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  currentUser: null,
  activeCenterId: null,
  activeCenter: null,
  availableCenters: [],
  isAuthenticated: false,
  isLoading: true,
  error: null,

  login: async (identifier: string, password?: string) => {
    set({ isLoading: true, error: null });
    try {
      const { user } = await AuthRepository.login(identifier, password);
      const centers = AuthRepository.getCentersForUser(user.centerIds);

      // The authenticated user determines the center context automatically.
      const resolvedCenterId = user.centerId || user.centerIds[0] || null;
      const resolvedCenter =
        centers.find((c) => c.id === resolvedCenterId) || centers[0] || null;

      if (resolvedCenterId) {
        await SecureStorageService.setItem(
          "active_center_id",
          resolvedCenterId,
        );

        const deviceId = await DeviceService.getDeviceId();
        DeviceRepository.registerOrGetDevice({
          centerId: resolvedCenterId,
          userId: user.id,
        });

        AuditService.recordEvent({
          operationId: `op-auth-${Date.now()}`,
          centerId: resolvedCenterId,
          userId: user.id,
          deviceId,
          entityType: "user",
          entityId: user.id,
          action: "user.login",
          payload: { role: user.role, centerId: resolvedCenterId },
        });

        // Trigger immediate background sync/bootstrap so Neon data populates the device instantly
        SyncEngine.syncCenterNow(resolvedCenterId).catch((err) => {
          console.warn("Immediate login sync notice:", err);
        });
      }

      set({
        currentUser: user,
        availableCenters: centers,
        activeCenterId: resolvedCenterId,
        activeCenter: resolvedCenter,
        isAuthenticated: true,
        isLoading: false,
      });

      return true;
    } catch (err: any) {
      set({
        error: err?.userMessage || err?.message || "فشل تسجيل الدخول",
        isLoading: false,
      });
      return false;
    }
  },

  selectCenter: async (centerId: string) => {
    const { availableCenters, currentUser } = get();
    if (!currentUser || !currentUser.centerIds.includes(centerId)) {
      throw new ForbiddenError("المركز المحدد غير متاح لهذا المستخدم");
    }

    const center = availableCenters.find((c) => c.id === centerId);
    if (!center) {
      throw new ForbiddenError("المركز المحدد غير متاح لهذا المستخدم");
    }

    await SecureStorageService.setItem("active_center_id", centerId);

    const deviceId = DeviceService.getDeviceIdSync();
    DeviceRepository.registerOrGetDevice({
      centerId,
      userId: currentUser.id,
    });

    AuditService.recordEvent({
      operationId: `op-center-${Date.now()}`,
      centerId,
      userId: currentUser.id,
      deviceId,
      entityType: "center",
      entityId: centerId,
      action: "center.switch",
      payload: { centerName: center.name },
    });

    set({
      activeCenterId: centerId,
      activeCenter: center,
    });
  },

  logout: async () => {
    set({ isLoading: true });
    await AuthRepository.logout();
    set({
      currentUser: null,
      activeCenterId: null,
      activeCenter: null,
      availableCenters: [],
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
  },

  restoreSession: async () => {
    set({ isLoading: true });
    try {
      const session = await AuthRepository.restoreSession();
      if (!session) {
        set({ isAuthenticated: false, isLoading: false });
        return false;
      }

      const centers = AuthRepository.getCentersForUser(session.user.centerIds);
      const savedCenterId =
        (await SecureStorageService.getItem("active_center_id")) ||
        session.user.centerId ||
        session.user.centerIds[0];
      let activeCenter =
        centers.find((c) => c.id === savedCenterId) || centers[0] || null;

      set({
        currentUser: session.user,
        availableCenters: centers,
        activeCenterId: activeCenter ? activeCenter.id : null,
        activeCenter,
        isAuthenticated: true,
        isLoading: false,
      });

      if (activeCenter?.id) {
        SyncEngine.syncCenterNow(activeCenter.id).catch((err) => {
          console.warn("Restore session background sync notice:", err);
        });
      }

      return true;
    } catch {
      set({ isAuthenticated: false, isLoading: false });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));

// Automatically logout when receiving a 401 Unauthorized from API
ApiClient.setUnauthorizedHandler(async () => {
  await useAuthStore.getState().logout();
});

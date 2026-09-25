import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { ApiClient } from "../api";
import { ServiceKey, ServiceVisibilityState, initialServiceVisibilityState, isServiceEnabled, offlineServiceDefaults } from "./serviceVisibility";
import { useAuthStore } from "../../features/auth/useAuthStore";

interface ServiceVisibilityContextValue extends ServiceVisibilityState {
  refresh: () => Promise<void>;
  isEnabled: (serviceKey: ServiceKey) => boolean;
}

const ServiceVisibilityContext = createContext<ServiceVisibilityContextValue | null>(null);

export function ServiceVisibilityProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, activeCenterId } = useAuthStore();
  // Service visibility is a server policy, but it must never block the
  // local-first app while the device is offline or the API is cold-starting.
  // Start with the safe offline policy and reconcile it with the server in
  // the background. Repository permission checks remain authoritative.
  const [state, setState] = useState<ServiceVisibilityState>({
    ...initialServiceVisibilityState,
    loaded: true,
    enabled: offlineServiceDefaults,
  });
  const requestVersion = useRef(0);

  const refresh = async () => {
    if (!isAuthenticated || !activeCenterId) {
      setState(initialServiceVisibilityState);
      return;
    }
    const version = ++requestVersion.current;
    setState((current) => ({
      ...current,
      loading: true,
      // Keep local workflows usable while this policy request is pending.
      loaded: true,
      centerId: activeCenterId,
      enabled: Object.keys(current.enabled).length
        ? current.enabled
        : offlineServiceDefaults,
      error: null,
    }));
    try {
      const response = await ApiClient.getInstance().get<{ centerId: string; services: Array<{ serviceKey: ServiceKey; enabled: boolean }> }>("/services");
      if (version !== requestVersion.current) return;
      const enabled = Object.fromEntries(response.data.services.map((service) => [
        service.serviceKey,
        service.enabled === true || (service.enabled as unknown as string) === "true" || (service.enabled as unknown as number) === 1,
      ])) as ServiceVisibilityState["enabled"];
      setState({ loading: false, loaded: true, centerId: response.data.centerId, enabled, error: null });
    } catch (error: any) {
      if (version !== requestVersion.current) return;
      setState((current) => ({ ...current, loading: false, loaded: true, enabled: Object.keys(current.enabled).length ? current.enabled : offlineServiceDefaults, error: error?.userMessage || error?.message || "تعذر تحميل حالة الخدمات" }));
    }
  };

  useEffect(() => {
    void refresh();

    // Platform Admin changes are made outside the mobile process. Refresh
    // whenever the app returns to the foreground so disable -> enable is
    // reflected without forcing a logout or app restart.
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") void refresh();
    });
    const interval = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 15000);
    return () => { subscription.remove(); clearInterval(interval); };
  }, [isAuthenticated, activeCenterId]);

  const value = useMemo(() => ({ ...state, refresh, isEnabled: (key: ServiceKey) => isServiceEnabled(state, key) }), [state]);
  return <ServiceVisibilityContext.Provider value={value}>{children}</ServiceVisibilityContext.Provider>;
}

export function useServiceVisibility(): ServiceVisibilityContextValue {
  const context = useContext(ServiceVisibilityContext);
  if (!context) throw new Error("useServiceVisibility must be used inside ServiceVisibilityProvider");
  return context;
}

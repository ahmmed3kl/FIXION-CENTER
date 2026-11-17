import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { AppState, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectivityService } from "../core/connectivity";
import { DatabaseService } from "../core/database";
import "../core/database/registerAtomicRepositories";
import { initializeRTL } from "../core/localization";
import { ServiceVisibilityProvider } from "../core/services/ServiceVisibilityContext";
import { SyncEngine, SyncRepository } from "../core/sync";
import { registerBackgroundSync } from "../core/sync/backgroundTask";
import { ThemeProvider, useTheme } from "../core/theme";
import { createLastAuthorizedRoute, LastAuthorizedRouteStore } from "../features/auth/lastAuthorizedRoute";
import { useAuthStore } from "../features/auth/useAuthStore";
import { LoadingState } from "../shared/components";

const queryClient = new QueryClient();

try {
  initializeRTL();
} catch (error) {
  console.warn("RTL initialization warning:", error);
}

class StartupErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("RootLayout error boundary caught:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#F8FAFC" }}>
          <Text style={{ fontSize: 18, fontWeight: "800", color: "#B91C1C", textAlign: "right", marginBottom: 8 }}>
            تعذر تشغيل التطبيق
          </Text>
          <ScrollView style={{ maxHeight: 260, backgroundColor: "#FFFFFF", padding: 12, borderRadius: 12 }}>
            <Text selectable style={{ fontSize: 12, color: "#334155" }}>
              {this.state.error.message || String(this.state.error)}
            </Text>
          </ScrollView>
          <TouchableOpacity
            onPress={() => this.setState({ error: null })}
            style={{ marginTop: 16, backgroundColor: "#2563EB", padding: 12, borderRadius: 10, alignItems: "center" }}
          >
            <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>إعادة المحاولة</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const {
    isAuthenticated,
    activeCenterId,
    currentUser,
    isLoading,
    restoreSession,
    refreshPermissions,
  } = useAuthStore();
  const segments = useSegments();
  const router = useRouter();
  const lastSavedRouteRef = React.useRef<string | null>(null);

  useEffect(() => {
    restoreSession();
  }, []);

  useEffect(() => {
    if (isLoading || !isAuthenticated || !currentUser || !activeCenterId) {
      lastSavedRouteRef.current = null;
      return;
    }

    const route = createLastAuthorizedRoute(segments, currentUser, activeCenterId);
    if (!route) return;

    const routeKey = `${route.userId}:${route.centerId}:${route.routeName}`;
    if (lastSavedRouteRef.current === routeKey) return;
    lastSavedRouteRef.current = routeKey;

    LastAuthorizedRouteStore.save(route).catch((error) => {
      lastSavedRouteRef.current = null;
      console.error("Could not save the last authorized route:", error);
    });
  }, [activeCenterId, currentUser, isAuthenticated, isLoading, segments]);

  // Automatic synchronization:
  // 1. On app open / authentication restored.
  // 2. When internet connectivity is restored (offline -> online).
  // 3. When the app resumes from background (AppState active) if pending operations exist or data is stale.
  // SyncEngine locks and rate limiting protect against duplicate or concurrent sync cycles.
  useEffect(() => {
    if (!isAuthenticated || !activeCenterId) return;

    let disposed = false;
    const sync = () => {
      if (disposed) return;
      SyncEngine.syncCenterNow(activeCenterId).catch((error) => {
        console.warn("Automatic sync failed:", error);
      });
    };

    // 1. Immediate sync on app open / session restored
    sync();

    // 2. Network state monitoring: trigger sync on reconnect
    let previousConn = ConnectivityService.getState();
    const stopMonitoring = ConnectivityService.startMonitoring(() => {
      sync();
    });
    const unsubscribeConn = ConnectivityService.subscribe((state) => {
      if (state === "online" && previousConn !== "online") {
        refreshPermissions().catch((error) => {
          console.warn("Session permission refresh failed:", error);
        });
        sync();
      }
      previousConn = state;
    });

    registerBackgroundSync();

    // 3. AppState resume: trigger sync when foregrounded if operations are pending or cache is stale
    const appStateSubscription = AppState.addEventListener(
      "change",
      (state) => {
        if (state === "active") {
          if (disposed) return;
          if (ConnectivityService.getState() === "offline") return;
          refreshPermissions().catch((error) => {
            console.warn("Session permission refresh failed:", error);
          });
          const pendingCount =
            SyncRepository.getPendingOperationsCount(activeCenterId);
          const lastSync = SyncEngine.getLastSyncAttempt(activeCenterId);
          const isStale = Date.now() - lastSync > 15_000;
          if (pendingCount > 0 || isStale) {
            sync();
          }
        }
      },
    );

    // 4. Background periodic retry while app remains active
    const interval = setInterval(sync, 90_000);

    return () => {
      disposed = true;
      stopMonitoring();
      unsubscribeConn();
      appStateSubscription.remove();
      clearInterval(interval);
    };
  }, [isAuthenticated, activeCenterId, refreshPermissions]);

  useEffect(() => {
    if (!isAuthenticated || !currentUser) return;
    if (currentUser.role === "admin" || currentUser.role === "owner") return;
    const expiresAt = currentUser.accessExpiresAt;
    if (!expiresAt) return;
    const expiryMs = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiryMs)) return;

    const remainingMs = expiryMs - Date.now();
    if (remainingMs <= 0) {
      void useAuthStore.getState().logout();
      return;
    }

    const timer = setTimeout(() => {
      void useAuthStore.getState().logout();
    }, Math.min(remainingMs, 2_147_483_647));

    return () => clearTimeout(timer);
  }, [isAuthenticated, currentUser?.id, currentUser?.role, currentUser?.accessExpiresAt]);

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!isAuthenticated && !inAuthGroup) {
      router.replace("/(auth)/login");
    } else if (isAuthenticated && inAuthGroup) {
      router.replace("/(main)/dashboard");
    }
  }, [isAuthenticated, activeCenterId, isLoading, segments]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <LoadingState message="جارٍ تجهيز النظام..." />
      </View>
    );
  }

  return <>{children}</>;
}

function ThemeChrome({ children }: { children: React.ReactNode }) {
  const { isDarkMode, colors } = useTheme();
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.background, direction: "rtl" }}
    >
      <StatusBar style={isDarkMode ? "light" : "dark"} />
      {children}
    </View>
  );
}

export default function RootLayout() {
  const [dbError, setDbError] = useState<string | null>(null);
  const [dbReady, setDbReady] = useState<boolean>(() => {
    try {
      DatabaseService.init();
      return true;
    } catch (error: any) {
      return false;
    }
  });

  const retryInit = () => {
    try {
      DatabaseService.init();
      setDbError(null);
      setDbReady(true);
    } catch (error: any) {
      setDbError(error?.message || String(error));
    }
  };

  useEffect(() => {
    if (!dbReady && !dbError) {
      retryInit();
    }
  }, [dbReady, dbError]);

  if (!dbReady) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#F8FAFC" }}>
          <Text style={{ fontSize: 18, fontWeight: "800", color: "#B91C1C", textAlign: "right", marginBottom: 8 }}>
            تعذر تهيئة قاعدة البيانات
          </Text>
          <ScrollView style={{ maxHeight: 260, backgroundColor: "#FFFFFF", padding: 12, borderRadius: 12 }}>
            <Text selectable style={{ fontSize: 12, color: "#334155" }}>
              {dbError || "حدث خطأ أثناء فتح قاعدة البيانات المحلية."}
            </Text>
          </ScrollView>
          <TouchableOpacity
            onPress={retryInit}
            style={{ marginTop: 16, backgroundColor: "#2563EB", padding: 12, borderRadius: 10, alignItems: "center" }}
          >
            <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>إعادة المحاولة</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <StartupErrorBoundary>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <ThemeChrome>
              <AuthGuard>
                <ServiceVisibilityProvider>
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="(auth)" />
                    <Stack.Screen name="(main)" />
                  </Stack>
                </ServiceVisibilityProvider>
              </AuthGuard>
            </ThemeChrome>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </StartupErrorBoundary>
  );
}

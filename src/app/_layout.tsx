import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { AppState, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectivityService } from "../core/connectivity";
import { DatabaseService } from "../core/database";
import "../core/database/registerAtomicRepositories";
import { initializeRTL } from "../core/localization";
import { ServiceVisibilityProvider } from "../core/services/ServiceVisibilityContext";
import { SyncEngine, SyncRepository } from "../core/sync";
import { registerBackgroundSync } from "../core/sync/backgroundTask";
import { ThemeProvider, useTheme } from "../core/theme";
import { useAuthStore } from "../features/auth/useAuthStore";
import { LoadingState } from "../shared/components";

const queryClient = new QueryClient();

// Initialize RTL layout and SQLite tables once at startup
initializeRTL();
DatabaseService.init();

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, activeCenterId, isLoading, restoreSession, refreshPermissions } =
    useAuthStore();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    restoreSession();
  }, []);

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
    const interval = setInterval(sync, 30_000);

    return () => {
      disposed = true;
      stopMonitoring();
      unsubscribeConn();
      appStateSubscription.remove();
      clearInterval(interval);
    };
  }, [isAuthenticated, activeCenterId, refreshPermissions]);

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!isAuthenticated && !inAuthGroup) {
      router.replace("/(auth)/login");
    } else if (isAuthenticated && inAuthGroup) {
      router.replace("/(main)");
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
  return (
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
  );
}

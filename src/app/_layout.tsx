import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { AppState, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DatabaseService } from "../core/database";
import { ConnectivityService } from "../core/connectivity";
import { initializeRTL } from "../core/localization";
import { SyncEngine } from "../core/sync";
import { registerBackgroundSync } from "../core/sync/backgroundTask";
import "../core/database/registerAtomicRepositories";
import { ThemeProvider } from "../core/theme";
import { ServiceVisibilityProvider } from "../core/services/ServiceVisibilityContext";
import { useAuthStore } from "../features/auth/useAuthStore";
import { LoadingState } from "../shared/components";

const queryClient = new QueryClient();

// Initialize RTL layout and SQLite tables once at startup
initializeRTL();
DatabaseService.init();

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, activeCenterId, isLoading, restoreSession } =
    useAuthStore();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    restoreSession();
  }, []);

  // Keep the sync engine connected to the real device network state. When
  // Wi‑Fi/internet returns, pending local operations and server changes are
  // synchronized automatically for the active center.
  useEffect(() => {
    if (!isAuthenticated || !activeCenterId) return;

    let disposed = false;
    const sync = () => {
      if (disposed) return;
      SyncEngine.syncCenterNow(activeCenterId).catch((error) => {
        console.warn("Automatic sync failed:", error);
      });
    };
    const stopMonitoring = ConnectivityService.startMonitoring(() => {
      sync();
    });
    registerBackgroundSync();
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") sync();
    });
    // Retry while the app remains foregrounded. Native background execution
    // still requires a separately configured Expo background task.
    const interval = setInterval(sync, 30_000);

    return () => {
      disposed = true;
      stopMonitoring();
      appStateSubscription.remove();
      clearInterval(interval);
    };
  }, [isAuthenticated, activeCenterId]);

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

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <StatusBar style="dark" />
          <AuthGuard>
            <ServiceVisibilityProvider>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(main)" />
              </Stack>
            </ServiceVisibilityProvider>
          </AuthGuard>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

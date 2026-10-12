import { Ionicons } from "@expo/vector-icons";
import { Tabs, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { canAccessRoute, resolvePermissionRouteName } from "../../core/permissions/routeAccess";
import { resolveUserPermissions } from "../../core/permissions";
import { Strings } from "../../core/localization";
import { useTheme } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { canSwitchCenters } from "../../features/auth/centerAccess";

export const unstable_settings = {
  anchor: "index",
} as const;

export default function MainLayout() {
  const router = useRouter();
  const segments = useSegments();
  const currentUser = useAuthStore((state) => state.currentUser);
  const userPermissions = resolveUserPermissions(currentUser);
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { height, width } = useWindowDimensions();
  const compactLandscape = width > height && height < 520;
  const routeName = resolvePermissionRouteName(segments);
  const routeAllowed = routeName === "center-switch"
    ? canSwitchCenters(currentUser)
    : canAccessRoute(routeName, userPermissions);

  useEffect(() => {
    if (!routeAllowed) router.replace("/(main)/more" as any);
  }, [routeAllowed, router]);

  if (!routeAllowed) return <View style={{ flex: 1, backgroundColor: colors.background }} />;

  return (
    <Tabs
      initialRouteName="index"
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.slate400,
        tabBarStyle: {
          height: (compactLandscape ? 46 : 54) + insets.bottom,
          paddingBottom: (compactLandscape ? 2 : 4) + insets.bottom,
          paddingTop: compactLandscape ? 2 : 5,
          backgroundColor: colors.cardBackground,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          elevation: 0,
          shadowOpacity: 0,
          shadowRadius: 0,
        },
        tabBarLabelStyle: {
          fontSize: compactLandscape ? 10 : 12,
          fontWeight: "700",
          marginTop: 1,
        },
        tabBarItemStyle: { minHeight: compactLandscape ? 38 : 44, flex: 1 },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="more"
        options={{
          title: Strings.tabMore,
          tabBarIcon: ({ color, size }) => <Ionicons name="menu-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: Strings.tabDashboard,
          tabBarIcon: ({ focused, color, size }) => (
            <View style={[styles.homeTabIcon, focused ? { backgroundColor: colors.primaryLight } : null]}>
              <Ionicons name={focused ? "home" : "home-outline"} size={size} color={color} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="scanner"
        options={{
          // Scanner remains available from the dashboard/more menu, but is not a primary tab.
          href: null,
          title: Strings.tabScanner,
          tabBarIcon: ({ color, size }) => <Ionicons name="qr-code-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="students"
        options={{
          title: Strings.tabStudents,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen name="deleted-students" options={{ href: null, title: "الطلاب المحذوفون" }} />
      <Tabs.Screen name="homework-evaluations" options={{ href: null, title: "تقييم الواجب" }} />
      <Tabs.Screen
        name="academic"
        options={{
          href: null,
          title: Strings.tabAcademic,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="school-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="closing"
        options={{
          href: null,
          title: "الإغلاق",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="lock-closed-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          href: null,
          title: "الإشعارات",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          href: null,
          title: "التقارير",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bar-chart-outline" size={size} color={color} />
          ),
        }}
      />
      {/* Internal route opened from academic/group screens; never show as a bottom tab. */}
      <Tabs.Screen name="group-details" options={{ href: null }} />
      <Tabs.Screen name="groups" options={{ href: null }} />
      <Tabs.Screen name="grade-groups" options={{ href: null }} />
      <Tabs.Screen name="center-accounts" options={{ href: null }} />
      <Tabs.Screen name="center-account-permissions" options={{ href: null, title: "صلاحيات الحساب" }} />
      <Tabs.Screen name="absence-reports" options={{ href: null }} />
      <Tabs.Screen name="absence-group" options={{ href: null }} />
      <Tabs.Screen name="packages" options={{ href: null }} />
      <Tabs.Screen name="grades" options={{ href: null }} />
      <Tabs.Screen name="center-switch" options={{ href: null }} />
      <Tabs.Screen name="sync-debug" options={{ href: null }} />
      <Tabs.Screen name="financial-reports" options={{ href: null }} />
      <Tabs.Screen name="opening-balance" options={{ href: null }} />
      <Tabs.Screen name="debt-adjustments" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  homeTabIcon: {
    minWidth: 56,
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
});

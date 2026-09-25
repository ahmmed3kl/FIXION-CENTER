import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Strings } from "../../core/localization";
import { Colors, useTheme } from "../../core/theme";

export default function MainLayout() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.slate400,
        tabBarStyle: {
          height: 64 + insets.bottom,
          paddingBottom: 8 + insets.bottom,
          paddingTop: 8,
          backgroundColor: colors.cardBackground,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="students"
        options={{
          title: Strings.tabStudents,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: Strings.tabDashboard,
          tabBarIcon: ({ focused }) => (
            <View style={[styles.homeTabIcon, { backgroundColor: colors.primary }, focused ? [styles.homeTabIconActive, { backgroundColor: colors.primaryDark }] : null]}>
              <Ionicons name="home" size={24} color={colors.white} />
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
        name="more"
        options={{
          title: "المزيد",
          tabBarIcon: ({ color, size }) => <Ionicons name="menu-outline" size={size} color={color} />,
        }}
      />
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
      <Tabs.Screen name="absence-reports" options={{ href: null }} />
      <Tabs.Screen name="packages" options={{ href: null }} />
      <Tabs.Screen name="grades" options={{ href: null }} />
      <Tabs.Screen name="center-switch" options={{ href: null }} />
      <Tabs.Screen name="sync-debug" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  homeTabIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    transform: [{ translateY: -7 }],
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  homeTabIconActive: {
    backgroundColor: Colors.primaryDark,
    transform: [{ translateY: -7 }, { scale: 1.05 }],
  },
});

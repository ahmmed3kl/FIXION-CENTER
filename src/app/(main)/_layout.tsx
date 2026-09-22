import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Strings } from "../../core/localization";
import { Colors } from "../../core/theme";

export default function MainLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.slate400,
        tabBarStyle: {
          height: 64 + insets.bottom,
          paddingBottom: 8 + insets.bottom,
          paddingTop: 8,
          backgroundColor: Colors.white,
          borderTopColor: Colors.border,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: Strings.tabDashboard,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="scanner"
        options={{
          // Attendance scanning is opened from the dashboard/more menu. Keep
          // it out of the persistent bottom bar so navigation back follows the
          // actual previous screen instead of landing on the dashboard tab.
          href: null,
          title: Strings.tabScanner,
          tabBarIcon: ({ color, focused }) => (
            <View
              style={[
                styles.scannerTabIcon,
                focused ? styles.scannerTabIconActive : null,
              ]}
            >
              <Ionicons name="qr-code" size={24} color={Colors.white} />
            </View>
          ),
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
      <Tabs.Screen
        name="more"
        options={{
          title: "المزيد",
          tabBarIcon: ({ color, size }) => <Ionicons name="menu-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  scannerTabIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  scannerTabIconActive: {
    backgroundColor: Colors.primaryDark,
    transform: [{ scale: 1.05 }],
  },
});

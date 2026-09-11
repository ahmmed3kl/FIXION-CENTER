import { useRouter } from "expo-router";
import { useEffect } from "react";
import {
  SafeAreaView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { Colors, Spacing, Typography } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";

export default function SelectCenterScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();

  useEffect(() => {
    if (isAuthenticated) {
      router.replace("/(main)");
    } else {
      router.replace("/(auth)/login");
    }
  }, [isAuthenticated, router]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.title}>جارٍ التحويل...</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  container: {
    flex: 1,
    padding: Spacing.xl,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: Spacing.xxl,
  },
  title: {
    ...Typography.h1,
    color: Colors.slate900,
    marginBottom: Spacing.xs,
  },
  subtitle: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  list: {
    gap: Spacing.md,
  },
  centerCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: Spacing.lg,
  },
  centerCardSelected: {
    borderColor: Colors.primary,
    borderWidth: 2,
    backgroundColor: Colors.primaryMuted,
  },
  centerInfo: {
    flex: 1,
  },
  centerName: {
    ...Typography.bodyBold,
    color: Colors.slate900,
  },
  centerCode: {
    ...Typography.caption,
    color: Colors.slate500,
    marginTop: Spacing.xs,
  },
  radioButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: Colors.slate300,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: Spacing.md,
  },
  radioButtonSelected: {
    borderColor: Colors.primary,
  },
  radioDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.primary,
  },
});

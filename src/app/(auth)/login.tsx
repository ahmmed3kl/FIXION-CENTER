import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Strings } from "../../core/localization";
import { BorderRadius, Colors, Spacing, Typography } from "../../core/theme";
import { useAuthStore } from "../../features/auth/useAuthStore";
import { AppButton, AppCard, AppInput } from "../../shared/components";

export default function LoginScreen() {
  const [email, setEmail] = useState("admin@center1.com");
  const [password, setPassword] = useState("123456");
  const [fieldError, setFieldError] = useState("");

  const { login, isLoading, error, clearError } = useAuthStore();

  const handleLogin = async () => {
    setFieldError("");
    clearError();

    if (!email.trim()) {
      setFieldError("يرجى إدخال البريد الإلكتروني");
      return;
    }

    if (!password.trim()) {
      setFieldError("يرجى إدخال كلمة المرور");
      return;
    }

    await login(email.trim(), password);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo & Header */}
          <View style={styles.header}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoText}>FIXION</Text>
            </View>
            <Text style={styles.title}>{Strings.loginTitle}</Text>
            <Text style={styles.subtitle}>{Strings.loginSubtitle}</Text>
          </View>

          {/* Form Card */}
          <AppCard style={styles.formCard}>
            <AppInput
              label={Strings.emailLabel}
              placeholder={Strings.emailPlaceholder}
              keyboardType="email-address"
              autoCapitalize="none"
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                if (fieldError) setFieldError("");
              }}
              error={fieldError}
            />

            <AppInput
              label={Strings.passwordLabel}
              placeholder={Strings.passwordPlaceholder}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />

            {error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{error}</Text>
              </View>
            ) : null}

            <AppButton
              title="دخول"
              onPress={handleLogin}
              loading={isLoading}
              size="lg"
              style={{ marginTop: Spacing.md }}
            />
          </AppCard>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: Spacing.xl,
  },
  header: {
    alignItems: "center",
    marginBottom: Spacing.xxl,
  },
  logoBadge: {
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.md,
  },
  logoText: {
    fontSize: 22,
    fontWeight: "800",
    color: Colors.white,
    letterSpacing: 2,
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
  formCard: {
    padding: Spacing.xl,
  },
  errorBanner: {
    backgroundColor: Colors.dangerLight,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.md,
  },
  errorBannerText: {
    ...Typography.captionBold,
    color: Colors.dangerText,
    textAlign: "right",
  },
  demoSection: {
    marginTop: Spacing.xxl,
    alignItems: "center",
  },
  demoTitle: {
    ...Typography.captionBold,
    color: Colors.slate500,
    marginBottom: Spacing.sm,
  },
  demoButtonsRow: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  demoButton: {
    flex: 1,
  },
});

import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Strings } from "../../core/localization";
import { BorderRadius, Colors, Shadows, Spacing, Typography } from "../../core/theme";
import { SecureStorageService } from "../../core/storage";
import { useAuthStore } from "../../features/auth/useAuthStore";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const { login, isLoading, error, clearError } = useAuthStore();

  useEffect(() => {
    SecureStorageService.getItem("remembered_login_email").then((value) => {
      if (value) {
        setEmail(value);
        setRememberMe(true);
      }
    });
  }, []);

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
    if (rememberMe) await SecureStorageService.setItem("remembered_login_email", email.trim());
    else await SecureStorageService.removeItem("remembered_login_email");
    await login(email.trim(), password);
  };

  const clearFieldError = (value: string, setter: (next: string) => void) => {
    setter(value);
    if (fieldError) setFieldError("");
    if (error) clearError();
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "bottom", "left", "right"]}>
      <View pointerEvents="none" style={styles.backgroundShapes}>
        <View style={styles.shapeTop} />
        <View style={styles.shapeBottom} />
        <View style={styles.shapeBottomAccent} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.keyboard}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.brandArea}>
            <Image source={require("../../../assets/images/icon.png")} style={styles.logoImage} resizeMode="contain" />
            <Text style={styles.brandName}>FIXION</Text>
            <Text style={styles.brandTagline}>EDUCATION. ORGANIZED.</Text>
          </View>

          <View style={styles.welcomeArea}>
            <Text style={styles.title}>مرحباً بك</Text>
            <Text style={styles.subtitle}>سجل الدخول للوصول إلى حسابك</Text>
          </View>

          <View style={styles.form}>
            <View style={[styles.inputShell, fieldError && !email.trim() ? styles.inputShellError : null]}>
              <Ionicons name="mail-outline" size={25} color={Colors.slate500} />
              <View style={styles.inputContent}>
                <Text style={styles.inputLabel}>{Strings.emailLabel}</Text>
                <TextInput
                  value={email}
                  onChangeText={(value) => clearFieldError(value, setEmail)}
                  placeholder={Strings.emailPlaceholder}
                  placeholderTextColor={Colors.slate400}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  textAlign="right"
                  style={styles.textInput}
                />
              </View>
            </View>

            <View style={[styles.inputShell, fieldError && !password.trim() ? styles.inputShellError : null]}>
              <Ionicons name="lock-closed-outline" size={25} color={Colors.slate500} />
              <View style={styles.inputContent}>
                <Text style={styles.inputLabel}>{Strings.passwordLabel}</Text>
                <TextInput
                  value={password}
                  onChangeText={(value) => clearFieldError(value, setPassword)}
                  placeholder="••••••••"
                  placeholderTextColor={Colors.slate400}
                  secureTextEntry={!showPassword}
                  textAlign="right"
                  style={styles.textInput}
                />
              </View>
              <TouchableOpacity onPress={() => setShowPassword((value) => !value)} accessibilityLabel={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} style={styles.eyeButton}>
                <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={22} color={Colors.slate500} />
              </TouchableOpacity>
            </View>

            {fieldError ? <Text style={styles.fieldError}>{fieldError}</Text> : null}
            {error ? <View style={styles.errorBanner}><Text style={styles.errorBannerText}>{error}</Text></View> : null}

            <TouchableOpacity style={styles.rememberRow} onPress={() => setRememberMe((value) => !value)} activeOpacity={0.75}>
              <Text style={styles.rememberText}>تذكرني</Text>
              <View style={[styles.checkbox, rememberMe && styles.checkboxActive]}>{rememberMe ? <Ionicons name="checkmark" size={18} color={Colors.white} /> : null}</View>
            </TouchableOpacity>

            <TouchableOpacity style={styles.loginButton} onPress={handleLogin} disabled={isLoading} activeOpacity={0.85}>
              {isLoading ? <Ionicons name="sync-outline" size={25} color={Colors.white} /> : <><Text style={styles.loginButtonText}>دخول</Text><Ionicons name="log-in-outline" size={28} color={Colors.white} /></>}
            </TouchableOpacity>
          </View>

          <View style={styles.footer}><View style={styles.footerLine} /><Text style={styles.footerText}>إدارة أسهل .. مستقبل أفضل</Text></View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F8FBFF" },
  keyboard: { flex: 1 },
  backgroundShapes: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  shapeTop: { position: "absolute", width: 380, height: 300, borderRadius: 180, backgroundColor: "#E7F2FF", top: -170, left: -150, transform: [{ rotate: "-28deg" }] },
  shapeBottom: { position: "absolute", width: 520, height: 190, borderRadius: 260, backgroundColor: "#E5F1FF", bottom: -75, left: -180, transform: [{ rotate: "18deg" }] },
  shapeBottomAccent: { position: "absolute", width: 370, height: 140, borderRadius: 200, backgroundColor: "#D5E9FF", bottom: -70, right: -120, transform: [{ rotate: "-22deg" }] },
  scrollContent: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingVertical: 28 },
  brandArea: { alignItems: "center", marginBottom: 22 },
  logoImage: { width: 142, height: 142, borderRadius: 32, marginBottom: 10 },
  brandName: { color: Colors.slate900, fontSize: 42, fontWeight: "900", letterSpacing: 1.5 },
  brandTagline: { color: Colors.slate400, fontSize: 11, fontWeight: "700", letterSpacing: 3.5, marginTop: 1 },
  welcomeArea: { alignItems: "center", marginBottom: 24 },
  title: { color: Colors.slate900, fontSize: 34, fontWeight: "800", textAlign: "center" },
  subtitle: { color: Colors.slate500, fontSize: 18, marginTop: 6, textAlign: "center" },
  form: { width: "100%", gap: 12 },
  inputShell: { minHeight: 80, backgroundColor: "rgba(255,255,255,0.94)", borderWidth: 1.5, borderColor: "#DCE7F5", borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 13, ...Shadows.subtle },
  inputShellError: { borderColor: Colors.danger },
  inputContent: { flex: 1, alignItems: "stretch" },
  inputLabel: { color: Colors.slate600, fontSize: 15, fontWeight: "700", textAlign: "right", marginBottom: 1 },
  textInput: { color: Colors.slate900, fontSize: 17, minHeight: 27, padding: 0 },
  eyeButton: { padding: 5 },
  fieldError: { color: Colors.dangerText, fontSize: 12, textAlign: "right", marginHorizontal: 6 },
  errorBanner: { backgroundColor: Colors.dangerLight, borderRadius: BorderRadius.md, padding: 11 },
  errorBannerText: { color: Colors.dangerText, fontSize: 13, textAlign: "right" },
  rememberRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 10, alignSelf: "flex-end", paddingVertical: 4 },
  rememberText: { color: Colors.slate700, fontSize: 17, fontWeight: "600" },
  checkbox: { width: 28, height: 28, borderRadius: 7, borderWidth: 1.5, borderColor: Colors.slate300, alignItems: "center", justifyContent: "center", backgroundColor: Colors.white },
  checkboxActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  loginButton: { height: 62, borderRadius: 20, backgroundColor: Colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 5, ...Shadows.elevated },
  loginButtonText: { color: Colors.white, fontSize: 22, fontWeight: "800" },
  footer: { alignItems: "center", marginTop: 42, paddingBottom: 4 },
  footerLine: { width: 66, height: 4, borderRadius: 3, backgroundColor: Colors.primary, marginBottom: 14 },
  footerText: { color: Colors.slate500, fontSize: 18, fontWeight: "600", textAlign: "center" },
});

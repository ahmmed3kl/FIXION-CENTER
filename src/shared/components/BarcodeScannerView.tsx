import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Spacing } from "../../core/theme";
import { normalizeScannedBarcode } from "./barcodeScannerValue";

export const FIXION_BARCODE_TYPES = [
  "code128",
  "code39",
  "ean13",
  "ean8",
  "upc_a",
  "upc_e",
  "itf14",
] as const;

type Props = {
  onDetected: (data: string) => void;
  onClose: () => void;
  allowedBarcodeTypes?: readonly string[];
  title?: string;
  hint?: string;
};

/** Shared native barcode reader used by attendance, students and add-student. */
export function BarcodeScannerView({
  onDetected,
  onClose,
  allowedBarcodeTypes = FIXION_BARCODE_TYPES,
  title = "مسح كارت الطالب",
  hint = "وجّه الكاميرا نحو الباركود في أي موضع على الشاشة",
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const lockedRef = useRef(false);
  const permissionRequestInFlightRef = useRef(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
  }, []);

  const askForPermission = useCallback(async () => {
    if (permissionRequestInFlightRef.current) return;
    permissionRequestInFlightRef.current = true;
    setPermissionError(null);
    try {
      await requestPermission();
    } catch {
      setPermissionError("تعذر طلب إذن الكاميرا. حاول مرة أخرى أو تحقق من إعدادات الجهاز.");
    } finally {
      permissionRequestInFlightRef.current = false;
    }
  }, [requestPermission]);

  useEffect(() => {
    if (permission?.status === "undetermined") {
      void askForPermission();
    }
  }, [askForPermission, permission]);

  const handleDetected = ({ data }: { data: string }) => {
    const value = normalizeScannedBarcode(data);
    if (!value || lockedRef.current) return;
    lockedRef.current = true;
    setTorch(false);
    onDetected(value);
    unlockTimerRef.current = setTimeout(() => { lockedRef.current = false; }, 900);
  };

  if (!permission?.granted) {
    return (
      <Modal
        visible
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={onClose}
      >
        <SafeAreaView style={styles.permissionRoot} edges={["top", "bottom"]}>
          {permission ? <Ionicons name="camera-outline" size={38} color={Colors.primary} /> : <ActivityIndicator size="large" color={Colors.primary} />}
          <Text style={styles.permissionTitle}>{title}</Text>
          <Text style={styles.permissionHint}>
            {!permission
              ? "جارٍ التحقق من إذن الكاميرا..."
              : permission.canAskAgain
                ? "اسمح باستخدام الكاميرا لمسح الكارت."
                : "تم رفض صلاحية الكاميرا. فعّلها من إعدادات الجهاز ثم أعد المحاولة."}
          </Text>
          {permissionError ? <Text style={styles.permissionError}>{permissionError}</Text> : null}
          <View style={styles.permissionActions}>
            {permission?.canAskAgain ? (
              <TouchableOpacity style={styles.action} onPress={() => void askForPermission()}>
                <Text style={styles.actionText}>السماح بالكاميرا</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.cancelAction} onPress={onClose}>
              <Text style={styles.cancelText}>إغلاق</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    );
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          active
          autofocus="on"
          zoom={0}
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: [...allowedBarcodeTypes] as any }}
          onBarcodeScanned={handleDetected}
          onMountError={(event) => setCameraError(event.message || "تعذر تشغيل معاينة الكاميرا.")}
        />
        <SafeAreaView style={styles.controls} edges={["top", "bottom"]}>
          <View style={styles.topBar}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="إغلاق الماسح" style={styles.iconButton} onPress={onClose}>
              <Ionicons name="close" size={25} color={Colors.white} />
            </TouchableOpacity>
          </View>
          <View pointerEvents="none" style={styles.guideArea}>
            <View style={styles.scanFrame} />
            {cameraError ? <Text style={styles.cameraError}>{cameraError}</Text> : null}
            <Text style={styles.overlayHint}>{hint}</Text>
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.action} onPress={() => setTorch((value) => !value)}>
              <Ionicons name={torch ? "flash" : "flash-outline"} size={19} color={Colors.white} />
              <Text style={styles.actionText}>{torch ? "إغلاق الفلاش" : "تشغيل الفلاش"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelAction} onPress={onClose}>
              <Text style={styles.cancelText}>إغلاق الماسح</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, overflow: "hidden", backgroundColor: Colors.slate900 },
  controls: { flex: 1, justifyContent: "space-between" },
  permissionRoot: { flex: 1, padding: Spacing.lg, alignItems: "center", justifyContent: "center", gap: Spacing.md, backgroundColor: Colors.slate50 },
  permissionTitle: { color: Colors.slate900, fontSize: 18, fontWeight: "900", textAlign: "center" },
  permissionHint: { color: Colors.slate600, fontSize: 14, textAlign: "center", lineHeight: 21 },
  permissionError: { color: Colors.dangerText, fontSize: 13, textAlign: "center", lineHeight: 20 },
  permissionActions: { alignItems: "center", gap: Spacing.sm, marginTop: Spacing.sm },
  title: { color: Colors.white, fontSize: 16, fontWeight: "900", textAlign: "center" },
  topBar: { minHeight: 64, paddingHorizontal: Spacing.md, flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(15,23,42,.62)" },
  iconButton: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,.18)" },
  guideArea: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: Spacing.md },
  scanFrame: { width: "88%", height: "30%", minHeight: 150, maxHeight: 280, borderWidth: 2, borderColor: Colors.white, borderRadius: 18, backgroundColor: "transparent" },
  overlayHint: { color: Colors.white, fontSize: 13, fontWeight: "800", marginTop: 14, textAlign: "center", backgroundColor: "rgba(15,23,42,.72)", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10 },
  cameraError: { color: Colors.white, fontSize: 14, fontWeight: "800", textAlign: "center", marginTop: Spacing.md, backgroundColor: Colors.dangerText, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, borderRadius: 10 },
  actions: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 10, padding: Spacing.md, backgroundColor: "rgba(15,23,42,.72)" },
  action: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  actionText: { color: Colors.white, fontSize: 12, fontWeight: "800" },
  cancelAction: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,.65)", alignItems: "center", justifyContent: "center" },
  cancelText: { color: Colors.white, fontSize: 12, fontWeight: "800" },
});

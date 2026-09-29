import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";
import { Colors, BorderRadius, Spacing } from "../../core/theme";

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
  style?: ViewStyle;
  allowedBarcodeTypes?: readonly string[];
  title?: string;
  hint?: string;
};

/** Shared native barcode reader used by attendance, students and add-student. */
export function BarcodeScannerView({
  onDetected,
  onClose,
  style,
  allowedBarcodeTypes = FIXION_BARCODE_TYPES,
  title = "مسح كارت الطالب",
  hint = "وجّه الكاميرا نحو الباركود",
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const lockedRef = useRef(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (unlockTimerRef.current) clearTimeout(unlockTimerRef.current);
  }, []);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  const handleDetected = ({ data }: { data: string }) => {
    const value = String(data || "").trim();
    if (!value || lockedRef.current) return;
    lockedRef.current = true;
    setTorch(false);
    onDetected(value);
    unlockTimerRef.current = setTimeout(() => { lockedRef.current = false; }, 900);
  };

  if (!permission?.granted) {
    return (
      <View style={[styles.root, styles.permissionRoot, style]}>
        <Ionicons name="camera-outline" size={34} color={Colors.primary} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.hint}>{permission?.canAskAgain ? "اسمح باستخدام الكاميرا لمسح الكارت." : "تم رفض صلاحية الكاميرا. فعّلها من إعدادات الجهاز."}</Text>
        <View style={styles.actions}>
          {permission?.canAskAgain ? <TouchableOpacity style={styles.action} onPress={() => void requestPermission()}><Text style={styles.actionText}>السماح بالكاميرا</Text></TouchableOpacity> : <TouchableOpacity style={styles.action} onPress={() => Alert.alert("صلاحية الكاميرا", "افتح إعدادات الجهاز وفعّل صلاحية الكاميرا ثم حاول مرة أخرى.")}><Text style={styles.actionText}>معرفة طريقة التفعيل</Text></TouchableOpacity>}
          <TouchableOpacity style={styles.cancelAction} onPress={onClose}><Text style={styles.cancelText}>إلغاء</Text></TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, style]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        autofocus="on"
        zoom={0}
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: [...allowedBarcodeTypes] as any }}
        onBarcodeScanned={handleDetected}
      />
      <View pointerEvents="none" style={styles.overlay}>
        <View style={styles.scanFrame} />
        <Text style={styles.overlayHint}>{hint}</Text>
      </View>
      <View style={styles.topBar}><Text style={styles.title}>{title}</Text><TouchableOpacity style={styles.iconButton} onPress={onClose}><Ionicons name="close" size={23} color={Colors.white} /></TouchableOpacity></View>
      <View style={styles.actions}><TouchableOpacity style={styles.action} onPress={() => setTorch((value) => !value)}><Ionicons name={torch ? "flash" : "flash-outline"} size={19} color={Colors.white} /><Text style={styles.actionText}>{torch ? "إغلاق الفلاش" : "تشغيل الفلاش"}</Text></TouchableOpacity><TouchableOpacity style={styles.cancelAction} onPress={onClose}><Text style={styles.cancelText}>إلغاء</Text></TouchableOpacity></View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { minHeight: 290, overflow: "hidden", borderRadius: BorderRadius.lg, backgroundColor: Colors.slate900, justifyContent: "space-between" },
  permissionRoot: { padding: Spacing.lg, alignItems: "center", justifyContent: "center", gap: Spacing.sm, backgroundColor: Colors.slate50 },
  title: { color: Colors.white, fontSize: 16, fontWeight: "900", textAlign: "center" },
  hint: { color: Colors.slate500, fontSize: 12, textAlign: "center", lineHeight: 19 },
  topBar: { padding: Spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "rgba(15,23,42,.45)" },
  iconButton: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,.18)" },
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  scanFrame: { width: "78%", height: 112, borderWidth: 2, borderColor: Colors.white, borderRadius: 18, backgroundColor: "transparent" },
  overlayHint: { color: Colors.white, fontSize: 12, fontWeight: "800", marginTop: 14, backgroundColor: "rgba(15,23,42,.55)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: Spacing.md, backgroundColor: "rgba(15,23,42,.58)" },
  action: { minHeight: 40, paddingHorizontal: 14, borderRadius: 10, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  actionText: { color: Colors.white, fontSize: 12, fontWeight: "800" },
  cancelAction: { minHeight: 40, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: "rgba(255,255,255,.65)", alignItems: "center", justifyContent: "center" },
  cancelText: { color: Colors.white, fontSize: 12, fontWeight: "800" },
});

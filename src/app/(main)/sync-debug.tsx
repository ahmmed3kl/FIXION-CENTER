import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectivityService } from "../../core/connectivity";
import { Colors, Spacing, Typography } from "../../core/theme";
import { SyncEngine, SyncRepository } from "../../core/sync";
import { useAuthStore } from "../../features/auth/useAuthStore";
import type { SyncOperation } from "../../shared/types";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  syncing: "Syncing",
  synced: "Synced",
  failed: "Failed",
  conflict: "Conflict",
};

const STATUS_COLORS: Record<string, string> = {
  pending: Colors.warningText,
  syncing: Colors.primary,
  synced: Colors.successText,
  failed: Colors.dangerText,
  conflict: Colors.dangerText,
};

function formatDate(value?: string) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function SyncDebugScreen() {
  const activeCenter = useAuthStore((state) => state.activeCenter);
  const [stats, setStats] = useState({ pending: 0, syncing: 0, synced: 0, failed: 0, conflict: 0, total: 0 });
  const [operations, setOperations] = useState<SyncOperation[]>([]);
  const [unsynced, setUnsynced] = useState<SyncOperation[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastResult, setLastResult] = useState("");
  const [loadError, setLoadError] = useState("");

  const load = useCallback(() => {
    if (!activeCenter) return;
    try {
      setLoadError("");
      setStats(SyncRepository.getStats(activeCenter.id));
      setOperations(SyncRepository.getRecentOperations(activeCenter.id, 100));
      setUnsynced(SyncRepository.getUnsyncedOperations(activeCenter.id, 200));
    } catch (error: any) {
      setLoadError(error?.message || "Unable to read local sync data.");
    } finally {
      setLoading(false);
    }
  }, [activeCenter]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const syncNow = async () => {
    if (!activeCenter) return;
    setRefreshing(true);
    try {
      const result = await SyncEngine.syncCenterNow(activeCenter.id);
      setLastResult(`Synced: ${result.syncedCount} | Errors: ${result.errors} | Conflicts: ${result.conflicts}`);
    } catch (error: any) {
      setLastResult(`Failed: ${error?.message || "Unknown error"}`);
    } finally {
      load();
      setRefreshing(false);
    }
  };

  if (!activeCenter) {
    return <SafeAreaView style={styles.safe}><Text style={styles.empty}>No active center.</Text></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={syncNow} />}
      >
        <View style={styles.titleRow}>
          <View>
            <Text style={styles.title}>Sync Debug</Text>
            <Text style={styles.subtitle}>{activeCenter.name}</Text>
          </View>
          <Ionicons name="bug-outline" size={30} color={Colors.primary} />
        </View>

        <View style={styles.connectionCard}>
          <Text style={styles.connectionLabel}>Connection</Text>
          <Text style={styles.connectionValue}>{ConnectivityService.getState()}</Text>
        </View>

        <TouchableOpacity style={styles.syncButton} onPress={syncNow} disabled={refreshing}>
          {refreshing ? <ActivityIndicator color={Colors.white} /> : <Ionicons name="sync-outline" size={20} color={Colors.white} />}
          <Text style={styles.syncButtonText}>Sync now</Text>
        </TouchableOpacity>
        {lastResult ? <Text style={styles.result}>{lastResult}</Text> : null}
        {loadError ? <Text style={styles.error} selectable>{loadError}</Text> : null}

        <View style={styles.statsGrid}>
          {[
            ["Synced", stats.synced, Colors.successText],
            ["Pending", stats.pending, Colors.warningText],
            ["Syncing", stats.syncing, Colors.primary],
            ["Failed", stats.failed, Colors.dangerText],
            ["Conflicts", stats.conflict, Colors.dangerText],
          ].map(([label, value, color]) => (
            <View key={String(label)} style={styles.statCard}>
              <Text style={[styles.statValue, { color: String(color) }]}>{String(value)}</Text>
              <Text style={styles.statLabel}>{String(label)}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Recent operations ({operations.length})</Text>
        {loading ? <ActivityIndicator color={Colors.primary} /> : operations.length === 0 ? <Text style={styles.empty}>No operations recorded.</Text> : operations.map((operation) => (
          <View key={operation.operationId} style={styles.operationCard}>
            <View style={styles.operationHeader}>
              <Text style={[styles.status, { color: STATUS_COLORS[operation.status] || Colors.slate600 }]}>
                {STATUS_LABELS[operation.status] || operation.status}
              </Text>
              <Text style={styles.entity}>{operation.entityType} · {operation.operationType}</Text>
            </View>
            <Text style={styles.operationId} numberOfLines={1}>{operation.operationId}</Text>
            <Text style={styles.meta}>Entity: {operation.entityId}</Text>
            <Text style={styles.meta}>{formatDate(operation.createdAt)} · attempts: {operation.retryCount || 0}</Text>
            {operation.lastError ? <Text style={styles.error} selectable>{operation.lastError}</Text> : null}
          </View>
        ))}

        <Text style={styles.sectionTitle}>Not synced / not uploaded ({unsynced.length})</Text>
        {unsynced.length === 0 ? (
          <View style={styles.allClear}>
            <Ionicons name="checkmark-circle-outline" size={22} color={Colors.successText} />
            <Text style={styles.allClearText}>Everything is acknowledged by the server.</Text>
          </View>
        ) : unsynced.map((operation) => (
          <View key={`unsynced-${operation.operationId}`} style={styles.unsyncedCard}>
            <View style={styles.operationHeader}>
              <Text style={[styles.status, { color: STATUS_COLORS[operation.status] || Colors.dangerText }]}>
                {STATUS_LABELS[operation.status] || operation.status}
              </Text>
              <Text style={styles.entity}>{operation.entityType} · {operation.operationType}</Text>
            </View>
            <Text style={styles.operationId} numberOfLines={1}>{operation.operationId}</Text>
            <Text style={styles.meta}>Entity: {operation.entityId}</Text>
            <Text style={styles.meta}>Attempts: {operation.retryCount || 0} · {formatDate(operation.createdAt)}</Text>
            {operation.lastError ? <Text style={styles.error} selectable>{operation.lastError}</Text> : <Text style={styles.pendingReason}>Waiting for the next sync attempt.</Text>}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.background },
  content: { padding: Spacing.lg, gap: Spacing.md },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { ...Typography.h2, color: Colors.slate900 },
  subtitle: { color: Colors.slate500, marginTop: 2 },
  connectionCard: { backgroundColor: Colors.white, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, flexDirection: "row", justifyContent: "space-between" },
  connectionLabel: { color: Colors.slate600, fontWeight: "700" },
  connectionValue: { color: Colors.successText, fontWeight: "900" },
  syncButton: { backgroundColor: Colors.primary, borderRadius: 12, minHeight: 46, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  syncButtonText: { color: Colors.white, fontWeight: "800", fontSize: 15 },
  result: { color: Colors.slate600, textAlign: "center", fontSize: 12 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  statCard: { width: "48%", backgroundColor: Colors.white, borderRadius: 12, padding: Spacing.md, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  statValue: { fontSize: 22, fontWeight: "900" },
  statLabel: { color: Colors.slate600, fontWeight: "700", marginTop: 2 },
  sectionTitle: { ...Typography.h3, color: Colors.slate900, marginTop: Spacing.sm },
  operationCard: { backgroundColor: Colors.white, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, padding: Spacing.md, gap: 4 },
  unsyncedCard: { backgroundColor: "#FFF7ED", borderRadius: 12, borderWidth: 1, borderColor: "#FED7AA", padding: Spacing.md, gap: 4 },
  operationHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  status: { fontWeight: "900", fontSize: 13 },
  entity: { color: Colors.slate800, fontWeight: "800", fontSize: 13 },
  operationId: { color: Colors.slate500, fontSize: 11 },
  meta: { color: Colors.slate600, fontSize: 12 },
  error: { color: Colors.dangerText, backgroundColor: Colors.dangerLight, borderRadius: 6, padding: 6, fontSize: 12 },
  pendingReason: { color: Colors.warningText, fontSize: 12 },
  allClear: { backgroundColor: Colors.successLight, borderRadius: 12, padding: Spacing.md, flexDirection: "row", alignItems: "center", gap: 8 },
  allClearText: { color: Colors.successText, fontWeight: "700" },
  empty: { color: Colors.slate500, textAlign: "center", padding: Spacing.xl },
});

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { SyncEngine } from "./index";
import { useAuthStore } from "../../features/auth/useAuthStore";

export const SYNC_BACKGROUND_TASK = "fixion-sync-background";

TaskManager.defineTask(SYNC_BACKGROUND_TASK, async () => {
  try {
    const auth = useAuthStore.getState();
    if (!auth.isAuthenticated || !auth.activeCenterId) {
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    const result = await SyncEngine.syncCenterNow(auth.activeCenterId);
    return result.state === "error"
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(SYNC_BACKGROUND_TASK, {
      minimumInterval: 15,
    });
  } catch (error) {
    // Expo Go and unsupported platforms can reject registration. Foreground
    // connectivity sync remains active in those environments.
    console.warn("Background sync registration unavailable:", error);
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(SYNC_BACKGROUND_TASK);
  } catch {
    // Safe to ignore when the task was never registered.
  }
}

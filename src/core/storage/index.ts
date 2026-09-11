import * as SecureStore from "expo-secure-store";

export class SecureStorageService {
  private static memoryFallback = new Map<string, string>();

  static async setItem(key: string, value: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      this.memoryFallback.set(key, value);
    }
  }

  static async getItem(key: string): Promise<string | null> {
    try {
      const val = await SecureStore.getItemAsync(key);
      if (val !== null) return val;
    } catch {
      // fallback
    }
    return this.memoryFallback.get(key) || null;
  }

  static async removeItem(key: string): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // fallback
    }
    this.memoryFallback.delete(key);
  }

  static async clearSession(): Promise<void> {
    await this.removeItem("session_token");
    await this.removeItem("user_session");
    await this.removeItem("active_center_id");
  }
}

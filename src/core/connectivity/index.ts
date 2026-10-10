import axios from "axios";
import { env } from "../../config/env";
import { ConnectivityState } from "../../shared/types";

type Listener = (state: ConnectivityState) => void;
export type DeviceNetworkState = "unknown" | "connected" | "disconnected";
export type BackendReachability = "unknown" | "available" | "unavailable" | "degraded";

export interface ConnectivityDiagnostics {
  deviceNetwork: DeviceNetworkState;
  backend: BackendReachability;
  backendCheckedAt: string | null;
  lastApiSuccessAt: string | null;
}

export function resolveDeviceNetworkState(networkState: {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}): DeviceNetworkState {
  if (networkState.isConnected === true) return "connected";
  if (networkState.isConnected === false) return "disconnected";
  return "unknown";
}

export function resolveBackendReachability(
  status: number | null,
  body?: unknown,
): BackendReachability {
  if (status === null) return "unavailable";
  if (status < 200 || status >= 300) return "degraded";
  if (
    body &&
    typeof body === "object" &&
    "status" in body &&
    body.status === "ok" &&
    "database" in body &&
    body.database === "connected"
  ) {
    return "available";
  }
  return "degraded";
}

type DiagnosticsListener = (diagnostics: ConnectivityDiagnostics) => void;

export class ConnectivityService {
  private static currentState: ConnectivityState = "degraded";
  private static listeners = new Set<Listener>();
  private static diagnosticsListeners = new Set<DiagnosticsListener>();
  private static probeGeneration = 0;
  private static diagnostics: ConnectivityDiagnostics = {
    deviceNetwork: "unknown",
    backend: "unknown",
    backendCheckedAt: null,
    lastApiSuccessAt: null,
  };

  static getState(): ConnectivityState {
    return this.currentState;
  }

  static getDiagnostics(): ConnectivityDiagnostics {
    return { ...this.diagnostics };
  }

  static setState(state: ConnectivityState): void {
    if (this.currentState !== state) {
      this.currentState = state;
      this.notifyListeners();
    }
  }

  static subscribeDiagnostics(listener: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(listener);
    listener(this.getDiagnostics());
    return () => {
      this.diagnosticsListeners.delete(listener);
    };
  }

  static recordApiSuccess(): void {
    const timestamp = new Date().toISOString();
    this.updateDiagnostics({
      deviceNetwork: "connected",
      backend: "available",
      backendCheckedAt: timestamp,
      lastApiSuccessAt: timestamp,
    });
    if (this.currentState === "degraded") this.setState("online");
  }

  static subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Connects the app to the native network state listener. A device is marked
   * offline only when the native API explicitly confirms no active network.
   */
  static startMonitoring(onOnline?: () => void): () => void {
    let disposed = false;
    let subscription: { remove: () => void } | null = null;
    let networkUpdate = 0;
    const applyNetworkState = (networkState: {
      isConnected?: boolean | null;
      isInternetReachable?: boolean | null;
    }) => {
      networkUpdate += 1;
      void this.applyNetworkState(networkState, onOnline, () => disposed);
    };

    // Dynamic import keeps Node/Jest repository tests independent from Expo's
    // native module while still loading it in the real app.
    import("expo-network")
      .then((Network) => {
        if (disposed) return;
        subscription = Network.addNetworkStateListener(applyNetworkState);
        const initialUpdate = networkUpdate;
        Network.getNetworkStateAsync()
          .then((state) => {
            if (!disposed && networkUpdate === initialUpdate) applyNetworkState(state);
          })
          .catch(() => {
            if (disposed || networkUpdate !== initialUpdate) return;
            applyNetworkState({ isConnected: null });
          });
      })
      .catch(() => {
        if (disposed) return;
        applyNetworkState({ isConnected: null });
      });

    return () => {
      disposed = true;
      this.probeGeneration += 1;
      subscription?.remove();
      subscription = null;
    };
  }

  private static async applyNetworkState(
    networkState: {
      isConnected?: boolean | null;
      isInternetReachable?: boolean | null;
    },
    onOnline: (() => void) | undefined,
    isDisposed: () => boolean,
  ): Promise<void> {
    const deviceNetwork = resolveDeviceNetworkState(networkState);
    if (deviceNetwork === "disconnected") {
      this.probeGeneration += 1;
      this.updateDiagnostics({
        deviceNetwork,
        backend: "unknown",
        backendCheckedAt: null,
      });
      this.setState("offline");
      return;
    }

    this.updateDiagnostics({ deviceNetwork });
    this.setState("degraded");
    const generation = ++this.probeGeneration;
    const previousBackend = this.diagnostics.backend;
    let status: number | null = null;
    let body: unknown;
    try {
      const response = await axios.get(
        `${env.apiUrl.replace(/\/+$/, "")}/health`,
        { timeout: 8_000, validateStatus: () => true },
      );
      status = response.status;
      body = response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        status = error.response.status;
        body = error.response.data;
      }
    }

    if (isDisposed() || generation !== this.probeGeneration) return;
    const backend = resolveBackendReachability(status, body);
    this.updateDiagnostics({
      backend,
      backendCheckedAt: new Date().toISOString(),
    });
    this.setState(backend === "available" ? "online" : "degraded");
    if (backend === "available" && previousBackend !== "available") {
      onOnline?.();
    }
  }

  private static updateDiagnostics(
    update: Partial<ConnectivityDiagnostics>,
  ): void {
    this.diagnostics = { ...this.diagnostics, ...update };
    const diagnostics = this.getDiagnostics();
    for (const listener of this.diagnosticsListeners) {
      try {
        listener(diagnostics);
      } catch (error) {
        console.error("Connectivity diagnostics listener error:", error);
      }
    }
  }

  private static notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.currentState);
      } catch (err) {
        console.error("Connectivity listener error:", err);
      }
    }
  }
}

import { ConnectivityState } from "../../shared/types";

type Listener = (state: ConnectivityState) => void;

export class ConnectivityService {
  private static currentState: ConnectivityState = "offline";
  private static listeners = new Set<Listener>();

  static getState(): ConnectivityState {
    return this.currentState;
  }

  static setState(state: ConnectivityState): void {
    if (this.currentState !== state) {
      this.currentState = state;
      this.notifyListeners();
    }
  }

  static subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Connects the app to the native network state listener. The callback runs
   * only when the device transitions from offline to reachable, which makes
   * it safe to trigger a sync without starting duplicate requests for every
   * network event.
   */
  static startMonitoring(onOnline?: () => void): () => void {
    let disposed = false;
    let subscription: { remove: () => void } | null = null;
    const applyNetworkState = (networkState: {
      isConnected?: boolean;
      isInternetReachable?: boolean | null;
    }) => {
      const reachable =
        networkState.isConnected === true &&
        networkState.isInternetReachable !== false;
      const nextState: ConnectivityState = reachable ? "online" : "offline";
      const previousState = this.currentState;
      this.setState(nextState);
      if (nextState === "online" && previousState !== "online") {
        onOnline?.();
      }
    };

    // Resolve the initial state so a user who opens the app while already on
    // Wi‑Fi gets an automatic sync as well.
    // Dynamic import keeps the Node/Jest repository tests independent from
    // Expo's native ESM module while still loading it in the real app.
    import("expo-network")
      .then((Network) => {
        if (disposed) return;
        Network.getNetworkStateAsync()
          .then(applyNetworkState)
          .catch(() => this.setState("offline"));
        subscription = Network.addNetworkStateListener(applyNetworkState);
      })
      .catch(() => this.setState("offline"));

    return () => {
      disposed = true;
      subscription?.remove();
      subscription = null;
    };
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

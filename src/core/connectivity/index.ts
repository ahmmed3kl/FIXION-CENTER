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

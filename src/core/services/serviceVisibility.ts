export const SERVICE_KEYS = [
  "attendance",
  "payments",
  "packages",
  "makeup",
  "notifications",
  "reports",
  "whatsapp",
  "sms",
] as const;

export type ServiceKey = (typeof SERVICE_KEYS)[number];

export interface ServiceVisibilityState {
  loading: boolean;
  loaded: boolean;
  centerId: string | null;
  enabled: Partial<Record<ServiceKey, boolean>>;
  error: string | null;
}

export const initialServiceVisibilityState: ServiceVisibilityState = {
  loading: false,
  loaded: false,
  centerId: null,
  enabled: {},
  error: null,
};

export function isServiceEnabled(
  state: ServiceVisibilityState,
  serviceKey: ServiceKey,
): boolean {
  // A disabled or unknown/loading state must never optimistically expose an
  // exclusive action. The backend remains the authoritative enforcement layer.
  return state.loaded === true && state.enabled[serviceKey] === true;
}

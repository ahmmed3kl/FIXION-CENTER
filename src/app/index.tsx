import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { getSafeDefaultRoute, LastAuthorizedRouteStore, RestorableRouteHref } from "../features/auth/lastAuthorizedRoute";
import { useAuthStore } from "../features/auth/useAuthStore";
import { LoadingState } from "../shared/components";

export default function AppIndex() {
  const { isAuthenticated, isLoading, currentUser, activeCenterId } = useAuthStore();
  const [destination, setDestination] = useState<RestorableRouteHref | "/(auth)/login" | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setDestination("/(auth)/login");
      return;
    }

    let cancelled = false;
    const fallback = getSafeDefaultRoute(currentUser);
    if (!currentUser || !activeCenterId) {
      setDestination(fallback);
      return;
    }

    LastAuthorizedRouteStore.restore(currentUser, activeCenterId)
      .then((route) => {
        if (!cancelled) setDestination(route || fallback);
      })
      .catch((error) => {
        console.error("Could not restore the last authorized route:", error);
        if (!cancelled) setDestination(fallback);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCenterId, currentUser, isAuthenticated, isLoading]);

  if (!destination) return <LoadingState message="جارٍ استعادة الشاشة..." />;
  return <Redirect href={destination} />;
}

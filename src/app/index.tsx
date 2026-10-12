import { Redirect } from "expo-router";
import { useAuthStore } from "../features/auth/useAuthStore";

export default function AppIndex() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  return <Redirect href={isAuthenticated ? "/(main)/index" : "/(auth)/login"} />;
}

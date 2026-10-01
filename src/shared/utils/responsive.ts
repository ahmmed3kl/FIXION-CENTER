import { useWindowDimensions } from "react-native";

/** Shared layout values for phones, tablets and landscape screens. */
export function useResponsiveLayout() {
  const { width, height } = useWindowDimensions();
  const isTablet = width >= 600;
  const isLandscape = width > height;
  const gutter = Math.min(isTablet ? 32 : 16, Math.max(12, width * 0.05));
  return { width, height, isTablet, isLandscape, gutter, contentMaxWidth: isTablet ? 840 : 680 };
}

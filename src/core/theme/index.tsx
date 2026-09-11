import React, { createContext, useContext, useMemo } from 'react';
import { StyleSheet } from 'react-native';

export const Colors = {
  primary: '#2563EB',      // Modern Blue
  primaryDark: '#1D4ED8',
  primaryLight: '#DBEAFE',
  primaryMuted: '#EFF6FF',
  
  secondary: '#0F766E',    // Deep Teal
  secondaryLight: '#CCFBF1',
  
  accent: '#F59E0B',       // Amber
  accentLight: '#FEF3C7',

  success: '#10B981',      // Emerald Green
  successLight: '#D1FAE5',
  successText: '#065F46',

  danger: '#EF4444',       // Crimson Red
  dangerLight: '#FEE2E2',
  dangerText: '#991B1B',

  warning: '#F59E0B',
  warningLight: '#FEF3C7',
  warningText: '#92400E',

  slate900: '#0F172A',
  slate800: '#1E293B',
  slate700: '#334155',
  slate600: '#475569',
  slate500: '#64748B',
  slate400: '#94A3B8',
  slate300: '#CBD5E1',
  slate200: '#E2E8F0',
  slate100: '#F1F5F9',
  slate50: '#F8FAFC',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  background: '#F8FAFC',
  cardBackground: '#FFFFFF',
  border: '#E2E8F0',
  textPrimary: '#0F172A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
};

export const BorderRadius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  full: 9999,
};

export const Typography = {
  h1: {
    fontSize: 24,
    fontWeight: '700' as const,
    lineHeight: 32,
    textAlign: 'right' as const,
  },
  h2: {
    fontSize: 20,
    fontWeight: '700' as const,
    lineHeight: 28,
    textAlign: 'right' as const,
  },
  h3: {
    fontSize: 18,
    fontWeight: '600' as const,
    lineHeight: 24,
    textAlign: 'right' as const,
  },
  body: {
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 22,
    textAlign: 'right' as const,
  },
  bodyBold: {
    fontSize: 15,
    fontWeight: '600' as const,
    lineHeight: 22,
    textAlign: 'right' as const,
  },
  caption: {
    fontSize: 13,
    fontWeight: '400' as const,
    lineHeight: 18,
    textAlign: 'right' as const,
  },
  captionBold: {
    fontSize: 13,
    fontWeight: '600' as const,
    lineHeight: 18,
    textAlign: 'right' as const,
  },
  badge: {
    fontSize: 12,
    fontWeight: '600' as const,
    textAlign: 'center' as const,
  },
};

export const Shadows = StyleSheet.create({
  subtle: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  card: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  elevated: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 5,
  },
});

export const Theme = {
  colors: Colors,
  spacing: Spacing,
  radius: BorderRadius,
  typography: Typography,
  shadows: Shadows,
};

const ThemeContext = createContext<typeof Theme>(Theme);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useMemo(() => Theme, []);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

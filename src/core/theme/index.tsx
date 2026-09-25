import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { SecureStorageService } from '../storage';

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

export type AppColors = typeof Colors;

const LightColors: AppColors = { ...Colors };

const DarkColors: AppColors = {
  ...Colors,
  primary: '#60A5FA',
  primaryDark: '#93C5FD',
  primaryLight: '#1E3A8A',
  primaryMuted: '#172554',
  secondary: '#2DD4BF',
  secondaryLight: '#134E4A',
  accent: '#FBBF24',
  accentLight: '#78350F',
  success: '#34D399',
  successLight: '#064E3B',
  successText: '#A7F3D0',
  danger: '#F87171',
  dangerLight: '#7F1D1D',
  dangerText: '#FECACA',
  warning: '#FBBF24',
  warningLight: '#78350F',
  warningText: '#FDE68A',
  slate900: '#F8FAFC',
  slate800: '#E2E8F0',
  slate700: '#CBD5E1',
  slate600: '#94A3B8',
  slate500: '#94A3B8',
  slate400: '#64748B',
  slate300: '#475569',
  slate200: '#334155',
  slate100: '#1E293B',
  slate50: '#111827',
  background: '#0B1220',
  cardBackground: '#111827',
  border: '#334155',
  textPrimary: '#F8FAFC',
  textSecondary: '#CBD5E1',
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
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
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
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  card: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  elevated: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
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

type ThemeContextValue = typeof Theme & {
  isDarkMode: boolean;
  setDarkMode: (enabled: boolean) => void;
  toggleDarkMode: () => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  ...Theme,
  isDarkMode: false,
  setDarkMode: () => undefined,
  toggleDarkMode: () => undefined,
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    SecureStorageService.getItem('theme_mode')
      .then((mode) => setIsDarkMode(mode === 'dark'))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    Object.assign(Colors, isDarkMode ? DarkColors : LightColors);
  }, [isDarkMode]);

  const setDarkMode = (enabled: boolean) => {
    setIsDarkMode(enabled);
    SecureStorageService.setItem('theme_mode', enabled ? 'dark' : 'light').catch(() => undefined);
  };

  const colors = isDarkMode ? DarkColors : LightColors;
  const value = useMemo(() => ({
    ...Theme,
    colors,
    isDarkMode,
    setDarkMode,
    toggleDarkMode: () => setDarkMode(!isDarkMode),
  }), [isDarkMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);

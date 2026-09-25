import React from "react";
import {
    ActivityIndicator,
    StyleProp,
    StyleSheet,
    Text,
    TextInput,
    TextInputProps,
    TextStyle,
    TouchableOpacity,
    View,
    ViewStyle,
} from "react-native";
import { Strings } from "../../core/localization";
import {
    BorderRadius,
    Colors,
    Shadows,
    Spacing,
    Typography,
    useTheme,
} from "../../core/theme";
import { ConnectivityState } from "../types";
import { InputKind, sanitizeInput } from "../utils/validation";

// ==========================================
// 1. AppButton
// ==========================================
interface AppButtonProps {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "outline" | "danger" | "success";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  icon?: React.ReactNode;
}

export const AppButton: React.FC<AppButtonProps> = ({
  title,
  onPress,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  style,
  textStyle,
  icon,
}) => {
  const { colors } = useTheme();
  const getBackgroundColor = () => {
    if (disabled) return colors.slate200;
    switch (variant) {
      case "primary":
        return colors.primary;
      case "secondary":
        return colors.secondary;
      case "danger":
        return colors.danger;
      case "success":
        return colors.success;
      case "outline":
        return colors.transparent;
      default:
        return colors.primary;
    }
  };

  const getTextColor = () => {
    if (disabled) return colors.slate400;
    if (variant === "outline") return colors.primary;
    return colors.white;
  };

  const getHeight = () => {
    switch (size) {
      case "sm":
        return 38;
      case "lg":
        return 54;
      default:
        return 48; // comfortable touch target
    }
  };

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onPress}
      disabled={disabled || loading}
      style={[
        styles.buttonBase,
        {
          backgroundColor: getBackgroundColor(),
          height: getHeight(),
          borderColor:
            variant === "outline" ? colors.primary : colors.transparent,
          borderWidth: variant === "outline" ? 1.5 : 0,
        },
        variant !== "outline" && !disabled ? Shadows.subtle : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={getTextColor()} size="small" />
      ) : (
        <View style={styles.buttonContent}>
          {icon ? <View style={styles.buttonIcon}>{icon}</View> : null}
          <Text
            style={[styles.buttonText, { color: getTextColor() }, textStyle]}
          >
            {title}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
};

// ==========================================
// 2. AppInput
// ==========================================
interface AppInputProps extends TextInputProps {
  label?: string;
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
  inputKind?: InputKind;
}

export const AppInput: React.FC<AppInputProps> = ({
  label,
  error,
  containerStyle,
  style,
  inputKind,
  onChangeText,
  maxLength,
  ...props
}) => {
  const { colors, isDarkMode } = useTheme();
  const resolvedInputKind =
    inputKind ?? (props.keyboardType === "phone-pad" ? "phone" : undefined);
  const resolvedMaxLength =
    resolvedInputKind === "phone"
      ? Math.min(maxLength ?? 11, 11)
      : maxLength;
  return (
    <View style={[styles.inputContainer, containerStyle]}>
      {label ? <Text style={[styles.inputLabel, { color: isDarkMode ? "#0F172A" : colors.textSecondary }]}>{label}</Text> : null}
      <TextInput
        style={[styles.textInput, { backgroundColor: colors.cardBackground, borderColor: colors.border, color: isDarkMode ? "#0F172A" : colors.textPrimary }, error ? { borderColor: colors.danger } : null, style]}
        placeholderTextColor={colors.textMuted}
        textAlign="right"
        maxLength={resolvedMaxLength}
        onChangeText={(value) =>
          onChangeText?.(sanitizeInput(value, resolvedInputKind))
        }
        {...props}
      />
      {error ? <Text style={[styles.errorText, { color: colors.dangerText }]}>{error}</Text> : null}
    </View>
  );
};

// ==========================================
// 3. AppCard
// ==========================================
interface AppCardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}

export const AppCard: React.FC<AppCardProps> = ({
  children,
  style,
  onPress,
}) => {
  const { colors } = useTheme();
  if (onPress) {
    return (
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={onPress}
        style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.border }, Shadows.card, style]}
      >
        {children}
      </TouchableOpacity>
    );
  }
  return <View style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.border }, Shadows.card, style]}>{children}</View>;
};

// ==========================================
// 4. StatusBadge
// ==========================================
interface StatusBadgeProps {
  text: string;
  type?: "success" | "warning" | "danger" | "info" | "neutral";
  style?: StyleProp<ViewStyle>;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  text,
  type = "info",
  style,
}) => {
  const { colors } = useTheme();
  const getColors = () => {
    switch (type) {
      case "success":
        return { bg: colors.successLight, text: colors.successText };
      case "warning":
        return { bg: colors.warningLight, text: colors.warningText };
      case "danger":
        return { bg: colors.dangerLight, text: colors.dangerText };
      case "neutral":
        return { bg: colors.slate100, text: colors.slate600 };
      default:
        return { bg: colors.primaryLight, text: colors.primaryDark };
    }
  };

  const c = getColors();

  return (
    <View style={[styles.badge, { backgroundColor: c.bg }, style]}>
      <Text style={[Typography.badge, { color: c.text }]}>{text}</Text>
    </View>
  );
};

// ==========================================
// 5. SyncIndicator
// ==========================================
interface SyncIndicatorProps {
  connectivity: ConnectivityState;
  pendingCount: number;
  onPress?: () => void;
}

export const SyncIndicator: React.FC<SyncIndicatorProps> = ({
  connectivity,
  pendingCount,
  onPress,
}) => {
  const { colors } = useTheme();
  let label = Strings.statusOnline;
  let bg = colors.successLight;
  let fg = colors.successText;

  if (connectivity === "offline") {
    label =
      pendingCount > 0 ? `${pendingCount} في الانتظار` : Strings.statusOffline;
    bg = colors.warningLight;
    fg = colors.warningText;
  } else if (connectivity === "syncing") {
    label = Strings.statusSyncing;
    bg = colors.primaryLight;
    fg = colors.primaryDark;
  } else if (connectivity === "degraded") {
    label = "الخادم غير متاح";
    bg = colors.dangerLight;
    fg = colors.dangerText;
  }

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      disabled={!onPress}
      style={[styles.syncBadge, { backgroundColor: bg }]}
    >
      <View style={[styles.syncDot, { backgroundColor: fg }]} />
      <Text style={[styles.syncText, { color: fg }]}>{label}</Text>
    </TouchableOpacity>
  );
};

// ==========================================
// 6. LoadingState / EmptyState / ErrorState
// ==========================================
export const LoadingState: React.FC<{ message?: string }> = ({
  message = Strings.loading,
}) => {
  const { colors } = useTheme();
  return <View style={styles.centerContainer}>
    <ActivityIndicator size="large" color={colors.primary} />
    <Text style={[styles.stateMessage, { color: colors.textSecondary }]}>{message}</Text>
  </View>;
};

export const EmptyState: React.FC<{
  message?: string;
  actionTitle?: string;
  onAction?: () => void;
}> = ({ message = Strings.emptyData, actionTitle, onAction }) => {
  const { colors } = useTheme();
  return <View style={styles.centerContainer}>
    <Text style={[styles.stateMessage, { color: colors.textSecondary }]}>{message}</Text>
    {actionTitle && onAction ? <AppButton title={actionTitle} onPress={onAction} size="sm" style={{ marginTop: Spacing.md }} /> : null}
  </View>;
};

export const ErrorState: React.FC<{
  message?: string;
  onRetry?: () => void;
}> = ({ message = Strings.errorTitle, onRetry }) => {
  const { colors } = useTheme();
  return <View style={styles.centerContainer}>
    <Text style={[styles.stateMessage, { color: colors.dangerText }]}>{message}</Text>
    {onRetry ? <AppButton title={Strings.retryButton} onPress={onRetry} variant="outline" size="sm" style={{ marginTop: Spacing.md }} /> : null}
  </View>;
};

const styles = StyleSheet.create({
  buttonBase: {
    borderRadius: BorderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.lg,
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonIcon: {
    marginLeft: Spacing.sm,
  },
  buttonText: {
    ...Typography.bodyBold,
  },
  inputContainer: {
    marginBottom: Spacing.md,
  },
  inputLabel: {
    ...Typography.captionBold,
    color: Colors.slate700,
    marginBottom: Spacing.xs,
  },
  textInput: {
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    height: 48,
    paddingHorizontal: Spacing.md,
    fontSize: 15,
    color: Colors.textPrimary,
  },
  inputError: {
    borderColor: Colors.danger,
  },
  errorText: {
    ...Typography.caption,
    color: Colors.dangerText,
    marginTop: Spacing.xs,
  },
  card: {
    backgroundColor: Colors.cardBackground,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.md,
  },
  badge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: BorderRadius.full,
    alignSelf: "flex-start",
  },
  syncBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
    borderRadius: BorderRadius.full,
  },
  syncDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginLeft: 6,
  },
  syncText: {
    fontSize: 12,
    fontWeight: "600",
  },
  centerContainer: {
    padding: Spacing.xxl,
    alignItems: "center",
    justifyContent: "center",
  },
  stateMessage: {
    ...Typography.body,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
    textAlign: "center",
  },
});

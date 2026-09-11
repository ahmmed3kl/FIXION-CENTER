module.exports = {
  Platform: {
    OS: "android",
    Version: "34",
    select: (obj) => (obj ? obj.android || obj.default : undefined),
  },
  I18nManager: {
    isRTL: true,
    allowRTL: () => {},
    forceRTL: () => {},
  },
  StyleSheet: {
    create: (styles) => styles,
  },
};

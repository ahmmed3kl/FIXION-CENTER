---
name: fixion-mobile-ui
description: "Design, implement, or review UI in FIXION's React Native and Expo mobile app. Use for Arabic/RTL screen work, reference-image implementations, layout and visual-system changes, and mobile UI audits. Follow the existing FIXION theme and preserve app behavior."
user-invocable: true
---

# FIXION Mobile UI

Apply this skill whenever changing or reviewing the visual interface of FIXION's React Native + Expo application.

## Before implementation

- Inspect the actual target screen, its shared components, navigation layout, and current theme before editing. Reuse the existing FIXION design system in [src/core/theme/index.tsx](../../../src/core/theme/index.tsx) and shared components in [src/shared/components/index.tsx](../../../src/shared/components/index.tsx). Extend the existing system only when needed; do not create a competing theme.
- Check the installed Expo, Expo Router, React Native, and relevant package versions in `package.json`.
- Read the exact matching versioned Expo documentation before using an Expo API. FIXION currently targets Expo SDK 57; use the SDK 57 documentation, not unverified examples for newer releases. Verify APIs against the installed package types when documentation and code disagree.
- Treat general Expo skill examples as guidance, not a mandate to replace FIXION's existing architecture. Check each API and platform-specific example against SDK 57 and the installed packages before using it.
- Identify the existing behavior, data sources, navigation paths, permissions, sync behavior, and business rules the screen relies on. For UI-only requests, do not change them.
- When a reference image is supplied, compare it with the current screen first. Record the concrete visual differences relevant to the request, then make focused changes to the actual screen rather than creating a demo screen or applying superficial decoration.

## Design and implementation rules

1. Build for mobile with React Native and Expo. Do not use Web CSS, DOM elements, or web-only layout patterns in native screens.
2. Support Arabic and RTL correctly, including text alignment, reading order, icon placement, and mixed Arabic/Latin text.
3. Prefer a minimal, professional visual style. Avoid unnecessary shadows, gradients, decoration, and visual noise.
4. Keep colors, typography, spacing, icon sizes, and corner radii consistent by using FIXION's existing theme and component conventions.
5. Do not introduce an oversized floating navigation button or repeat cards and decoration without a clear information-hierarchy purpose.
6. Respect iOS and Android safe areas, scroll behavior, keyboard behavior, and fixed navigation. Ensure fixed UI does not cover screen content.
7. Use reference images to guide visual composition and styling, never to replace live application data with sample values.
8. Preserve existing app functionality, real data, navigation, permissions, synchronization, and business rules when the request is limited to UI. Do not change backend, API, database, SQLite, attendance, or sync logic as part of a visual-only change.
9. Modify the real screen in the existing application. Do not create a separate prototype or sample screen in place of the requested screen.
10. Keep changes limited to the requested UI surface and necessary shared UI code. Do not add dependencies or alter Expo versions unless the user explicitly authorizes it and the implementation requires it.
11. For reference-driven work, describe the specific visual gaps, implement the requested differences, and inspect the result again. Do not claim a visual/device check that was not actually performed.
12. Check responsive behavior at relevant small and large mobile viewport sizes. Run focused type checks or tests that cover the changed UI and existing interactions; distinguish automated checks from real-device or emulator validation.

## Before reporting completion

- Confirm that real data and existing interaction handlers remain in place.
- Confirm that layout accounts for RTL, safe areas, scrolling, and fixed navigation.
- Report the files changed, validation actually performed, and any visual checks that could not be performed.
- Do not commit, push, or deploy unless explicitly requested.

/**
 * Athena — the SickKids skin, and the default on this branch.
 *
 * Every colour derives from branding.json: the four seeds per appearance
 * (background, foreground, accent, accentForeground) plus neutrals mixed
 * from foreground into background, so changing the brand is one file.
 * Typography is the system stack and sets an empty `fontUrl` on purpose:
 * applyTheme layers each theme's typography over the Nous skin's, whose
 * Google Fonts stylesheet would otherwise be fetched on every launch.
 */

import type { DesktopTheme, DesktopThemeColors } from '@/themes/types'

import branding from './branding.json'

type Seeds = (typeof branding.colors)['light']

const EMOJI_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)

  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** `amount` of `top` over `base`, in sRGB. */
export function mix(top: string, base: string, amount: number): string {
  const a = channels(top)
  const b = channels(base)

  return `#${a
    .map((channel, i) => Math.round(channel * amount + b[i] * (1 - amount)))
    .map(channel => channel.toString(16).padStart(2, '0'))
    .join('')}`
}

function palette(seeds: Seeds, destructive: string): DesktopThemeColors {
  const { accent, accentForeground, background, foreground } = seeds
  const surface = mix(foreground, background, 0.04)
  const border = mix(foreground, background, 0.16)

  return {
    background,
    foreground,
    card: surface,
    cardForeground: foreground,
    muted: surface,
    mutedForeground: mix(foreground, background, 0.7),
    popover: background,
    popoverForeground: foreground,
    primary: accent,
    primaryForeground: accentForeground,
    secondary: mix(accent, background, 0.16),
    secondaryForeground: foreground,
    accent: mix(accent, background, 0.1),
    accentForeground: foreground,
    border,
    input: background,
    ring: accent,
    midground: accent,
    midgroundForeground: accentForeground,
    composerRing: accent,
    destructive,
    destructiveForeground: '#ffffff',
    sidebarBackground: surface,
    sidebarBorder: border,
    userBubble: mix(accent, background, 0.12),
    userBubbleBorder: border
  }
}

export const athenaTheme: DesktopTheme = {
  name: 'athena',
  label: branding.display,
  description: `${branding.organization} colours, system fonts`,
  colors: palette(branding.colors.light, '#c62828'),
  darkColors: palette(branding.colors.dark, '#d32f2f'),
  typography: {
    fontSans: `${branding.fontStack}, ${EMOJI_FALLBACK}`,
    fontUrl: ''
  }
}

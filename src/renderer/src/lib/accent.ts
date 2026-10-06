// Accent colour: a preset id or a custom '#rrggbb', turned into the CSS variables for the current theme.
// null means the built-in Verdigit green, which lives in styles.css.

export interface AccentPreset {
  id: string
  label: string
  dark: string
  light: string
}

/** Hand-tuned pairs: bright enough on the dark theme, dark enough for white text on the light theme. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'green', label: 'Verdigris green', dark: '#3ddc84', light: '#16a34a' },
  { id: 'teal', label: 'Teal', dark: '#2dd4bf', light: '#0d9488' },
  { id: 'blue', label: 'Blue', dark: '#60a5fa', light: '#2563eb' },
  { id: 'indigo', label: 'Indigo', dark: '#818cf8', light: '#4f46e5' },
  { id: 'purple', label: 'Purple', dark: '#c084fc', light: '#9333ea' },
  { id: 'pink', label: 'Pink', dark: '#f472b6', light: '#db2777' },
  { id: 'orange', label: 'Orange', dark: '#fb923c', light: '#c2410c' },
  { id: 'amber', label: 'Amber', dark: '#fbbf24', light: '#b45309' }
]

export type AccentVars = Record<'--accent' | '--accent-strong' | '--accent-hover' | '--accent-ink' | '--tint-shift' | '--tint-sat', string>

type Rgb = [number, number, number]

const isHex = (s: string): boolean => /^#[0-9a-f]{6}$/i.test(s)

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const rgbToHex = (c: Rgb): string => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

/** Mix towards another colour; t = 0 keeps a, t = 1 gives b. */
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const lin = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number): number => {
    t = (t + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/**
 * Nudge a custom colour so it stays readable: on the dark theme it must stand out from the
 * near-black background, on the light theme it must carry white button text. Only the
 * lightness moves, so the hue and saturation the user picked are kept.
 */
export function readableAccent(hex: string, mode: 'dark' | 'light'): string {
  const ok = (h: string): boolean => (mode === 'dark' ? luminance(h) >= 0.25 : luminance(h) <= 0.2)
  if (ok(hex)) return hex.toLowerCase()
  const [h, s, l] = rgbToHsl(hexToRgb(hex))
  // Closest lightness that passes, found by bisection between the original and white/black.
  let near = l
  let far = mode === 'dark' ? 1 : 0
  for (let i = 0; i < 20; i++) {
    const mid = (near + far) / 2
    if (ok(rgbToHex(hslToRgb(h, s, mid)))) far = mid
    else near = mid
  }
  return rgbToHex(hslToRgb(h, s, far))
}

/** CSS variables for an accent setting, or null to use the stylesheet's default green. */
export function accentVars(accent: string | null | undefined, mode: 'dark' | 'light'): AccentVars | null {
  if (!accent || accent === 'green') return null
  const preset = ACCENT_PRESETS.find((p) => p.id === accent)
  if (!preset && !isHex(accent)) return null
  const base = preset ? preset[mode] : readableAccent(accent, mode)
  const c = hexToRgb(base)
  // Rotate the backgrounds' green tint by however far this accent's hue is from the default green.
  const [hue, sat] = rgbToHsl(c)
  const [greenHue] = rgbToHsl(hexToRgb(ACCENT_PRESETS[0][mode]))
  const black: Rgb = [0, 0, 0]
  const white: Rgb = [255, 255, 255]
  return {
    '--accent': base,
    '--accent-strong': rgbToHex(mix(c, black, 0.15)),
    '--accent-hover': rgbToHex(mode === 'dark' ? mix(c, white, 0.18) : mix(c, black, 0.15)),
    // Like the default theme: near-black text on the bright dark-theme accent, white on the deep light-theme one.
    '--accent-ink': mode === 'dark' ? rgbToHex(mix(c, black, 0.92)) : '#ffffff',
    '--tint-shift': ((hue - greenHue) * 360).toFixed(1),
    // A grey-ish custom accent gives grey-ish backgrounds rather than an arbitrary hue.
    '--tint-sat': Math.min(1, sat / 0.4).toFixed(2)
  }
}

/** The colour to show on a swatch or the picker for the current setting. */
export function accentSwatch(accent: string | null | undefined, mode: 'dark' | 'light'): string {
  return accentVars(accent, mode)?.['--accent'] ?? ACCENT_PRESETS[0][mode]
}

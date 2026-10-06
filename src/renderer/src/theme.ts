import { useEffect } from 'react'
import type { Theme } from '@shared/types'
import { accentVars, type AccentVars } from './lib/accent'

const KEY = 'sc.theme'
const ACCENT_KEY = 'sc.accent'
const ACCENT_PROPS: (keyof AccentVars)[] = ['--accent', '--accent-strong', '--accent-hover', '--accent-ink', '--tint-shift', '--tint-sat']
const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

export function resolveTheme(theme: Theme): 'dark' | 'light' {
  return theme === 'system' ? (darkQuery().matches ? 'dark' : 'light') : theme
}

export function applyTheme(theme: Theme, accent: string | null): void {
  const root = document.documentElement
  const mode = resolveTheme(theme)
  root.dataset.theme = mode
  // Inline variables override the stylesheet's green; the soft tints and the neutrals' hue in styles.css derive from these.
  const vars = accentVars(accent, mode)
  for (const p of ACCENT_PROPS) {
    if (vars) root.style.setProperty(p, vars[p])
    else root.style.removeProperty(p)
  }
  try {
    localStorage.setItem(KEY, theme)
    if (accent) localStorage.setItem(ACCENT_KEY, accent)
    else localStorage.removeItem(ACCENT_KEY)
  } catch {
    // storage unavailable: the theme still applies for this session
  }
}

/** Apply the last-used theme and accent before first render so users don't see a flash of the defaults. */
export function applyCachedTheme(): void {
  let cached: string | null = null
  let accent: string | null = null
  try {
    cached = localStorage.getItem(KEY)
    accent = localStorage.getItem(ACCENT_KEY)
  } catch {
    // ignore
  }
  applyTheme(cached === 'light' || cached === 'system' ? cached : 'dark', accent)
}

/** Keep the document theme in sync with the settings, following the OS when set to "system". */
export function useTheme(theme: Theme | undefined, accent: string | null | undefined): void {
  useEffect(() => {
    if (!theme) return
    const a = accent ?? null
    applyTheme(theme, a)
    if (theme !== 'system') return
    const q = darkQuery()
    const onChange = (): void => applyTheme('system', a)
    q.addEventListener('change', onChange)
    return () => q.removeEventListener('change', onChange)
  }, [theme, accent])
}

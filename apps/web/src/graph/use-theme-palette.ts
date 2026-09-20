import { useEffect, useMemo, useState } from 'react'
import {
  type GraphPalette,
  graphPalette,
  prefersDarkScheme,
  type ResolvedTheme,
  resolveTheme,
  type ThemeSetting,
} from './theme.ts'

/**
 * The resolved colour scheme and its palette, following the OS while the
 * setting is `system`.
 *
 * Stamping `data-theme` on the document stays with the caller: the analyzer
 * owns the document theme, while a panel embedded in another screen only
 * reads it.
 */
export function useThemePalette(setting: ThemeSetting): { theme: ResolvedTheme; palette: GraphPalette } {
  const [systemDark, setSystemDark] = useState(prefersDarkScheme)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])
  const theme = resolveTheme(setting, systemDark)
  const palette = useMemo(() => graphPalette(theme), [theme])
  return { theme, palette }
}

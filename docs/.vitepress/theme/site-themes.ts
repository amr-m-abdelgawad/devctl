import { THEME_NAMES } from '../../../app/src/domain/ui/themes'
import { webThemeTokens } from '../../../app/web/theme'

export const SITE_THEME_KEY = 'devctl.site.theme'

/** Generate both appearances from the same contrast-adjusted tokens as the web console. */
export function siteThemeCss(): string {
  return THEME_NAMES.flatMap(name => ['light', 'dark'].map(appearance => {
    const t = webThemeTokens(name, appearance as 'light' | 'dark')
    const tokens: Record<string, string> = {
      ...t,
      '--vp-c-bg': t['--background'],
      '--vp-c-bg-alt': t['--card'],
      '--vp-c-bg-elv': t['--popover'],
      '--vp-c-bg-soft': t['--elevated'],
      '--vp-c-text-1': t['--foreground'],
      '--vp-c-text-2': t['--muted-foreground'],
      '--vp-c-text-3': t['--muted-foreground'],
      '--vp-c-border': t['--border'],
      '--vp-c-divider': t['--border'],
      '--vp-c-gutter': t['--border'],
      '--vp-c-brand-1': t['--primary'],
      '--vp-c-brand-2': t['--theme-accent'],
      '--vp-c-brand-3': t['--primary'],
      '--vp-c-brand-soft': 'color-mix(in srgb, var(--primary) 12%, transparent)',
      '--vp-button-brand-text': t['--primary-foreground'],
      '--vp-button-brand-hover-text': t['--primary-foreground'],
      '--vp-button-brand-hover-bg': t['--primary'],
      '--vp-button-brand-active-text': t['--primary-foreground'],
      '--vp-button-brand-active-bg': t['--primary'],
      '--vp-nav-bg-color': t['--background'],
      '--vp-sidebar-bg-color': t['--card'],
      '--vp-local-search-bg': t['--card'],
      '--vp-code-block-bg': t['--card'],
      '--vp-code-color': t['--primary'],
      '--landing-ink': t['--foreground'],
      '--landing-paper': t['--card'],
      '--landing-rule': t['--border'],
      'color-scheme': appearance,
    }
    for (const [semantic, token] of [['tip', 'success'], ['warning', 'warning'], ['danger', 'danger'], ['important', 'theme-accent']] as const) {
      for (const level of [1, 2, 3]) tokens[`--vp-c-${semantic}-${level}`] = t[`--${token}`]
      tokens[`--vp-c-${semantic}-soft`] = `color-mix(in srgb, var(--${token}) 12%, transparent)`
    }
    const mode = appearance === 'dark' ? '.dark' : ':not(.dark)'
    const selectors = [`:root[data-site-theme="${name}"]${mode}`]
    if (name === 'devctl') selectors.push(`:root:not([data-site-theme])${mode}`)
    return `${selectors.join(',')}{${Object.entries(tokens).map(([key, value]) => `${key}:${value}`).join(';')}}`
  })).join('\n')
}

// Runs before first paint. Invalid or unavailable storage falls back to devctl.
export const siteThemeInit = `(()=>{let theme='devctl';try{const saved=localStorage.getItem(${JSON.stringify(SITE_THEME_KEY)});if(${JSON.stringify(THEME_NAMES)}.includes(saved))theme=saved}catch{}document.documentElement.dataset.siteTheme=theme})()`

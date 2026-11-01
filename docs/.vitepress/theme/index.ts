import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { defineAsyncComponent, h } from 'vue'
import SiteThemePicker from './SiteThemePicker.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'nav-bar-title-before': () => h('svg', {
      class: 'site-logo', width: 24, height: 24, viewBox: '0 0 32 32',
      fill: 'none', 'aria-hidden': 'true', focusable: 'false',
    }, [
      h('rect', {
        x: 1.5, y: 1.5, width: 29, height: 29, rx: 7,
        fill: 'var(--logo-plate)', stroke: 'var(--logo-stroke)', 'stroke-width': 1.5,
      }),
      h('path', {
        d: 'M8 11l5 5-5 5', stroke: 'var(--logo-mark)', 'stroke-width': 2.4,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }),
      h('rect', { x: 15.5, y: 19.6, width: 8.5, height: 2.4, rx: 1.2, fill: 'var(--logo-mark)' }),
    ]),
    'nav-bar-content-after': () => h(SiteThemePicker),
    'nav-screen-content-after': () => h(SiteThemePicker),
  }),
  enhanceApp({ app }) {
    app.component('Mermaid', defineAsyncComponent(() => import('vitepress-plugin-mermaid/Mermaid.vue')))
  }
} satisfies Theme

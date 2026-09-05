import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { h } from 'vue'
import TerminalHero from './TerminalHero.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      // Render the animated terminal in the home hero's image slot.
      'home-hero-image': () => h(TerminalHero)
    })
  }
} satisfies Theme

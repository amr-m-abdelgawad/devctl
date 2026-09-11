import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { defineAsyncComponent } from 'vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Mermaid', defineAsyncComponent(() => import('vitepress-plugin-mermaid/Mermaid.vue')))
  }
} satisfies Theme

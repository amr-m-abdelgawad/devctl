<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import { useData } from 'vitepress'
import { THEME_NAMES, isLightPalette, themeBlurb, themePalette, type ThemeName } from '../../../app/src/domain/ui/themes'
import { themeDefaultAppearance, themeLabel, webThemeTokens } from '../../../app/web/theme'
import { Check, SquaresFour } from './phosphor'
import { SITE_THEME_KEY } from './site-themes'

const { isDark } = useData()
const selected = ref<ThemeName>('devctl')
const dialog = ref<HTMLDialogElement>()
const search = ref<HTMLInputElement>()
const open = ref(false)
const query = ref('')
const appearance = ref('all')
const titleId = useId()
const choices = THEME_NAMES.map(name => ({
  name,
  label: themeLabel(name),
  description: themeBlurb(name),
  appearance: themeDefaultAppearance(name),
  tokens: webThemeTokens(name, themeDefaultAppearance(name)),
}))
const featured = ['devctl', 'tokyonight', 'catppuccin', 'nord', 'gruvbox', 'catppuccin-latte'] as const
const filtered = computed(() => choices.filter(choice =>
  (appearance.value === 'all' || choice.appearance === appearance.value) &&
  `${choice.label} ${choice.name} ${choice.description}`.toLowerCase().includes(query.value.trim().toLowerCase()),
))

function sync() {
  const saved = document.documentElement.dataset.siteTheme
  if (THEME_NAMES.includes(saved as ThemeName)) selected.value = saved as ThemeName
}
onMounted(() => {
  sync()
  window.addEventListener('devctl:site-theme', sync)
})
onUnmounted(() => window.removeEventListener('devctl:site-theme', sync))

function change(name: ThemeName) {
  selected.value = name
  document.documentElement.dataset.siteTheme = name
  isDark.value = !isLightPalette(themePalette(name))
  try {
    localStorage.setItem(SITE_THEME_KEY, name)
  } catch { /* The picker works when storage is unavailable. */ }
  window.dispatchEvent(new Event('devctl:site-theme'))
}

async function show() {
  query.value = ''
  appearance.value = 'all'
  dialog.value?.showModal()
  open.value = true
  await nextTick()
  search.value?.focus()
}

function previewStyle(choice: typeof choices[number]) {
  const t = choice.tokens
  return {
    '--preview-bg': t['--background'], '--preview-panel': t['--card'],
    '--preview-text': t['--foreground'], '--preview-muted': t['--muted-foreground'],
    '--preview-primary': t['--primary'], '--preview-border': t['--border'],
  }
}

defineProps<{ showcase?: boolean }>()
</script>

<template>
  <div class="site-theme-picker" :class="{ 'site-theme-showcase': showcase }">
    <div v-if="showcase" class="site-theme-copy">
      <span class="site-theme-kicker">MAKE YOURSELF AT HOME</span>
      <strong>Your stack. Your palette.</strong>
      <p>The same {{ choices.length }} themes as the TUI and web console. Try one here.</p>
    </div>
    <button type="button" class="theme-trigger" aria-haspopup="dialog" :aria-expanded="open" aria-label="Explore website themes" @click="show">
      <SquaresFour :size="16" aria-hidden="true" />
      <span>{{ showcase ? `Explore all ${choices.length} themes` : themeLabel(selected) }}</span>
      <span aria-hidden="true" class="trigger-swatches"><i v-for="token in ['--primary', '--theme-accent', '--success']" :key="token" :style="{ background: `var(${token})` }" /></span>
    </button>
    <div v-if="showcase" class="featured-themes" role="group" aria-label="Featured website themes">
      <button v-for="name in featured" :key="name" type="button" :aria-pressed="selected === name" @click="change(name)">
        <span class="featured-swatch" :style="{ background: themePalette(name).background, borderColor: themePalette(name).border }" aria-hidden="true"><i :style="{ background: themePalette(name).primary }" /><i :style="{ background: themePalette(name).accent }" /></span>
        <span>{{ themeLabel(name) }}</span><Check v-if="selected === name" :size="13" aria-hidden="true" />
      </button>
    </div>
    <p v-if="showcase" class="theme-saved" aria-live="polite">{{ themeLabel(selected) }} selected <span>· Applies to the whole site · Saved in this browser</span></p>

    <ClientOnly>
      <Teleport to="body">
        <dialog ref="dialog" class="theme-dialog" :aria-labelledby="titleId" @close="open = false" @keydown.esc.prevent="dialog?.close()" @click="event => { if (event.target === dialog) dialog?.close() }">
          <div class="theme-dialog-header">
            <div><span class="site-theme-kicker">DEVCTL / APPEARANCE</span><h2 :id="titleId">Choose your theme.</h2><p>One palette for the whole site. Find your favorite.</p></div>
            <button type="button" class="theme-close" aria-label="Close theme picker" @click="dialog?.close()">×</button>
          </div>
          <div class="theme-tools">
            <input ref="search" v-model="query" type="search" aria-label="Search themes" placeholder="Find a theme…" />
            <div class="theme-filters" role="group" aria-label="Filter themes by appearance"><button v-for="mode in ['all', 'dark', 'light']" :key="mode" type="button" :aria-pressed="appearance === mode" @click="appearance = mode">{{ mode }}</button></div>
          </div>
          <div class="theme-gallery" role="group" aria-label="Website color theme">
            <button v-for="choice in filtered" :key="choice.name" type="button" class="theme-card" :aria-pressed="selected === choice.name" :aria-label="choice.label" @click="change(choice.name)">
              <span class="theme-preview" :style="previewStyle(choice)" aria-hidden="true">
                <span class="preview-bar"><i /><i /><i /><span>devctl</span></span>
                <span class="preview-workspace"><span class="preview-sidebar"><i /><i /><i /></span><span class="preview-content"><b>› your local stack</b><span class="preview-line" /><span class="preview-line short" /><span class="preview-colors"><i v-for="token in ['--primary', '--theme-accent', '--success', '--warning', '--info']" :key="token" :style="{ background: choice.tokens[token] }" /></span></span></span>
              </span>
              <span class="theme-card-label"><span>{{ choice.label }}</span><span v-if="selected === choice.name" class="theme-selected"><Check :size="13" aria-hidden="true" /></span><span v-else class="theme-mode">{{ choice.appearance }}</span></span>
              <span class="theme-card-description">{{ choice.description }}</span>
            </button>
            <p v-if="!filtered.length" class="theme-empty">No themes found. Try another name or appearance.</p>
          </div>
          <div class="theme-dialog-footer"><span role="status">{{ filtered.length }} themes <span aria-hidden="true">/</span> {{ themeLabel(selected) }} selected</span><button type="button" @click="dialog?.close()">Done <Check :size="14" aria-hidden="true" /></button></div>
        </dialog>
      </Teleport>
    </ClientOnly>
  </div>
</template>

<style scoped>
.site-theme-picker { display: flex; align-items: center; padding-left: 16px; }
.theme-trigger { display: inline-flex; align-items: center; gap: 9px; min-height: 36px; padding: 6px 10px; color: var(--vp-c-text-1); border: 1px solid var(--vp-c-divider); border-radius: 6px; font: 12px var(--vp-font-family-base); cursor: pointer; white-space: nowrap; }
.theme-trigger:hover { border-color: var(--primary); background: var(--vp-c-brand-soft); }
.trigger-swatches { display: flex; padding-left: 3px; }
.trigger-swatches i { width: 12px; height: 12px; border: 2px solid var(--background); border-radius: 50%; margin-left: -3px; }
.site-theme-showcase { padding: 28px 0 0; margin: 28px 0 0; border-top: 1px solid var(--vp-c-divider); flex-wrap: wrap; gap: 22px 32px; }
.site-theme-copy { flex: 1 1 260px; }
.site-theme-kicker { display: block; color: var(--primary); font: 9px var(--vp-font-family-mono); letter-spacing: .12em; }
.site-theme-copy strong { display: block; margin: 8px 0; color: var(--vp-c-text-1); font-size: 21px; font-weight: 500; letter-spacing: -.025em; }
.site-theme-copy p { margin: 0; color: var(--vp-c-text-2); font-size: 13px; line-height: 1.6; }
.site-theme-showcase .theme-trigger { min-height: 44px; padding: 10px 16px; }
.featured-themes { display: flex; flex-wrap: wrap; gap: 8px; width: 100%; }
.featured-themes button { display: inline-flex; gap: 9px; align-items: center; padding: 8px 12px 8px 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--foreground); font: 12px var(--vp-font-family-base); cursor: pointer; }
.featured-themes button:hover, .featured-themes button[aria-pressed="true"] { border-color: var(--primary); background: var(--vp-c-brand-soft); }
.featured-swatch { display: flex; align-items: center; justify-content: center; gap: 3px; width: 28px; height: 24px; border: 1px solid; border-radius: 4px; }
.featured-swatch i { width: 6px; height: 12px; border-radius: 1px; }
.theme-saved { width: 100%; margin: -6px 0 0; color: var(--primary); font: 10px/1.8 var(--vp-font-family-mono); }
.theme-saved span { color: var(--vp-c-text-2); }
.theme-dialog { position: fixed; inset: 0; width: min(760px, calc(100vw - 32px)); max-height: min(780px, calc(100dvh - 48px)); margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 14px; color: var(--foreground); background: var(--background); box-shadow: 0 32px 100px #0005; font-family: var(--vp-font-family-base); }
.theme-dialog[open] { display: flex; flex-direction: column; }
.theme-dialog::backdrop { background: #0008; backdrop-filter: blur(5px); }
.theme-dialog-header { display: flex; align-items: start; justify-content: space-between; gap: 20px; padding: 28px 28px 20px; }
.theme-dialog-header h2 { margin: 9px 0 6px; font-size: 29px; font-weight: 500; line-height: 1.2; letter-spacing: -.045em; }
.theme-dialog-header p { margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.6; }
.theme-close { display: grid; place-items: center; flex: 0 0 32px; height: 32px; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: 50%; font-size: 22px; line-height: 1; cursor: pointer; }
.theme-close:hover { color: var(--foreground); background: var(--elevated); }
.theme-tools { display: flex; flex-shrink: 0; gap: 12px; padding: 0 28px 20px; }
.theme-tools input { width: 0; min-width: 0; flex: 1; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--foreground); font: 13px var(--vp-font-family-base); }
.theme-tools input::placeholder { color: var(--muted-foreground); }
.theme-filters { display: flex; align-items: center; gap: 3px; padding: 3px; border: 1px solid var(--border); border-radius: 6px; }
.theme-filters button { padding: 6px 10px; border-radius: 3px; color: var(--muted-foreground); font-size: 11px; text-transform: capitalize; cursor: pointer; }
.theme-filters button[aria-pressed="true"] { background: var(--elevated); color: var(--foreground); }
.theme-gallery { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; overflow-y: auto; overscroll-behavior: contain; padding: 2px 28px 24px; scrollbar-width: thin; }
.theme-card { min-width: 0; padding: 6px; border: 1px solid var(--border); border-radius: 8px; text-align: left; background: var(--card); cursor: pointer; }
.theme-card:hover { border-color: var(--primary); }
.theme-card[aria-pressed="true"] { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.theme-preview { display: block; overflow: hidden; height: 100px; border: 1px solid var(--preview-border); border-radius: 4px; color: var(--preview-text); background: var(--preview-bg); font: 8px/1.6 var(--vp-font-family-mono); }
.preview-bar { display: flex; align-items: center; gap: 3px; height: 20px; padding: 0 7px; border-bottom: 1px solid var(--preview-border); background: var(--preview-panel); }
.preview-bar > i { width: 3px; height: 3px; border-radius: 50%; background: var(--preview-muted); }
.preview-bar > span { margin-left: auto; color: var(--preview-primary); }
.preview-workspace { display: flex; height: 80px; }
.preview-sidebar { display: flex; flex: 0 0 30px; flex-direction: column; gap: 5px; padding: 11px 6px; border-right: 1px solid var(--preview-border); background: var(--preview-panel); }
.preview-sidebar i { height: 3px; background: var(--preview-muted); opacity: .5; border-radius: 1px; }
.preview-sidebar i:first-child { background: var(--preview-primary); opacity: 1; }
.preview-content { display: flex; flex: 1; flex-direction: column; gap: 6px; min-width: 0; padding: 9px; }
.preview-content b { color: var(--preview-primary); font-weight: 500; white-space: nowrap; }
.preview-line { display: block; height: 3px; width: 85%; border-radius: 1px; background: var(--preview-muted); opacity: .4; }
.preview-line.short { width: 60%; }
.preview-colors { display: flex; gap: 4px; margin-top: 2px; }
.preview-colors i { width: 9px; height: 5px; border-radius: 1px; }
.theme-card-label { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 10px 4px 4px; color: var(--foreground); font-size: 12px; line-height: 1.5; }
.theme-mode { color: var(--muted-foreground); font: 9px var(--vp-font-family-mono); }
.theme-selected { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); }
.theme-card-description { display: block; padding: 0 4px 5px; color: var(--muted-foreground); font-size: 10px; line-height: 1.5; }
.theme-empty { grid-column: 1 / -1; padding: 32px 0; text-align: center; color: var(--muted-foreground); font-size: 13px; }
.theme-dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 28px; border-top: 1px solid var(--border); color: var(--muted-foreground); font: 10px/1.6 var(--vp-font-family-mono); }
.theme-dialog-footer > button { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-radius: 5px; background: var(--primary); color: var(--primary-foreground); font: 12px var(--vp-font-family-base); cursor: pointer; }
.theme-dialog :is(button,input):focus-visible, .site-theme-picker button:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
@media (max-width: 767px) {
  :global(.VPNavBar .site-theme-picker) { display: none; }
  .site-theme-picker:not(.site-theme-showcase) { padding: 16px 0; }
  .theme-saved span { display: block; }
}
@media (max-width: 540px) {
  .theme-dialog { width: calc(100vw - 20px); max-height: calc(100dvh - 24px); border-radius: 10px; }
  .theme-dialog-header { padding: 22px 18px 18px; }
  .theme-dialog-header h2 { font-size: 25px; }
  .theme-tools { flex-wrap: wrap; padding: 0 18px 18px; }
  .theme-tools input { flex-basis: 100%; }
  .theme-gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 2px 18px 20px; }
  .theme-dialog-footer { padding: 12px 18px; }
}
@media (min-width: 768px) and (max-width: 1279px) { .theme-trigger { gap: 6px; padding: 6px 8px; } .theme-trigger .trigger-swatches { display: none; } }
</style>

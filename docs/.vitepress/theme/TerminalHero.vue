<script setup lang="ts">
import { computed, ref } from 'vue'

const selected = ref(0)

const tabs = ['dashboard', 'services', 'logs', 'proxy']

const services = [
  { glyph: 'o', name: 'billing-console', state: 'STOPPED', on: false },
  { glyph: '✓', name: 'identity', state: 'HEALTHY', on: true },
  { glyph: '✓', name: 'invoices-api', state: 'HEALTHY', on: true },
  { glyph: 'o', name: 'invoices-worker', state: 'STOPPED', on: false, sel: true },
  { glyph: 'o', name: 'postgres', state: 'STOPPED', on: false },
  { glyph: '✓', name: 'telemetry', state: 'HEALTHY', on: true }
]

// service → stable colour, mirroring the real TUI palette
type Line = { t: string; s: string; lvl: string; src: string; m: string }

const dashboardLog: Line[] = [
  { t: '14:50:15', s: 'invoices-api', lvl: 'INFO', src: 'health', m: 'health HEALTHY 200' },
  { t: '14:50:16', s: 'telemetry', lvl: 'WARN', src: 'stdout', m: 'GET /invoices/{id} -> 401' },
  { t: '14:50:17', s: 'telemetry', lvl: 'WARN', src: 'stdout', m: 'POST /invoices -> 429' },
  { t: '14:50:17', s: 'telemetry', lvl: 'WARN', src: 'stdout', m: 'rate limit exceeded for client' },
  { t: '14:50:17', s: 'identity', lvl: 'INFO', src: 'stdout', m: 'INFO identity 127.0.0.1 "GET /health HTTP/1.1" 200 -' },
  { t: '14:50:17', s: 'identity', lvl: 'INFO', src: 'health', m: 'health HEALTHY 200' },
  { t: '14:50:18', s: 'identity', lvl: 'INFO', src: 'stdout', m: 'INFO identity heartbeat active_sessions=0' },
  { t: '14:50:18', s: 'telemetry', lvl: 'INFO', src: 'stdout', m: 'GET /invoices/{id} -> 200' },
  { t: '14:50:19', s: 'telemetry', lvl: 'INFO', src: 'stdout', m: 'POST /invoices -> 200' },
  { t: '14:50:19', s: 'telemetry', lvl: 'DEBUG', src: 'stdout', m: 'queue depth sample' },
  { t: '14:50:19', s: 'invoices-api', lvl: 'INFO', src: 'stdout', m: 'INFO invoices-api 127.0.0.1 "GET /health HTTP/1.1" 200' },
  { t: '14:50:20', s: 'invoices-api', lvl: 'INFO', src: 'stdout', m: 'INFO invoices-api heartbeat jobs=372 queued=372' },
  { t: '14:50:21', s: 'telemetry', lvl: 'INFO', src: 'stdout', m: 'GET /invoices -> 200' }
]

const fullLog: Line[] = [
  { t: '14:50:28', s: 'identity', lvl: 'INFO', src: 'stdout', m: 'INFO identity heartbeat active_sessions=0' },
  { t: '14:50:28', s: 'telemetry', lvl: 'INFO', src: 'stdout', m: 'POST /invoices -> 200' },
  { t: '14:50:29', s: 'telemetry', lvl: 'WARN', src: 'stdout', m: 'POST /billing/charge -> 401' },
  { t: '14:50:29', s: 'identity', lvl: 'INFO', src: 'stdout', m: 'INFO identity 127.0.0.1 "GET /health HTTP/1.1" 200 -' },
  { t: '14:50:29', s: 'identity', lvl: 'INFO', src: 'health', m: 'health HEALTHY 200' },
  { t: '14:50:29', s: 'telemetry', lvl: 'INFO', src: 'health', m: 'health HEALTHY process running' },
  { t: '14:50:29', s: 'invoices-api', lvl: 'INFO', src: 'stdout', m: 'INFO invoices-api 127.0.0.1 "GET /health HTTP/1.1" 200 -' },
  { t: '14:50:29', s: 'invoices-api', lvl: 'INFO', src: 'health', m: 'health HEALTHY 200' },
  { t: '14:50:29', s: 'telemetry', lvl: 'INFO', src: 'stdout', m: 'POST /billing/charge -> 200' },
  { t: '14:50:30', s: 'invoices-api', lvl: 'INFO', src: 'stdout', m: 'INFO invoices-api heartbeat jobs=372 queued=372' },
  { t: '14:50:30', s: 'invoices-api', lvl: 'INFO', src: 'stdout', m: "INFO invoices-api queued invoice job 373 ('nightly reconciliation sweep')" },
  { t: '14:50:30', s: 'invoices-api', lvl: 'TRACE', src: 'stdout', m: 'trace job=373 request_id=af37cbf6072d method=POST' },
  { t: '14:50:31', s: 'identity', lvl: 'INFO', src: 'stdout', m: 'INFO identity 127.0.0.1 "GET /health HTTP/1.1" 200 -' },
  { t: '14:50:33', s: 'identity', lvl: 'INFO', src: 'stdout', m: 'INFO identity audit event=token.refresh user=invoices-worker@internal' },
  { t: '14:50:33', s: 'telemetry', lvl: 'INFO', src: 'stdout', m: 'GET /invoices -> 200' },
  { t: '14:50:33', s: 'invoices-api', lvl: 'INFO', src: 'health', m: 'health HEALTHY 200' }
]

const logFilters = [
  { name: 'all', count: '26178', on: true },
  { name: 'billing-console', count: '0' },
  { name: 'identity', count: '7351' },
  { name: 'invoices-api', count: '7536' },
  { name: 'invoices-worker', count: '2', err: true },
  { name: 'postgres', count: '0' },
  { name: 'telemetry', count: '11284' }
]

const profiles = [
  { name: 'backend', current: false, count: 4, services: [
    { g: '✓', n: 'identity' }, { g: '✓', n: 'invoices-api' }, { g: 'o', n: 'invoices-worker' }, { g: '✓', n: 'telemetry' }
  ] },
  { name: 'data', current: false, count: 1, services: [
    { g: 'o', n: 'postgres' }
  ] },
  { name: 'full', current: false, count: 5, services: [
    { g: '✓', n: 'identity' }, { g: '✓', n: 'invoices-api' }, { g: 'o', n: 'invoices-worker' }, { g: 'o', n: 'billing-console' }, { g: '✓', n: 'telemetry' }
  ] },
  { name: 'minimal', current: true, count: 3, services: [
    { g: '✓', n: 'identity' }, { g: '✓', n: 'invoices-api' }, { g: '✓', n: 'telemetry' }
  ] }
]

const screens = [
  { name: 'Dashboard', tab: 'dashboard', foot: 'dashboard', hints: '/ command   space select   * all   – none', title: 'Your running stack, in one view.', description: 'Services and their combined logs, side by side. Here the minimal profile has identity, invoices-api, and telemetry healthy.', alt: 'devctl 0.6.0 dashboard: a services pane listing six services with three healthy in the minimal profile, next to their combined live logs.' },
  { name: 'Logs', tab: 'logs', foot: 'logs', hints: '/ command   ↔ filter   e errors   i internal logs', title: 'Follow the output across services.', description: 'One stream with timestamps, service names, levels, and messages — filter by service, jump to errors, page through history.', alt: 'devctl centralized logs screen with per-service filter tabs and timestamped output from identity, invoices-api, and telemetry.' },
  { name: 'Profiles', tab: '', foot: 'profiles', hints: '/ command   space set current   enter set and start', title: 'Choose the services for your task.', description: 'The demo defines backend, data, full, and minimal. minimal is current — its three services start together.', alt: 'devctl profiles screen listing backend, data, full, and minimal, with minimal current and its three services checked.' }
]

const screen = computed(() => screens[selected.value])
</script>

<template>
  <div class="walkthrough">
    <div class="walkthrough-controls" role="group" aria-label="devctl TUI screens">
      <button v-for="(item, index) in screens" :key="item.name" type="button" :aria-pressed="selected === index" aria-controls="tui-window" @click="selected = index"><span aria-hidden="true">0{{ index + 1 }}</span>{{ item.name }}</button>
    </div>

    <div id="tui-window" class="tui" role="img" :aria-label="screen.alt">
      <div class="tui-top">
        <span class="tui-brand">devctl <span class="tk-dim">0.6.0</span></span>
        <span class="tk-dim">demo-platform</span>
        <span class="tk-dim">minimal</span>
        <span class="tui-gap" aria-hidden="true"></span>
        <span class="pill pill-green">3/6 running</span>
        <span class="pill pill-pink">ADC missing</span>
      </div>
      <div class="tui-tabs">
        <span v-for="tab in tabs" :key="tab" :class="['tui-tab', { on: tab === screen.tab }]">{{ tab }}</span>
        <span class="tui-gap" aria-hidden="true"></span>
        <span class="tk-dim">/ command</span>
      </div>

      <div :key="selected" class="tui-body">
        <!-- Dashboard -->
        <div v-if="screen.tab === 'dashboard'" class="tk-dash">
          <div class="tk-box tk-svc">
            <span class="tk-legend">services</span>
            <div class="tk-svc-head"><span class="chip">3/6</span><span class="pill pill-pink">479 errors</span></div>
            <div class="tk-svc-cols"><span>sel</span><span>name</span><span>state</span></div>
            <div v-for="svc in services" :key="svc.name" :class="['tk-svc-row', { sel: svc.sel }]">
              <span class="tk-caret">{{ svc.sel ? '›' : '' }}</span>
              <span class="tk-box-glyph">[ ]</span>
              <span :class="['tk-glyph', svc.on ? 'ok' : 'off']">{{ svc.glyph }}</span>
              <span :class="['tk-name', svc.on ? 'up' : 'down']">{{ svc.name }}</span>
              <span :class="['tk-state', svc.on ? 'up' : 'down']">{{ svc.state }}</span>
            </div>
          </div>
          <div class="tk-box tk-logs">
            <span class="tk-legend">logs · all · 17343–17542 of 17542</span>
            <div class="tk-viewbar"><span class="pill pill-soft">view 17343–17542 · at latest</span><span class="tk-dim tk-viewbar-hint">pgup/pgdn move · g latest</span></div>
            <div class="tk-loglist">
              <div v-for="(l, i) in dashboardLog" :key="i" class="tk-logline">
                <span class="tk-time">{{ l.t }}</span>
                <span :class="['tk-svc-tag', 's-' + l.s]">{{ l.s }}</span>
                <span :class="['tk-lvl', 'lvl-' + l.lvl.toLowerCase()]">{{ l.lvl }}</span>
                <span class="tk-src">{{ l.src }}</span>
                <span :class="['tk-msg', { warn: l.lvl === 'WARN' }]">{{ l.m }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Logs -->
        <div v-else-if="screen.tab === 'logs'" class="tk-full">
          <div class="tk-filters">
            <span v-for="f in logFilters" :key="f.name" :class="['pill', f.on ? 'pill-green' : 'pill-ghost', { err: f.err }]">{{ f.name }} · {{ f.count }}</span>
            <span class="tk-dim tk-levels">all levels</span>
          </div>
          <div class="tk-viewbar"><span class="pill pill-soft">view 17396–17595 of 17595 · at latest</span><span class="tk-dim tk-viewbar-hint">pgup/pgdn move history window · g latest</span></div>
          <div class="tk-box tk-logs">
            <span class="tk-legend">logs · all services · 17396–17595 of 17595</span>
            <div class="tk-loglist">
              <div v-for="(l, i) in fullLog" :key="i" class="tk-logline">
                <span class="tk-time">{{ l.t }}</span>
                <span :class="['tk-svc-tag', 's-' + l.s]">{{ l.s }}</span>
                <span :class="['tk-lvl', 'lvl-' + l.lvl.toLowerCase()]">{{ l.lvl }}</span>
                <span class="tk-src">{{ l.src }}</span>
                <span :class="['tk-msg', { warn: l.lvl === 'WARN' }]">{{ l.m }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Profiles -->
        <div v-else class="tk-box tk-profiles">
          <span class="tk-legend">profiles</span>
          <div class="tk-prof-head">4 profiles&nbsp;·&nbsp;current: <span class="ok">minimal</span></div>
          <div v-for="p in profiles" :key="p.name" :class="['tk-prof-card', { current: p.current }]">
            <span class="tk-legend">{{ p.name }}</span>
            <div class="tk-prof-status">
              <span :class="p.current ? 'ok' : 'tk-dim'" aria-hidden="true">{{ p.current ? '●' : 'o' }}</span>
              {{ p.current ? 'current profile' : 'not active' }}&nbsp;·&nbsp;{{ p.count }} {{ p.count === 1 ? 'service' : 'services' }}
            </div>
            <div class="tk-prof-services">
              <span v-for="svc in p.services" :key="svc.n"><span :class="['tk-glyph', svc.g === '✓' ? 'ok' : 'off']" aria-hidden="true">{{ svc.g }}</span><span :class="['s-' + svc.n]">{{ svc.n }}</span></span>
            </div>
          </div>
          <div class="tk-prof-hint tk-dim" aria-hidden="true">space set current&nbsp;·&nbsp;enter set and start</div>
        </div>
      </div>

      <div class="tui-foot">
        <span>{{ screen.foot }}</span>
        <span class="pill pill-green">LIVE</span>
        <span class="tk-dim">Profile minimal</span>
        <span class="tui-gap" aria-hidden="true"></span>
        <span class="tk-dim tui-foot-hints">{{ screen.hints }}</span>
      </div>
    </div>

    <figcaption class="walkthrough-caption" aria-live="polite" aria-atomic="true">
      <strong>{{ screen.title }}</strong>
      <p>{{ screen.description }}</p>
    </figcaption>
  </div>
</template>

<style scoped>
.walkthrough { min-width: 0; }
.walkthrough-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
.walkthrough-controls button { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px 14px; border: 1px solid var(--vp-c-divider); border-radius: 5px; font: 500 12px var(--vp-font-family-base); color: var(--vp-c-text-2); cursor: pointer; }
.walkthrough-controls button span { font: 10px var(--vp-font-family-mono); }
.walkthrough-controls button[aria-pressed="true"] { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.walkthrough-controls button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 4px; }

/* Terminal window — a fixed dark palette so it reads as a terminal in both site themes */
.tui { --tk-bg: #15201d; --tk-line: #385648; --tk-dim: #86988f; --tk-txt: #d3e1da; overflow: hidden; border: 1px solid #4f7d68; border-radius: 8px; background: var(--tk-bg); color: var(--tk-txt); font: 12px/1.55 var(--vp-font-family-mono); }
.tk-dim { color: var(--tk-dim); }
.ok { color: #6bd39a; }
.off { color: var(--tk-dim); }
.tui-gap { flex: 1; }

.tui-top, .tui-tabs, .tui-foot { display: flex; align-items: center; gap: 14px; padding: 7px 12px; }
.tui-top { border-bottom: 1px solid var(--tk-line); }
.tui-brand { color: #f0f6f2; font-weight: 600; }
.tui-tabs { gap: 18px; padding-top: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--tk-line); color: var(--tk-dim); }
.tui-tab.on { color: #f0f6f2; }
.tui-foot { border-top: 1px solid var(--tk-line); }
.tui-foot > span:first-child { color: var(--tk-txt); }
.tui-foot-hints { letter-spacing: .01em; }

.pill { border-radius: 3px; padding: 1px 7px; font-weight: 600; white-space: nowrap; }
.pill-green { background: #6bd39a; color: #10201a; }
.pill-pink { background: #eb9aab; color: #3a121c; }
.pill-soft { background: #1f8f66; color: #eafff4; font-weight: 500; }
.pill-ghost { background: #22322c; color: #b6c8bf; font-weight: 500; }
.pill-ghost.err { color: #eb9aab; }
.chip { border: 1px solid var(--tk-line); border-radius: 3px; padding: 1px 7px; color: var(--tk-txt); }

.tui-body { padding: 16px 12px 12px; }

/* box with a legend notch on its top border */
.tk-box { position: relative; border: 1px solid var(--tk-line); border-radius: 5px; padding: 15px 12px 12px; }
.tk-legend { position: absolute; top: -0.72em; left: 12px; padding: 0 6px; background: var(--tk-bg); color: var(--tk-dim); }

/* Dashboard */
.tk-dash { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 12px; }
.tk-svc-head { display: flex; gap: 10px; margin-bottom: 12px; }
.tk-svc-cols { display: grid; grid-template-columns: 58px 1fr 72px; color: var(--tk-dim); padding: 0 2px 4px; }
.tk-svc-row { display: grid; grid-template-columns: 14px 26px 16px 1fr 72px; align-items: center; gap: 0 4px; padding: 1px 2px; border-radius: 3px; }
.tk-svc-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-svc-row.sel { background: #24382f; }
.tk-caret { color: #6bd39a; }
.tk-box-glyph { color: var(--tk-dim); }
.tk-glyph.ok { color: #6bd39a; }
.tk-name.up, .tk-state.up { color: #6bd39a; }
.tk-name.down { color: var(--tk-txt); }
.tk-state.down { color: var(--tk-dim); }

.tk-viewbar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.tk-viewbar-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tk-loglist { display: flex; flex-direction: column; }
.tk-logline { display: grid; grid-template-columns: 62px 104px 44px 50px minmax(0, 1fr); gap: 0 8px; line-height: 1.5; }
.tk-logline > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-time { color: #6f857c; }
.tk-src { color: var(--tk-dim); }
.tk-lvl { color: var(--tk-dim); }
.lvl-warn { color: #e5c46b; }
.tk-msg { color: #c2d2ca; }
.tk-msg.warn { color: #e5c46b; }

/* stable per-service colours, shared by log tags and profile chips */
.s-telemetry { color: #57c8b6; }
.s-identity { color: #a9d3c6; }
.s-invoices-api { color: #d6ac78; }
.s-invoices-worker { color: #eb9aab; }
.s-billing-console { color: #e6a9b4; }
.s-postgres { color: #b7c6be; }

/* Logs full screen */
.tk-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 10px; }
.tk-levels { margin-left: auto; }

/* Profiles */
.tk-profiles { padding-top: 18px; }
.tk-prof-head { color: var(--tk-dim); margin-bottom: 16px; }
.tk-prof-card { position: relative; border: 1px solid var(--tk-line); border-radius: 5px; padding: 12px 12px 11px; margin-top: 16px; }
.tk-prof-card.current { border-color: #5cb98c; background: #1a2a24; }
.tk-prof-card .tk-legend { color: var(--tk-dim); }
.tk-prof-card.current .tk-legend { color: #8fdcb6; }
.tk-prof-status { color: var(--tk-dim); }
.tk-prof-services { display: flex; flex-wrap: wrap; gap: 6px 20px; margin-top: 8px; }
.tk-prof-services > span { display: inline-flex; align-items: baseline; gap: 7px; }
.tk-prof-hint { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--tk-line); font-size: 11px; }

.walkthrough-caption { min-height: 68px; margin-top: 20px; }
.walkthrough-caption strong { font-size: 15px; font-weight: 500; color: var(--vp-c-text-1); }
.walkthrough .walkthrough-caption p { margin: 5px 0 0; font-size: 13px; line-height: 1.65; color: var(--vp-c-text-2); }

@media (max-width: 760px) {
  .tui { font-size: 10px; }
  .tui-top, .tui-tabs, .tui-foot { gap: 8px; flex-wrap: wrap; }
  .tk-dash { grid-template-columns: 1fr; }
  .tk-logline { grid-template-columns: 48px 78px 34px minmax(0, 1fr); }
  .tk-logline .tk-src { display: none; }
  .tui-foot-hints, .tk-viewbar-hint { display: none; }
  .walkthrough-caption { min-height: 96px; }
}
@media (max-width: 760px) and (min-width: 521px) {
  .walkthrough-controls button { flex: 1; justify-content: center; }
}

@media (prefers-reduced-motion: no-preference) {
  .tui-body { animation: tui-in .2s ease-out; }
  .walkthrough-controls button { transition: background .2s, border-color .2s; }
  .walkthrough-controls button:hover { background: var(--vp-c-brand-soft); }
}
@keyframes tui-in { from { opacity: .55; } to { opacity: 1; } }
</style>

<script setup lang="ts">
// A compact, static reconstruction of the real devctl dashboard. It is
// intentionally dense: the hero should show the product, not a generic shell.
const services = [
  { name: 'billing-console', tone: 'cyan' },
  { name: 'identity', tone: 'teal' },
  { name: 'invoices-api', tone: 'blue' },
  { name: 'invoices-worker', tone: 'pink' },
  { name: 'postgres', tone: 'cyan' },
  { name: 'telemetry', tone: 'teal' }
]

const logs = [
  { time: '15:08:53', service: 'devctl', level: 'INFO', message: 'supervisor started session=2026-09-05T15-08', tone: 'amber' },
  { time: '15:08:53', service: 'mcp', level: 'INFO', message: 'mcp listening on 127.0.0.1:8799', tone: 'teal' },
  { time: '15:08:53', service: 'auth', level: 'INFO', message: 'authentication changed user=dev@example.com', tone: 'purple' },
  { time: '15:21:11', service: 'mcp', level: 'INFO', message: 'profile backend started successfully', tone: 'teal', warning: false }
]
</script>

<template>
  <div class="tui" aria-hidden="true">
    <div class="tui__topbar">
      <span class="tui__project">devctl&nbsp;&nbsp; demo-platform&nbsp;&nbsp; backend</span>
      <span class="tui__top-spacer" />
      <span class="tui__muted">6 running</span>
      <span class="tui__chip tui__chip--blue">MCP</span>
      <span class="tui__chip tui__chip--green">ADC ok</span>
    </div>

    <div class="tui__tabs">
      <span class="is-active">dashboard</span><span>services</span><span>logs</span><span>proxy</span>
    </div>

    <div class="tui__workspace">
      <section class="tui__panel tui__services">
        <div class="tui__panel-title">services</div>
        <div class="tui__service-head"><span>sel</span><span>name</span><span>state</span></div>
        <div v-for="(service, index) in services" :key="service.name" class="tui__service-row" :class="`is-${service.tone}`">
          <span class="tui__selection">{{ index === 0 ? '›' : '' }}</span>
          <span class="tui__service-name">● {{ service.name }}</span>
          <span class="tui__state">RUNNING</span>
        </div>
      </section>

      <section class="tui__panel tui__logs">
        <div class="tui__panel-title">logs&nbsp; · &nbsp;all&nbsp; · &nbsp;1–4 of 4</div>
        <div class="tui__log-tabs"><span class="is-current">all · 4</span><span>billing-console · 0</span><span>identity · 0</span><span>invoices-api · 0</span></div>
        <div class="tui__rule" />
        <div class="tui__log-lines">
          <div v-for="log in logs" :key="`${log.time}-${log.service}`" class="tui__log-line" :class="{ 'is-warning': log.warning }">
            <span class="tui__time">{{ log.time }}</span><span class="tui__log-service" :class="`is-${log.tone}`">{{ log.service }}</span><span class="tui__level">{{ log.level }}</span><span class="tui__message">{{ log.message }}</span>
          </div>
        </div>
      </section>
    </div>

    <div class="tui__status"><span><i>dashboard</i><i class="is-live">LIVE</i></span><span><b>/</b> command&nbsp;&nbsp; <b>space</b> select&nbsp;&nbsp; <b>enter</b> start or open&nbsp;&nbsp; <b>n</b> start&nbsp;&nbsp; <b>x</b> stop</span></div>
  </div>
</template>

<style scoped>
.tui {
  --tui-bg: #15201d;
  --tui-line: #34463e;
  --tui-text: #b8b8b8;
  --tui-muted: #747474;
  --tui-cyan: #89dbb8;
  --tui-teal: #56d6bd;
  --tui-magenta: #ec43e7;
  --tui-blue: #688eff;
  --tui-green: #56ef68;
  width: 100%;
  overflow: hidden;
  color: var(--tui-text);
  background: var(--tui-bg);
  border: 1px solid #333;
  border-radius: 7px;
  box-shadow: 0 30px 70px -30px rgba(0, 0, 0, .82), 0 0 0 1px rgba(255, 255, 255, .025) inset;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  line-height: 1.25;
  letter-spacing: -.025em;
  text-align: left;
}
.tui__topbar, .tui__tabs, .tui__command, .tui__status { display: flex; align-items: center; gap: 7px; padding: 7px 9px; white-space: nowrap; }
.tui__topbar { min-height: 20px; border-bottom: 1px solid var(--tui-line); }
.tui__top-spacer { flex: 1; }
.tui__project, .tui__muted { color: var(--tui-text); }
.tui__muted { color: var(--tui-muted); }
.tui__chip { display: inline-block; padding: 2px 7px; color: #141414; font-weight: 700; }
.tui__chip--cyan, .tui__tabs .is-active, .tui__log-tabs .is-current, .tui__status i:first-child { background: var(--tui-cyan); }
.tui__chip--magenta { background: var(--tui-magenta); }
.tui__chip--blue { background: var(--tui-blue); }
.tui__chip--green, .tui__status .is-live { background: var(--tui-green); }
.tui__tabs { gap: 0; overflow: hidden; padding: 7px 9px; border-bottom: 1px solid var(--tui-line); color: #aaa; }
.tui__tabs span { padding: 2px 6px; }
.tui__tabs .is-active { color: #111; }
.tui__workspace { display: grid; grid-template-columns: 34% 1fr; gap: 4px; min-height: 230px; padding: 9px 4px 8px; }
.tui__panel { position: relative; display: flex; min-width: 0; flex-direction: column; border: 1px solid var(--tui-line); border-radius: 5px; }
.tui__panel-title { position: absolute; top: -9px; left: 9px; padding: 0 4px; color: var(--tui-cyan); background: var(--tui-bg); font-size: 11px; }
.tui__subhead, .tui__action, .tui__service-head, .tui__log-tools, .tui__log-tabs { padding: 10px 9px 6px; }
.tui__subhead, .tui__action, .tui__log-tools { color: var(--tui-text); }
.tui__action b, .tui__log-help b, .tui__command b, .tui__status b { color: var(--tui-cyan); font-weight: 600; }
.tui__rule { height: 1px; margin: 0 5px; background: var(--tui-line); }
.tui__service-head, .tui__service-row { display: grid; grid-template-columns: 24px 1fr 52px; gap: 2px; padding: 2px 9px; }
.tui__service-head { padding-top: 8px; color: var(--tui-muted); }
.tui__service-row:first-of-type { background: rgba(255,255,255,.018); }
.tui__selection { color: var(--tui-muted); }
.tui__service-row:first-of-type .tui__selection { color: var(--tui-cyan); }
.tui__service-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tui__state { color: #80dab5; }
.tui__service-row.is-cyan .tui__service-name { color: var(--tui-cyan); }
.tui__service-row.is-teal .tui__service-name { color: var(--tui-teal); }
.tui__service-row.is-blue .tui__service-name { color: #a9b7ff; }
.tui__service-row.is-pink .tui__service-name { color: #fa6b92; }
.tui__services-foot { margin-top: auto; padding: 8px 9px; border-top: 1px solid var(--tui-line); color: var(--tui-text); }
.tui__log-tools { display: flex; gap: 7px; align-items: center; overflow: hidden; white-space: nowrap; }
.tui__log-tabs { display: flex; gap: 9px; overflow: hidden; padding: 7px 5px; color: #9ab7ff; white-space: nowrap; }
.tui__log-tabs span { padding: 3px 5px; }
.tui__log-tabs .is-current { color: #101010; }
.tui__log-lines { display: grid; gap: 5px; padding: 9px 8px; }
.tui__log-line { display: grid; grid-template-columns: 58px 48px 38px minmax(0, 1fr); gap: 5px; white-space: nowrap; }
.tui__time, .tui__source { color: var(--tui-muted); }
.tui__level { color: var(--tui-blue); }
.tui__log-service { font-weight: 600; }
.tui__log-service.is-amber { color: #f4a546; }
.tui__log-service.is-teal { color: var(--tui-teal); }
.tui__log-service.is-purple { color: #bb8df4; }
.tui__message { overflow: hidden; color: #aaa; text-overflow: clip; }
.tui__log-line.is-warning .tui__level, .tui__log-line.is-warning .tui__message { color: #e6e73e; }
.tui__log-help { margin-top: auto; padding: 8px; border-top: 1px solid var(--tui-line); color: var(--tui-muted); white-space: nowrap; }
.tui__command { min-height: 22px; border-top: 1px solid var(--tui-line); color: var(--tui-muted); }
.tui__status { justify-content: space-between; min-height: 22px; padding: 0 6px; border-top: 1px solid var(--tui-line); color: var(--tui-muted); }
.tui__status i { display: inline-block; padding: 3px 7px; color: #121212; font-style: normal; font-weight: 700; }
@media (max-width: 959px) { .tui { width: 100%; font-size: clamp(7px, 1.75vw, 10px); } }
@media (max-width: 640px) {
  .tui__workspace { grid-template-columns: 1fr; min-height: 200px; }
  .tui__logs { display: none; }
  .tui { font-size: 11px; }
  .tui__service-head, .tui__service-row { grid-template-columns: 24px 1fr 58px; padding-block: 5px; }
  .tui__state { display: block; }
  .tui__status > span:last-child { display: none; }
  .tui__topbar .tui__muted { display: none; }
}
@media (max-width: 560px) {
  .tui__topbar .tui__muted, .tui__tabs span:nth-child(n+7), .tui__log-tabs span:nth-child(n+3), .tui__status > span:last-child { display: none; }
  .tui__workspace { grid-template-columns: 38% 1fr; min-height: 245px; }
  .tui__service-head, .tui__service-row { grid-template-columns: 35px 1fr; }
  .tui__state, .tui__log-line .tui__source, .tui__log-line .tui__level { display: none; }
  .tui__log-line { grid-template-columns: 42px 30px minmax(0, 1fr); gap: 3px; }
  .tui__topbar, .tui__tabs, .tui__command { gap: 3px; padding-left: 5px; padding-right: 5px; }
}
@media (prefers-reduced-motion: reduce) { .tui * { animation: none !important; } }
</style>

<script setup lang="ts">
// A CSS terminal that mirrors what devctl actually shows: a services
// dashboard with live status, plus a rolling log stream. Pure CSS/HTML —
// no canvas, no timers — so it stays cheap and SSR-safe.
const services = [
  { name: 'api-gateway', port: ':8080', state: 'running', meta: 'up 1m' },
  { name: 'auth-service', port: ':8081', state: 'running', meta: 'up 1m' },
  { name: 'web-console', port: ':18003', state: 'running', meta: 'up 42s' },
  { name: 'worker', port: '—', state: 'starting', meta: 'health…' },
  { name: 'postgres', port: ':5432', state: 'stopped', meta: 'data' }
]

const logs = [
  { t: '12:04:01', svc: 'api-gateway', msg: 'listening on :8080' },
  { t: '12:04:02', svc: 'auth-service', msg: 'ADC ok · project acme-dev' },
  { t: '12:04:03', svc: 'proxy', msg: 'route /iap → token injected' },
  { t: '12:04:04', svc: 'web-console', msg: 'ready in 812 ms' }
]
</script>

<template>
  <div class="term" aria-hidden="true">
    <div class="term__bar">
      <span class="term__dot term__dot--r" />
      <span class="term__dot term__dot--y" />
      <span class="term__dot term__dot--g" />
      <span class="term__title">devctl — ~/acme-platform</span>
    </div>

    <div class="term__body">
      <div class="term__prompt">
        <span class="term__sigil">❯</span> devctl
      </div>

      <div class="term__head">
        <span class="term__label">DASHBOARD</span>
        <span>profile <b>full</b></span>
        <span class="term__ok">4/5 up</span>
        <span>proxy <span class="term__d term__d--run" /></span>
        <span>identity <span class="term__ok">✓</span></span>
      </div>

      <div class="term__rows">
        <div v-for="s in services" :key="s.name" class="term__row">
          <span class="term__d" :class="`term__d--${s.state}`" />
          <span class="term__svc">{{ s.name }}</span>
          <span class="term__port">{{ s.port }}</span>
          <span class="term__state" :class="`is-${s.state}`">{{ s.state }}</span>
          <span class="term__meta">{{ s.meta }}</span>
        </div>
      </div>

      <div class="term__sep">LOGS</div>
      <div class="term__logs">
        <div v-for="(l, i) in logs" :key="i" class="term__log" :style="{ '--i': i }">
          <span class="term__t">{{ l.t }}</span>
          <span class="term__lsvc">{{ l.svc }}</span>
          <span class="term__msg">{{ l.msg }}</span>
        </div>
        <div class="term__log term__log--cursor" :style="{ '--i': logs.length }">
          <span class="term__t">12:04:04</span>
          <span class="term__lsvc">supervisor</span>
          <span class="term__msg">watching<span class="term__cursor">▊</span></span>
        </div>
      </div>

      <div class="term__keys">
        <b>enter</b> start · <b>x</b> stop · <b>l</b> logs · <b>?</b> help · <b>q</b> quit
      </div>
    </div>
  </div>
</template>

<style scoped>
.term {
  width: min(560px, 92vw);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.55;
  border-radius: 14px;
  overflow: hidden;
  background: #0b1016;
  border: 1px solid rgba(45, 212, 191, 0.18);
  box-shadow:
    0 30px 70px -30px rgba(6, 182, 212, 0.45),
    0 12px 30px -12px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.term__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: linear-gradient(180deg, #10161d, #0b1016);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.term__dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  display: inline-block;
}
.term__dot--r { background: #ff5f57; }
.term__dot--y { background: #febc2e; }
.term__dot--g { background: #28c840; }
.term__title {
  margin-left: 8px;
  color: #7d8794;
  font-size: 12px;
  letter-spacing: 0.02em;
}

.term__body { padding: 14px 16px 16px; }

.term__prompt { color: #c9d3de; margin-bottom: 12px; }
.term__sigil { color: #2dd4bf; font-weight: 700; }

.term__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  color: #8a95a2;
  font-size: 12px;
  padding-bottom: 10px;
  margin-bottom: 8px;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
}
.term__head b { color: #f59e0b; font-weight: 600; }
.term__label { color: #2dd4bf; letter-spacing: 0.14em; font-weight: 700; }
.term__ok { color: #2dd4bf; }

.term__rows { display: grid; gap: 3px; }
.term__row {
  display: grid;
  grid-template-columns: 14px 1.5fr 0.8fr 0.9fr 0.7fr;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: #c9d3de;
}
.term__svc { color: #e6edf3; }
.term__port { color: #06b6d4; }
.term__meta { color: #6b7581; text-align: right; }

.term__state { font-size: 11px; text-transform: lowercase; }
.term__state.is-running { color: #2dd4bf; }
.term__state.is-starting { color: #f59e0b; }
.term__state.is-stopped { color: #6b7581; }

.term__d {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  background: #6b7581;
}
.term__d--running,
.term__d--run { background: #2dd4bf; box-shadow: 0 0 8px rgba(45, 212, 191, 0.8); }
.term__d--starting { background: #f59e0b; animation: pulse 1.2s ease-in-out infinite; }
.term__d--stopped { background: #46505c; }

.term__sep {
  margin: 12px 0 6px;
  color: #2dd4bf;
  letter-spacing: 0.14em;
  font-size: 11px;
  font-weight: 700;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
  padding-top: 10px;
}

.term__logs { display: grid; gap: 2px; }
.term__log {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 10px;
  opacity: 0;
  transform: translateY(3px);
  animation: rise 0.4s ease forwards;
  animation-delay: calc(var(--i) * 0.5s + 0.3s);
}
.term__t { color: #5c6673; }
.term__lsvc { color: #06b6d4; }
.term__msg { color: #b9c3ce; }
.term__cursor {
  color: #2dd4bf;
  animation: blink 1s step-end infinite;
  margin-left: 1px;
}

.term__keys {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  color: #6b7581;
  font-size: 11.5px;
}
.term__keys b { color: #c9d3de; font-weight: 600; }

@keyframes blink { 50% { opacity: 0; } }
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 8px rgba(245, 158, 11, 0.8); }
  50% { opacity: 0.35; box-shadow: 0 0 2px rgba(245, 158, 11, 0.3); }
}
@keyframes rise {
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .term__log { opacity: 1; transform: none; animation: none; }
  .term__cursor,
  .term__d--starting { animation: none; }
}
</style>

---
layout: home
---

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import webOverview from './assets/manual/web-overview.png'
import TerminalHero from './.vitepress/theme/TerminalHero.vue'
import changelogSource from '../CHANGELOG.md?raw'
import { changelogTeaser, formatReleaseDate, parseChangelog } from './.vitepress/theme/changelog'
import { ArrowDownLeft, ArrowUpRight, CaretRight, Check, Circle, Copy, Sparkle, SquaresFour, TerminalWindow } from './.vitepress/theme/phosphor'
const landingRoot = ref(null)
let revealObserver
let motionPreference
let pointerPreference
let pointerFrame = 0
let previewElement
let copyFeedbackTimer

function resetPreview() {
  cancelAnimationFrame(pointerFrame)
  if (!previewElement) return
  previewElement.style.removeProperty('--pointer-x')
  previewElement.style.removeProperty('--pointer-y')
  previewElement.removeAttribute('data-pointer')
}

function followPointer(event) {
  if (motionPreference?.matches || !pointerPreference?.matches || event.pointerType === 'touch') return
  previewElement = event.currentTarget
  const { clientX, clientY } = event
  cancelAnimationFrame(pointerFrame)
  pointerFrame = requestAnimationFrame(() => {
    const bounds = previewElement.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
    const y = Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height))
    previewElement.style.setProperty('--pointer-x', `${x * 100}%`)
    previewElement.style.setProperty('--pointer-y', `${y * 100}%`)
    previewElement.setAttribute('data-pointer', '')
  })
}

function revealAll() {
  revealObserver?.disconnect()
  landingRoot.value?.querySelectorAll('[data-reveal]').forEach(element => element.removeAttribute('data-reveal'))
}

function updateMotionPreference() {
  if (motionPreference?.matches) {
    revealAll()
    resetPreview()
  }
}

onMounted(() => {
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
  pointerPreference = window.matchMedia('(hover: hover) and (pointer: fine)')
  motionPreference.addEventListener('change', updateMotionPreference)
  if (motionPreference.matches || !('IntersectionObserver' in window)) return
  revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.setAttribute('data-reveal', 'visible')
      revealObserver.unobserve(entry.target)
    }
  }, { threshold: 0.06 })
  landingRoot.value?.querySelectorAll('.section-heading, .surface, .workflow-panel, .setup-copy, .setup-panel, .details-section > div, .web-notes, .demo-band, .faq-section > div, .closing').forEach(element => {
    // Leave content already on screen visible; enhance only upcoming sections.
    if (element.getBoundingClientRect().top < window.innerHeight) return
    element.setAttribute('data-reveal', 'pending')
    revealObserver.observe(element)
  })
})

onUnmounted(() => {
  clearTimeout(copyFeedbackTimer)
  revealObserver?.disconnect()
  motionPreference?.removeEventListener('change', updateMotionPreference)
  resetPreview()
})

const changelog = parseChangelog(changelogSource)
const latestRelease = changelog.releases.find(release => !release.unreleased)
const latestTeaser = changelogTeaser(latestRelease)

const storyStep = ref(0)
const story = [
  { label: 'Start your backend', title: 'Bring up only what you need.', text: 'In the demo platform, the backend profile groups identity, the API, its worker, and telemetry. Start them together, then attach to the same session.', command: 'devctl start --profile backend', detail: 'Next: devctl attach', link: '/profiles' },
  { label: 'Spot a failed request', title: 'Find the request that went wrong.', text: 'With proxy traffic flowing, open the proxy view and inspect a failed request. The request ID gives you a starting point for investigation.', command: '/proxy', detail: 'In the TUI · select a request to inspect it', link: '/proxy' },
  { label: 'Follow the evidence', title: 'Connect the trace to the logs.', text: 'When trace data is available, follow the request into its span tree and correlated logs. See which service failed and what it reported.', command: '/trace <trace-id>', detail: 'Tracing requires emitted trace data; logs work on their own.', link: '/telemetry' },
  { label: 'Fix and verify', title: 'Make the change. Check the result.', text: 'Edit your application, restart the affected service, and repeat the request. Inspect its health and output in the same session.', command: 'devctl restart invoices-api', detail: 'Then: devctl logs invoices-api', link: '/cli' }
]
const configExample = `version: 1
project:
  name: demo-platform
services:
  identity:
    command: [python3, main.py]
    working_dir: identity
    ports:
      http: 18001
    health:
      type: http
      url: http://127.0.0.1:18001/health
profiles:
  minimal:
    services: [identity]`
const copyLabel = ref('Copy command')
const activeProfile = ref('minimal')
const profileExamples = {
  minimal: { label: 'Keep it focused', description: 'Start with the essentials: identity, the invoices API, and telemetry.', services: ['identity', 'invoices-api', 'telemetry'] },
  backend: { label: 'Build an API', description: 'Focus on the backend. Bring up identity, the API, its worker, and telemetry as a single group.', services: ['identity', 'invoices-api', 'invoices-worker', 'telemetry'] },
  full: { label: 'Work end to end', description: 'Bring the console into the picture when your work crosses the frontend and backend.', services: ['identity', 'invoices-api', 'invoices-worker', 'billing-console', 'telemetry'] },
  data: { label: 'Start with data', description: 'Run the demo’s optional PostgreSQL container when you need a local database.', services: ['postgres'] }
}
async function copyInstall() {
  clearTimeout(copyFeedbackTimer)
  try {
    await navigator.clipboard.writeText('npm install --global @amr-m-abdelgawad/devctl')
    copyLabel.value = 'Copied!'
  } catch {
    copyLabel.value = 'Select the command to copy'
  }
  copyFeedbackTimer = setTimeout(() => { copyLabel.value = 'Copy command' }, 3500)
}
</script>

<div ref="landingRoot" class="landing vp-raw">
  <section class="landing-hero" aria-labelledby="hero-title">
    <div class="hero-atmosphere" aria-hidden="true">
      <div class="atmosphere-grid"></div>
      <div class="atmosphere-orbit atmosphere-orbit-one"></div>
      <div class="atmosphere-orbit atmosphere-orbit-two"></div>
    </div>
    <div class="hero-copy">
      <p class="eyebrow"><span class="status-dot"></span> THE LOCAL DEVELOPMENT ORCHESTRATOR</p>
      <h1 id="hero-title">More building.<br>Less <span>tab juggling.</span></h1>
      <p class="hero-description">Your services, logs, and local stack. One terminal to start, inspect, and keep everything moving.</p>
      <div class="hero-install" aria-label="Install devctl with npm">
        <div class="hero-install-line"><span class="hero-install-prompt" aria-hidden="true">$</span><code><span class="hero-install-verb">npm install</span> <span class="hero-install-flag">--global</span> @amr-m-abdelgawad/devctl</code></div>
        <button type="button" @click="copyInstall" :aria-label="copyLabel" :title="copyLabel"><Check v-if="copyLabel === 'Copied!'" :size="16" weight="regular" /><Copy v-else :size="16" weight="regular" /></button>
        <span class="hero-install-status" role="status">{{ copyLabel === 'Copy command' ? '' : copyLabel }}</span>
      </div>
      <p class="install-requirements">Node.js 18+ · macOS, Linux &amp; Windows <a :href="withBase('/installation')">Requirements ↗</a></p>
      <div class="hero-actions">
        <a class="primary-link" :href="withBase('/quickstart')">Get started <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
        <a class="text-link" href="https://github.com/amr-m-abdelgawad/devctl">Explore on GitHub <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
      </div>
      <p class="hero-footnote">No account. Your machine. <a href="#interactive-demo">Try the demo <span aria-hidden="true">↓</span></a></p>
    </div>
    <div id="interactive-demo" class="hero-preview" tabindex="-1" @pointermove="followPointer" @pointerleave="resetPreview" @pointercancel="resetPreview">
      <div class="preview-caption"><span>ONE TERMINAL. THE WHOLE PICTURE.</span><span aria-hidden="true"><ArrowDownLeft :size="20" weight="regular" /></span></div>
      <TerminalHero />
    </div>
  </section>

  <div class="landing-signal"><span>Less switching. <b>More context.</b></span><span>TUI <i>/</i> CLI <i>/</i> MCP</span><span>One shared session <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></span></div>

  <section class="landing-section" aria-labelledby="surfaces-title">
    <div class="section-heading"><div><p class="eyebrow">WORK YOUR WAY</p><h2 id="surfaces-title">One stack. Your kind of control.</h2></div><p>Stay hands-on, script the routine,<br>or let your agent take the next step.</p></div>
    <div class="surface-grid">
      <a class="surface" :href="withBase('/tui')"><span class="surface-symbol" aria-hidden="true"><SquaresFour :size="28" weight="light" /></span><span class="surface-label">Terminal</span><h3>A home for your stack.</h3><p>Start services, follow logs, and check health in a keyboard-first terminal interface.</p><span class="surface-link">Explore the TUI <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></span></a>
      <a class="surface" :href="withBase('/cli')"><span class="surface-symbol" aria-hidden="true"><TerminalWindow :size="28" weight="light" /></span><span class="surface-label">Command line</span><h3>Make it a command.</h3><p>Bring the same controls to scripts and CI. Run tasks, inspect config, and keep moving.</p><span class="surface-link">Meet the CLI <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></span></a>
      <a class="surface" :href="withBase('/mcp')"><span class="surface-symbol" aria-hidden="true"><Sparkle :size="28" weight="light" /></span><span class="surface-label">AI agents</span><h3>Give AI the context.</h3><p>Connect your agent over MCP to inspect and operate the same local session. Enabled when you choose.</p><span class="surface-link">Connect with MCP <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></span></a>
    </div>
  </section>

  <section class="story-section landing-section" aria-labelledby="story-title">
    <div class="section-heading"><div><p class="eyebrow">FROM STARTUP TO SOLVED</p><h2 id="story-title">One session.<br>The whole investigation.</h2></div><p>A typical debugging workflow<br>using the included demo platform.</p></div>
    <div class="story-layout">
      <div class="story-steps" role="group" aria-label="Explore a debugging workflow"><button v-for="(step, index) in story" :key="step.label" type="button" :aria-pressed="storyStep === index" aria-controls="story-detail" @click="storyStep = index"><span>0{{ index + 1 }}</span>{{ step.label }}<ArrowUpRight :size="14" /></button></div>
      <div id="story-detail" class="story-detail" aria-live="polite" aria-atomic="true"><p class="eyebrow">STEP 0{{ storyStep + 1 }} / 04</p><h3>{{ story[storyStep].title }}</h3><p>{{ story[storyStep].text }}</p><pre><code>{{ story[storyStep].command }}</code></pre><p class="story-note">{{ story[storyStep].detail }}</p><a class="text-link" :href="withBase(story[storyStep].link)">Read the guide <ArrowUpRight :size="14" /></a></div>
    </div>
  </section>

  <section class="workflow-section landing-section" aria-labelledby="workflow-title">
    <div class="section-heading"><div><p class="eyebrow">FIND YOUR FOCUS</p><h2 id="workflow-title">The right services.<br>For the task at hand.</h2></div><p>Group services into named profiles.<br>Start the part of your stack you need.</p></div>
    <div class="workflow-panel">
      <div class="workflow-options" role="group" aria-label="Explore example profiles">
        <button v-for="(profile, name) in profileExamples" :key="name" type="button" :aria-pressed="activeProfile === name" @click="activeProfile = name"><span>{{ profile.label }}</span><code>{{ name }}</code><span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></button>
        <a class="text-link" :href="withBase('/profiles')">Explore profiles <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
      </div>
      <div class="workflow-example" aria-live="polite" aria-atomic="true">
        <p class="eyebrow">DEMO PLATFORM / EXAMPLE PROFILE</p>
        <p :key="activeProfile" class="workflow-command"><span aria-hidden="true"><CaretRight :size="15" weight="regular" /></span><code>devctl start --profile {{ activeProfile }}</code></p>
        <p class="workflow-description">{{ profileExamples[activeProfile].description }}</p>
        <div class="workflow-tui" role="img" :aria-label="`devctl profiles screen — ${activeProfile}: ${profileExamples[activeProfile].services.join(', ')}`">
          <div class="wt-box" :key="activeProfile">
            <span class="wt-title">{{ activeProfile }}</span>
            <div class="wt-head"><span class="wt-dot" aria-hidden="true"><Circle :size="11" weight="fill" /></span> current profile&nbsp;·&nbsp;{{ profileExamples[activeProfile].services.length }} {{ profileExamples[activeProfile].services.length === 1 ? 'service' : 'services' }}</div>
            <div class="wt-services"><span v-for="service in profileExamples[activeProfile].services" :key="service"><span class="wt-check" aria-hidden="true"><Check :size="13" weight="bold" /></span>{{ service }}</span></div>
          </div>
          <div class="wt-hint" aria-hidden="true">space set current&nbsp;·&nbsp;enter set and start</div>
        </div>
        <p class="workflow-note">Your repo, your names. Profiles are defined in your config.</p>
      </div>
    </div>
  </section>

  <section class="setup-section landing-section" aria-labelledby="setup-title">
    <div class="setup-copy"><p class="eyebrow">FROM REPO TO RUNNING</p><h2 id="setup-title">Small setup.<br>Clear head.</h2><p>Start with Node.js. The npm package includes its own Bun runtime. Google Cloud is optional.</p><a class="text-link" :href="withBase('/installation')">Installation guide <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a></div>
    <div class="setup-panel">
      <div class="install-heading"><span>INSTALL ONCE. USE IN ANY REPO.</span><button type="button" @click="copyInstall" aria-live="polite"><Copy :size="14" weight="regular" /> {{ copyLabel }}</button></div>
      <div class="install-command"><span aria-hidden="true"><CaretRight :size="15" weight="regular" /></span><code>npm install --global @amr-m-abdelgawad/devctl</code></div>
      <p class="install-context">Then, from the repo you want to run:</p>
      <ol class="setup-steps"><li><span>01</span><div><code>devctl setup</code><p>Describe your services in a single config.</p></div></li><li><span>02</span><div><code>devctl doctor</code><p>See what’s missing before you start.</p></div></li><li><span>03</span><div><code>devctl</code><p>Open your dashboard. Press enter to start a profile.</p></div></li></ol>
    </div>
  </section>

  <section class="config-section landing-section" aria-labelledby="config-title">
    <div class="section-heading"><div><p class="eyebrow">YOUR REPO, DESCRIBED</p><h2 id="config-title">A little config.<br>A working picture.</h2></div><p>A minimal example adapted from the demo.<br>Run it from <code>examples/demo-platform</code> with Python 3.</p></div>
    <div class="config-layout"><div class="config-code"><div>.devctl/config.yaml <span>YAML</span></div><pre><code>{{ configExample }}</code></pre></div><div class="config-explained"><ol><li><strong>Keep your start command.</strong><p>Run the existing Python service in its own directory. No application rewrite.</p></li><li><strong>Describe readiness.</strong><p>Give the HTTP port a name and check the service’s <code>/health</code> endpoint.</p></li><li><strong>Choose a working set.</strong><p>The <code>minimal</code> profile here contains just identity. Add services as your repo grows.</p></li></ol><div class="config-result"><span>THIS CONFIG STARTS</span><strong>identity <small>HTTP · 18001</small></strong><code>devctl start --profile minimal</code></div><a class="text-link" :href="withBase('/configuration')">Explore the config reference <ArrowUpRight :size="14" /></a></div></div>
  </section>

  <section class="fit-section landing-section" aria-labelledby="fit-title">
    <div class="section-heading"><div><p class="eyebrow">WHERE IT FITS</p><h2 id="fit-title">Keep the tools.<br>Connect the workflow.</h2></div><p>Your existing tools keep their place. devctl brings the running session together.</p></div>
    <div class="fit-comparisons">
      <article class="fit-row"><div class="fit-tool"><span>01</span><h3>Docker Compose</h3><a href="https://docs.docker.com/compose/">Explore Compose <ArrowUpRight :size="13" /></a></div><div class="fit-purpose"><p class="fit-label">FOR YOUR CONTAINERS</p><p>Define multi-container applications, networks, and volumes.</p></div><div class="fit-addition"><p class="fit-label">WITH DEVCTL</p><p>Bring host processes and configured containers into one local session, with profiles and health checks.</p><small>Compose files aren’t imported automatically.</small></div></article>
      <article class="fit-row"><div class="fit-tool"><span>02</span><h3>Task runners</h3><a href="https://taskfile.dev/">Explore Task <ArrowUpRight :size="13" /></a></div><div class="fit-purpose"><p class="fit-label">FOR THE REPEATABLE</p><p>Build, format, and generate code with commands you already trust.</p></div><div class="fit-addition"><p class="fit-label">WITH DEVCTL</p><p>Keep those commands. Give long-running services and named tasks a shared place to run.</p></div></article>
      <article class="fit-row"><div class="fit-tool"><span>03</span><h3>Terminal tabs</h3><span class="fit-familiar">Your everyday workspace</span></div><div class="fit-purpose"><p class="fit-label">FOR DIRECT CONTROL</p><p>Open a shell, run a command, and work directly with a process.</p></div><div class="fit-addition"><p class="fit-label">WITH DEVCTL</p><p>See service state and logs together. Your CLI, TUI, and optional agent connection share one supervisor.</p></div></article>
    </div>
  </section>

  <section class="details-section landing-section" aria-labelledby="details-title"><div><p class="eyebrow">THOUGHTFUL BY DEFAULT</p><h2 id="details-title">Your machine.<br>Your ground rules.</h2><p>One supervisor keeps processes, containers, the proxy, and logs in sync across every control surface.</p><a class="text-link" :href="withBase('/overview')">See how it fits together <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a></div><div class="detail-list"><a :href="withBase('/configuration')"><span>01</span><div><h3>Configuration, not custom code.</h3><p>Define services, profiles, health gates, and hooks in YAML.</p></div><span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a><a :href="withBase('/proxy')"><span>02</span><div><h3>Authentication, handled locally.</h3><p>An auth-aware proxy injects Google / IAP tokens. Tokens stay out of logs.</p></div><span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a><a :href="withBase('/doctor')"><span>03</span><div><h3>Diagnostics without surprises.</h3><p>Doctor reports missing tools and setup issues. It never auto-enables anything.</p></div><span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a></div></section>

  <section class="web-showcase landing-section" aria-labelledby="web-title">
    <div class="section-heading"><div><p class="eyebrow">A DIFFERENT PERSPECTIVE</p><h2 id="web-title">Same session.<br>Room to see more.</h2></div><div class="web-showcase-copy"><p>Follow services, requests, and traces in an optional local console. The same supervisor, with a wider view.</p><a class="text-link" :href="withBase('/telemetry')">Explore the web console <ArrowUpRight :size="14" /></a></div></div>
    <figure class="web-product"><a :href="withBase('/telemetry')"><img :src="webOverview" width="2880" height="1800" loading="lazy" decoding="async" alt="devctl web console showing service health, profile controls, proxy requests, and recent errors" /></a><figcaption><span>THE LOCAL CONSOLE</span><span>Opt-in · Loopback only · One shared session</span></figcaption></figure>
    <div class="web-notes"><p><strong>Your session, expanded.</strong> Services, traces, and logs together.</p><p><strong>Local by default.</strong> Start it when you need it with <code>devctl web start</code>; the token rides in the URL fragment.</p></div>
  </section>

  <section class="capability-section landing-section" aria-labelledby="capability-title">
    <div class="section-heading"><div><p class="eyebrow">FOLLOW THE CONNECTIONS</p><h2 id="capability-title">More context.<br>Fewer blind spots.</h2></div></div>
    <div class="capability-grid"><article><span class="capability-index">01 / TOPOLOGY</span><h3>See what depends on what.</h3><p>Open <code>/topology</code> to inspect startup waves, health, and dependencies. Select a service to see its connections.</p><a class="text-link" :href="withBase('/tui')">Explore the TUI <ArrowUpRight :size="14" /></a></article><article><span class="capability-index">02 / REQUEST TRACING</span><h3>Follow a request across services.</h3><p>Inspect spans and correlated logs when your services emit trace data. Connect proxy requests to the evidence behind them.</p><a class="text-link" :href="withBase('/telemetry')">Explore tracing <ArrowUpRight :size="14" /></a></article><article><span class="capability-index">03 / YOUR AGENT</span><h3>Ask a better-informed question.</h3><p>“Why is invoices-api failing?” Enable MCP and connect your agent to inspect <code>get_status</code>, <code>recent_errors</code>, and <code>get_logs</code>. You control which tools are available.</p><a class="text-link" :href="withBase('/mcp')">Connect an agent <ArrowUpRight :size="14" /></a></article></div>
  </section>

  <section class="demo-section landing-section" aria-labelledby="demo-title">
    <div class="demo-band"><div><p class="eyebrow">TAKE A LOOK AROUND</p><h2 id="demo-title">Meet your practice stack.</h2><p>A console, an API, identity, and a worker. Explore the included demo platform before configuring your own repo.</p></div><a class="primary-link" href="https://github.com/amr-m-abdelgawad/devctl/tree/main/examples/demo-platform">Explore the demo <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a></div>
  </section>

  <section v-if="latestRelease" class="details-section landing-section" aria-labelledby="shipped-title">
    <div>
      <p class="eyebrow">JUST SHIPPED</p>
      <h2 id="shipped-title">{{ latestRelease.version }} is out.</h2>
      <p v-if="latestRelease.date">{{ formatReleaseDate(latestRelease.date) }}</p>
      <a class="text-link" :href="withBase('/changelog')">Read the changelog <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
    </div>
    <div class="detail-list">
      <a :href="withBase('/changelog')">
        <span>{{ latestRelease.version }}</span>
        <div>
          <h3>What’s new.</h3>
          <p>{{ latestTeaser }}</p>
        </div>
        <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span>
      </a>
    </div>
  </section>

  <section class="faq-section landing-section" aria-labelledby="faq-title">
    <div><p class="eyebrow">A FEW GOOD QUESTIONS</p><h2 id="faq-title">Before you<br>press enter.</h2><p>A little context for your first session.</p></div>
    <div class="faq-list">
      <details><summary>Do I need Docker or Google Cloud?</summary><p>Neither is required for local host processes. Use Docker or Podman when your configuration includes containers. Google Cloud tools are optional and only needed for the Google authentication features you choose to use. <a :href="withBase('/installation')">See installation requirements <span aria-hidden="true"><ArrowUpRight :size="12" weight="regular" /></span></a></p></details>
      <details><summary>Do I have to change my application code?</summary><p>Describe how your services run in <code>.devctl/config.yaml</code>: their commands, working directories, environment, and health checks. devctl works with that configuration. <a :href="withBase('/configuration')">Explore configuration <span aria-hidden="true"><ArrowUpRight :size="12" weight="regular" /></span></a></p></details>
      <details><summary>Can I use the CLI and TUI together?</summary><p>Yes. The TUI, CLI, and MCP connect to the same per-repo supervisor. Start a profile from the CLI and attach to its session with <code>devctl attach</code>. <a :href="withBase('/overview')">See how sessions work <span aria-hidden="true"><ArrowUpRight :size="12" weight="regular" /></span></a></p></details>
      <details><summary>Does my agent get access automatically?</summary><p>No. MCP is off by default. When enabled, it listens on the local loopback interface. You choose when to connect your agent and can disable individual tools. <a :href="withBase('/mcp')">Read the MCP guide <span aria-hidden="true"><ArrowUpRight :size="12" weight="regular" /></span></a></p></details>
      <details><summary>Can I try it without a global install?</summary><p>Yes. Run <code>npx @amr-m-abdelgawad/devctl@latest</code> from your repo. Node.js is required; the npm package includes its own Bun runtime. <a :href="withBase('/quickstart')">Follow the quick start <span aria-hidden="true"><ArrowUpRight :size="12" weight="regular" /></span></a></p></details>
    </div>
  </section>

  <section class="closing"><p class="eyebrow">LESS FRICTION. MORE FORWARD.</p><h2>Get your stack together.</h2><a class="primary-link" :href="withBase('/quickstart')">Start your first session <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a><p>Free and open source · MIT licensed</p></section>
  <footer class="landing-footer" aria-label="Project links"><div class="footer-about"><strong>devctl<span>_</span></strong><p>Your local stack.<br>A shared view.</p><a href="https://github.com/amr-m-abdelgawad/devctl">Build with us on GitHub ↗</a></div><nav aria-label="Product documentation"><h3>Product</h3><a :href="withBase('/quickstart')">Quick start</a><a :href="withBase('/configuration')">Configuration</a><a :href="withBase('/tui')">Terminal interface</a><a :href="withBase('/mcp')">Agent integration</a></nav><nav aria-label="Project community"><h3>Get involved</h3><a href="https://github.com/amr-m-abdelgawad/devctl/issues/new">Report an issue</a><a href="https://github.com/amr-m-abdelgawad/devctl/issues">Discuss a feature</a><a href="https://github.com/amr-m-abdelgawad/devctl/blob/main/CONTRIBUTING.md">Contribute</a></nav><nav aria-label="Project information"><h3>Project</h3><a :href="withBase('/changelog')">Changelog</a><a :href="withBase('/installation')">Platforms &amp; installation</a><a href="https://github.com/amr-m-abdelgawad/devctl/blob/main/SECURITY.md">Report a vulnerability</a><a href="https://github.com/amr-m-abdelgawad/devctl/blob/main/LICENSE">MIT license</a></nav></footer>

</div>

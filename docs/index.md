---
layout: home
---

<script setup>
import { ref } from 'vue'
import { withBase } from 'vitepress'
import TerminalHero from './.vitepress/theme/TerminalHero.vue'
const copyLabel = ref('Copy command')
const activeProfile = ref('backend')
const profileExamples = {
  backend: { label: 'Build an API', description: 'Focus on the backend. Bring up identity, the API, and its worker as a single group.', services: ['identity', 'invoices-api', 'invoices-worker'] },
  full: { label: 'Work end to end', description: 'Bring the console into the picture when your work crosses the frontend and backend.', services: ['identity', 'invoices-api', 'invoices-worker', 'billing-console'] },
  data: { label: 'Start with data', description: 'Run the demo’s optional PostgreSQL container when you need a local database.', services: ['postgres'] }
}
async function copyInstall() {
  try {
    await navigator.clipboard.writeText('npx @amr-m-abdelgawad/devctl@latest')
    copyLabel.value = 'Copied!'
  } catch {
    copyLabel.value = 'Select the command to copy'
  }
}
</script>

<div class="landing vp-raw">
  <section class="landing-hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <p class="eyebrow"><span class="status-dot"></span> YOUR LOCAL DEVELOPMENT, IN SYNC</p>
      <h1 id="hero-title">More building.<br>Less <span>tab juggling.</span></h1>
      <p class="hero-description">Your services, logs, and local stack. Together in one terminal. Keep everything in view with devctl — from the first process to the last request.</p>
      <div class="hero-actions">
        <a class="primary-link" :href="withBase('/quickstart')">Get started <span aria-hidden="true">↗</span></a>
        <a class="text-link" href="https://github.com/amr-m-abdelgawad/devctl">Explore on GitHub <span aria-hidden="true">↗</span></a>
      </div>
      <p class="hero-footnote">Open source. Local first. Your workflow.</p>
    </div>
    <div class="hero-preview">
      <div class="preview-caption"><span>ONE TERMINAL. THE WHOLE PICTURE.</span><span aria-hidden="true">↙</span></div>
      <TerminalHero />
      <div class="preview-footer"><span class="status-dot"></span> An illustrative devctl session <span class="preview-shortcut">⌘ / ctrl + p <span>command palette</span></span></div>
    </div>
  </section>

  <div class="landing-signal"><span>Less switching. <b>More context.</b></span><span>TUI <i>/</i> CLI <i>/</i> MCP</span><span>One shared session <span aria-hidden="true">↗</span></span></div>

  <section class="landing-section" aria-labelledby="surfaces-title">
    <div class="section-heading"><div><p class="eyebrow">01 / WORK YOUR WAY</p><h2 id="surfaces-title">One stack. Your kind of control.</h2></div><p>Stay hands-on, script the routine,<br>or let your agent take the next step.</p></div>
    <div class="surface-grid">
      <a class="surface" :href="withBase('/tui')"><span class="surface-symbol" aria-hidden="true">▤</span><span class="surface-label">FOR YOUR FLOW</span><h3>A home for your stack.</h3><p>Start services, follow logs, and check health in a keyboard-first terminal interface.</p><span class="surface-link">Explore the TUI <span aria-hidden="true">↗</span></span></a>
      <a class="surface" :href="withBase('/cli')"><span class="surface-symbol" aria-hidden="true">&gt;_</span><span class="surface-label">FOR THE REPEATABLE</span><h3>Make it a command.</h3><p>Bring the same controls to scripts and CI. Run tasks, inspect config, and keep moving.</p><span class="surface-link">Meet the CLI <span aria-hidden="true">↗</span></span></a>
      <a class="surface" :href="withBase('/mcp')"><span class="surface-symbol" aria-hidden="true">✳</span><span class="surface-label">FOR YOUR AGENT</span><h3>Give AI the context.</h3><p>Connect your agent over MCP to inspect and operate the same local session. Enabled when you choose.</p><span class="surface-link">Connect with MCP <span aria-hidden="true">↗</span></span></a>
    </div>
  </section>

  <section class="workflow-section landing-section" aria-labelledby="workflow-title">
    <div class="section-heading"><div><p class="eyebrow">02 / FIND YOUR FOCUS</p><h2 id="workflow-title">The right services.<br>For the task at hand.</h2></div><p>Group services into named profiles.<br>Start the part of your stack you need.</p></div>
    <div class="workflow-panel">
      <div class="workflow-options" role="group" aria-label="Explore example profiles">
        <button v-for="(profile, name) in profileExamples" :key="name" type="button" :aria-pressed="activeProfile === name" @click="activeProfile = name"><span>{{ profile.label }}</span><code>{{ name }}</code><span aria-hidden="true">↗</span></button>
        <a class="text-link" :href="withBase('/profiles')">Explore profiles <span aria-hidden="true">↗</span></a>
      </div>
      <div class="workflow-example" aria-live="polite" aria-atomic="true">
        <p class="eyebrow">DEMO PLATFORM / EXAMPLE PROFILE</p>
        <p class="workflow-command"><span aria-hidden="true">$ </span><code>devctl start --profile {{ activeProfile }}</code></p>
        <p class="workflow-description">{{ profileExamples[activeProfile].description }}</p>
        <div class="workflow-services"><span v-for="service in profileExamples[activeProfile].services" :key="service"><i aria-hidden="true"></i>{{ service }}</span></div>
        <p class="workflow-note">Your repo, your names. Profiles are defined in your config.</p>
      </div>
    </div>
  </section>

  <section class="setup-section landing-section" aria-labelledby="setup-title">
    <div class="setup-copy"><p class="eyebrow">03 / FROM REPO TO RUNNING</p><h2 id="setup-title">Small setup.<br>Clear head.</h2><p>Start with Node.js. The npm package includes its own Bun runtime. Google Cloud is optional.</p><a class="text-link" :href="withBase('/installation')">Installation guide <span aria-hidden="true">↗</span></a></div>
    <div class="setup-panel">
      <div class="install-heading"><span>TRY IT IN YOUR TERMINAL</span><button type="button" @click="copyInstall" aria-live="polite">{{ copyLabel }}</button></div>
      <div class="install-command"><span aria-hidden="true">$</span><code>npx @amr-m-abdelgawad/devctl@latest</code></div>
      <ol class="setup-steps"><li><span>01</span><div><code>devctl setup</code><p>Describe your services in a single config.</p></div></li><li><span>02</span><div><code>devctl doctor</code><p>See what’s missing before you start.</p></div></li><li><span>03</span><div><code>devctl</code><p>Open your dashboard. Press enter to start a profile.</p></div></li></ol>
    </div>
  </section>

  <section class="details-section landing-section" aria-labelledby="details-title"><div><p class="eyebrow">04 / THOUGHTFUL BY DEFAULT</p><h2 id="details-title">Your machine.<br>Your ground rules.</h2><p>One supervisor keeps processes, containers, the proxy, and logs in sync across every control surface.</p><a class="text-link" :href="withBase('/overview')">See how it fits together <span aria-hidden="true">↗</span></a></div><div class="detail-list"><a :href="withBase('/configuration')"><span>01</span><div><h3>Configuration, not custom code.</h3><p>Define services, profiles, health gates, and hooks in YAML.</p></div><span aria-hidden="true">↗</span></a><a :href="withBase('/proxy')"><span>02</span><div><h3>Authentication, handled locally.</h3><p>An auth-aware proxy injects Google / IAP tokens. Tokens stay out of logs.</p></div><span aria-hidden="true">↗</span></a><a :href="withBase('/doctor')"><span>03</span><div><h3>Diagnostics without surprises.</h3><p>Doctor reports missing tools and setup issues. It never auto-enables anything.</p></div><span aria-hidden="true">↗</span></a></div></section>

  <section class="demo-section landing-section" aria-labelledby="demo-title">
    <div class="demo-band"><div><p class="eyebrow">05 / TAKE A LOOK AROUND</p><h2 id="demo-title">Meet your practice stack.</h2><p>A console, an API, identity, and a worker. Explore the included demo platform before configuring your own repo.</p></div><a class="primary-link" href="https://github.com/amr-m-abdelgawad/devctl/tree/main/examples/demo-platform">Explore the demo <span aria-hidden="true">↗</span></a></div>
  </section>

  <section class="faq-section landing-section" aria-labelledby="faq-title">
    <div><p class="eyebrow">06 / A FEW GOOD QUESTIONS</p><h2 id="faq-title">Before you<br>press enter.</h2><p>A little context for your first session.</p></div>
    <div class="faq-list">
      <details><summary>Do I need Docker or Google Cloud?</summary><p>Neither is required for local host processes. Use Docker or Podman when your configuration includes containers. Google Cloud tools are optional and only needed for the Google authentication features you choose to use. <a :href="withBase('/installation')">See installation requirements ↗</a></p></details>
      <details><summary>Do I have to change my application code?</summary><p>Describe how your services run in <code>.devctl/config.yaml</code>: their commands, working directories, environment, and health checks. devctl works with that configuration. <a :href="withBase('/configuration')">Explore configuration ↗</a></p></details>
      <details><summary>Can I use the CLI and TUI together?</summary><p>Yes. The TUI, CLI, and MCP connect to the same per-repo supervisor. Start a profile from the CLI and attach to its session with <code>devctl attach</code>. <a :href="withBase('/overview')">See how sessions work ↗</a></p></details>
      <details><summary>Does my agent get access automatically?</summary><p>No. MCP is off by default. When enabled, it listens on the local loopback interface. You choose when to connect your agent and can disable individual tools. <a :href="withBase('/mcp')">Read the MCP guide ↗</a></p></details>
      <details><summary>Can I try it without a global install?</summary><p>Yes. Run <code>npx @amr-m-abdelgawad/devctl@latest</code> from your repo. Node.js is required; the npm package includes its own Bun runtime. <a :href="withBase('/quickstart')">Follow the quick start ↗</a></p></details>
    </div>
  </section>

  <section class="closing"><p class="eyebrow">LESS FRICTION. MORE FORWARD.</p><h2>Get your stack together.</h2><a class="primary-link" :href="withBase('/quickstart')">Start your first session <span aria-hidden="true">↗</span></a><p>Free and open source · MIT licensed</p></section>
</div>

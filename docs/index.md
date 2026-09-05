---
layout: home

hero:
  name: devctl
  text: One terminal for your local stack
  tagline: Start services, watch logs, check identity, and drive the proxy — from a keyboard-first TUI, the CLI, or an agent over MCP.
  actions:
    - theme: brand
      text: Get started
      link: /quickstart
    - theme: alt
      text: Install
      link: /installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/amr-m-abdelgawad/devctl

features:
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>'
    title: Keyboard-first TUI
    details: Dashboard, services, logs, identity, credentials, proxy, doctor, and settings — one session, no tab-juggling.
    link: /tui
    linkText: Explore the TUI
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>'
    title: Scriptable CLI
    details: Start/stop, tasks, service-context exec, logs, Doctor, and config provenance for scripts and CI.
    link: /cli
    linkText: CLI reference
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'
    title: MCP for agents
    details: A localhost URL so Claude, Cursor, Codex, or Kilo can operate the stack. Off by default, 127.0.0.1 only.
    link: /mcp
    linkText: Wire up an agent
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/></svg>'
    title: Auth-aware proxy
    details: Loopback routes that inject Google / IAP tokens for you. Binds 127.0.0.1 only — tokens never touch logs.
    link: /proxy
    linkText: How the proxy works
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/></svg>'
    title: Doctor
    details: Ports, containers, tools, ADC, impersonation — reported clearly, never auto-enabled behind your back.
    link: /doctor
    linkText: Run diagnostics
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m2.305 15.53.923-.382"/><path d="m3.228 12.852-.924-.383"/><path d="M4.677 21.5a2 2 0 0 0 1.313.5H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v2.5"/><path d="m4.852 11.228-.383-.923"/><path d="m4.852 16.772-.383.924"/><path d="m7.148 11.228.383-.923"/><path d="m7.53 17.696-.382-.924"/><path d="m8.772 12.852.923-.383"/><path d="m8.772 15.148.923.383"/><circle cx="6" cy="14" r="3"/></svg>'
    title: Config, not code
    details: Nothing knows your services by name. Add YAML to .devctl/ — profiles, health gates, hooks, and plugins.
    link: /configuration
    linkText: Configuration model
---

<div class="landing">

<div class="landing__signal" role="note">
  <span><i></i> LOCAL-FIRST</span>
  <span>127.0.0.1 by default</span>
  <span>no cloud required</span>
  <span>one shared session</span>
</div>

<section class="landing__section landing__section--install">
  <div class="landing__section-copy">
    <div class="landing__eyebrow">Install</div>
    <h2 class="landing__title">Bring order to a crowded local stack.</h2>
    <p class="landing__lede">Node.js is the only prerequisite. The npm package brings its own official Bun runtime; <code>gcloud</code> is optional, even for the demo.</p>
  </div>

  <div class="landing__install-panel">
    <div class="landing__panel-topline"><span>TERMINAL</span><span>READY</span></div>

::: code-group

```bash [npx]
npx @amr-m-abdelgawad/devctl@latest
```

```bash [npm (global)]
npm install --global @amr-m-abdelgawad/devctl
devctl version
```

```bash [try the demo]
git clone https://github.com/amr-m-abdelgawad/devctl.git
cd devctl/examples/demo-platform
npx @amr-m-abdelgawad/devctl@latest
```

:::
</div>
</section>

<section class="landing__section landing__section--architecture">
  <div class="landing__eyebrow">Control plane</div>
  <div class="landing__split-heading">
    <h2 class="landing__title">One session.<br>Every control surface.</h2>
    <p class="landing__lede">The <b>supervisor</b> owns processes, optional Docker/Podman containers, the proxy, and the log buffer. TUI, CLI, and agents attach to the same source of truth.</p>
  </div>

<div class="pipe">
  <div class="pipe__col pipe__col--input">
    <div class="pipe__label">CONTROL</div>
    <div class="pipe__box"><b>TUI</b></div>
    <div class="pipe__box"><b>CLI</b></div>
    <div class="pipe__box"><b>MCP</b> · 127.0.0.1</div>
  </div>
  <div class="pipe__arrow">→</div>
  <div class="pipe__col pipe__col--core">
    <div class="pipe__label">SESSION</div>
    <div class="pipe__box pipe__box--core">Supervisor</div>
  </div>
  <div class="pipe__arrow">→</div>
  <div class="pipe__col pipe__col--output">
    <div class="pipe__label">RUNTIME</div>
    <div class="pipe__box">Host processes + containers</div>
    <div class="pipe__box">Proxy</div>
    <div class="pipe__box">Logs</div>
  </div>
</div>
<p class="pipe__note">Default MCP is off. See <a href="/devctl/overview">how it fits together</a>.</p>
</section>

<section class="landing__section landing__section--start">
<div class="landing__eyebrow">Quick start</div>
<div class="landing__split-heading">
  <h2 class="landing__title">Your repo,<br>under control.</h2>
  <p class="landing__lede">The shortest route from a repo full of services to a visible, repeatable development session.</p>
</div>

<div class="steps">
  <div class="step">
    <div class="step__n">01</div>
    <div class="step__cmd">devctl setup</div>
    <p>Writes <code>.devctl/config.yaml</code> — or use the TUI setup screen.</p>
  </div>
  <div class="step">
    <div class="step__n">02</div>
    <div class="step__cmd">devctl doctor</div>
    <p>Names what is missing: ports, tools, ADC, container runtimes.</p>
  </div>
  <div class="step">
    <div class="step__n">03</div>
    <div class="step__cmd">devctl</div>
    <p>Empty dashboard? <code>enter</code> starts the first profile.</p>
  </div>
  <div class="step">
    <div class="step__n">04</div>
    <div class="step__cmd">devctl start --profile backend</div>
    <p>Keep working; the daemon outlives <code>start</code>. Reattach with <code>devctl attach</code>.</p>
  </div>
</div>
</section>

<section class="landing__section landing__section--safety">
<div class="landing__safety-copy">
  <div class="landing__eyebrow">Ground rules</div>
  <h2 class="landing__title">Local, observable,<br>safe by construction.</h2>
  <p class="landing__lede">Good defaults keep the local machine in charge and make the dangerous edges explicit.</p>
</div>

<ul class="rules">
  <li>No hard-coded services, ports, profiles, or service accounts</li>
  <li>User identity and service identity are never silently swapped</li>
  <li>Tokens stay out of the TUI, logs, and MCP output</li>
  <li>Proxy, token endpoint, and MCP bind <b>127.0.0.1</b> only</li>
  <li>Local services run with zero Google Cloud</li>
  <li>Doctor reports; it never auto-enables anything</li>
</ul>
</section>

<div class="landing__cta">
  <div>
    <p class="landing__cta-title">Ready to run your whole stack as one session?</p>
    <p class="landing__cta-copy">Point it at any repo — add YAML, not code.</p>
  </div>
  <code>npx @amr-m-abdelgawad/devctl@latest</code>
</div>

</div>

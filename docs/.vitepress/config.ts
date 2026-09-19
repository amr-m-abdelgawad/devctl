import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withMermaid } from 'vitepress-plugin-mermaid'

const here = dirname(fileURLToPath(import.meta.url))
const phosphorIcons = resolve(here, '../node_modules/@phosphor-icons/vue/dist/icons')
const repoRoot = resolve(here, '../..')

const repo = 'https://github.com/amr-m-abdelgawad/devctl'
const blob = `${repo}/blob/main`

// https://vitepress.dev/reference/site-config
const siteConfig = withMermaid({
  title: 'devctl',
  description:
    'One terminal for your local stack. Start services, watch logs, check identity, and drive the proxy — from a keyboard-first TUI, the CLI, or an agent over MCP.',

  // Project page: https://amr-m-abdelgawad.github.io/devctl/
  base: '/devctl/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,

  // Root README.md is the wiki index; the landing page (index.md) replaces it
  // here. internals/index.md is the contributor hub (`/internals/`).
  srcExclude: ['README.md'],

  // Docs share their source with the GitHub Wiki and use plenty of ../ links
  // that only resolve on GitHub. We rewrite those below; keep the build green.
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', href: '/devctl/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#087568' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'devctl — One terminal for your local stack' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Configuration-driven local dev orchestrator: services, logs, identity, and an auth-aware proxy from a keyboard-first TUI, CLI, or MCP.'
      }
    ],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap'
      }
    ]
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/logo.svg',
    siteTitle: 'devctl',

    nav: [
      { text: 'Quick start', link: '/quickstart' },
      { text: 'Docs', link: '/overview' },
      { text: 'Changelog', link: '/changelog' },
      {
        text: 'Guides',
        items: [
          { text: 'Onboarding', link: '/onboarding' },
          { text: 'Examples & recipes', link: '/examples' },
          { text: 'Web console', link: '/web' },
          { text: 'TUI', link: '/tui' },
          { text: 'CLI', link: '/cli' },
          { text: 'MCP', link: '/mcp' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Services', link: '/services' },
          { text: 'Custom HTTP APIs', link: '/http' },
          { text: 'Proxy', link: '/proxy' },
          { text: 'Telemetry', link: '/telemetry' },
          { text: 'LLM inspector', link: '/llm' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Internals', link: '/internals/' }
        ]
      },
      { text: 'GitHub', link: repo },
      {
        text: 'v0.16.0',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'npm package', link: 'https://www.npmjs.com/package/@amr-m-abdelgawad/devctl' },
          { text: 'Contributing', link: `${blob}/CONTRIBUTING.md` }
        ]
      }
    ],

    sidebar: [
      {
        text: 'Start here',
        collapsed: false,
        items: [
          { text: 'How it fits together', link: '/overview' },
          { text: 'Installation', link: '/installation' },
          { text: 'Quick start', link: '/quickstart' },
          { text: 'Onboard your repository', link: '/onboarding' },
          { text: 'Examples & recipes', link: '/examples' },
          { text: 'Developer setup', link: '/developer-setup' },
          { text: 'Demo platform', link: `${blob}/examples/demo-platform/README.md` },
          { text: 'Agent skills', link: `${blob}/skills/README.md` }
        ]
      },
      {
        text: 'Using it',
        collapsed: false,
        items: [
          { text: 'Web console', link: '/web' },
          { text: 'TUI', link: '/tui' },
          { text: 'CLI', link: '/cli' },
          { text: 'MCP', link: '/mcp' },
          { text: 'Logs', link: '/logs' },
          { text: 'LLM inspector', link: '/llm' },
          { text: 'Telemetry', link: '/telemetry' },
          { text: 'Doctor', link: '/doctor' },
          { text: 'Troubleshooting', link: '/troubleshooting' }
        ]
      },
      {
        text: 'Configuration',
        collapsed: false,
        items: [
          { text: 'Configuration', link: '/configuration' },
          { text: 'Services', link: '/services' },
          { text: 'Profiles', link: '/profiles' },
          { text: 'Environment', link: '/environment' },
          { text: 'Custom HTTP APIs', link: '/http' },
          { text: 'Plugins', link: '/plugins' }
        ]
      },
      {
        text: 'Identity & proxy',
        collapsed: false,
        items: [
          { text: 'Authentication', link: '/authentication' },
          { text: 'Impersonation', link: '/impersonation' },
          { text: 'IAP', link: '/iap' },
          { text: 'Proxy', link: '/proxy' },
          { text: 'Admin setup', link: '/admin-setup' },
          { text: 'Security', link: '/security' }
        ]
      },
      {
        text: 'Reference',
        collapsed: true,
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Building from source', link: '/typescript' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Platform bets', link: '/platform-bets' },
          { text: 'npm publishing', link: '/npm-publishing' },
          { text: 'Contributing', link: `${blob}/CONTRIBUTING.md` },
          { text: 'Security policy', link: `${blob}/SECURITY.md` },
          { text: 'License', link: `${blob}/LICENSE` }
        ]
      },
      {
        text: 'Contribute',
        collapsed: true,
        items: [
          { text: 'Internals guide', link: '/internals/' },
          { text: 'How to read the code', link: '/internals/reading-the-code' },
          { text: 'Repository map', link: '/internals/repo-map' },
          { text: 'Process model', link: '/internals/process-model' },
          { text: 'Layers', link: '/internals/layers' },
          { text: 'Bootstrap', link: '/internals/bootstrap' },
          { text: 'RPC', link: '/internals/rpc' },
          { text: 'Domain', link: '/internals/domain' },
          { text: 'Application', link: '/internals/application' },
          { text: 'Ports', link: '/internals/ports' },
          { text: 'Adapters', link: '/internals/adapters' },
          { text: 'Presentation', link: '/internals/presentation' },
          { text: 'Config pipeline', link: '/internals/config-pipeline' },
          { text: 'Runtime', link: '/internals/runtime' },
          { text: 'Identity and proxy', link: '/internals/identity-proxy' },
          { text: 'Logs, telemetry, LLM', link: '/internals/logs-telemetry' },
          { text: 'Events and errors', link: '/internals/events-errors' },
          { text: 'Testing and CI', link: '/internals/testing-ci' },
          { text: 'Packaging', link: '/internals/packaging' },
          { text: 'Adding a feature', link: '/internals/adding-features' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: repo },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@amr-m-abdelgawad/devctl' }
    ],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub'
    },

    search: {
      provider: 'local'
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: `Copyright © 2026 Amr MOUSA · <a href="${blob}/SECURITY.md">Security</a>`
    }
  },

  markdown: {
    // Docs use ../ links that only resolve on GitHub (LICENSE, CONTRIBUTING,
    // examples/, skills/). Rewrite them to GitHub blob URLs at build time so
    // the same markdown works both on the site and in the wiki.
    config(md) {
      const defaultRender =
        md.renderer.rules.link_open ||
        ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const hrefIndex = token.attrIndex('href')
        if (hrefIndex >= 0) {
          const href = token.attrs![hrefIndex][1]
          if (href.startsWith('../')) {
            token.attrs![hrefIndex][1] = `${blob}/${href.slice(3)}`
            token.attrSet('target', '_blank')
            token.attrSet('rel', 'noreferrer')
          }
        }
        return defaultRender(tokens, idx, options, env, self)
      }
    }
  },

  mermaid: {
    // theme is auto-synced with the site's light/dark mode by the plugin
  },

  vite: {
    resolve: {
      alias: {
        // Individual files so the landing does not pull the whole Phosphor barrel.
        '@phosphor-icon': phosphorIcons
      }
    },
    server: {
      fs: {
        allow: [repoRoot]
      }
    },
    // Mermaid pulls in CJS-only deps (fastdom, etc.). Rollup handles them in
    // `build`, but the dev server needs them force-bundled or the page errors
    // with "does not provide an export named 'default'".
    optimizeDeps: {
      include: ['mermaid', 'fastdom', 'dayjs', 'cytoscape', '@braintree/sanitize-url']
    }
  }
})

// Keep the plugin's Markdown and virtual-config support, but let the theme
// register Mermaid lazily so diagram engines do not load on the landing page.
for (const plugin of siteConfig.vite?.plugins ?? []) {
  if (plugin && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'vite-plugin-mermaid') {
    delete plugin.transform
  }
}

export default siteConfig

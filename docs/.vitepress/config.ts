import { withMermaid } from 'vitepress-plugin-mermaid'

const repo = 'https://github.com/amr-m-abdelgawad/devctl'
const blob = `${repo}/blob/main`

// https://vitepress.dev/reference/site-config
export default withMermaid({
  title: 'devctl',
  description:
    'One terminal for your local stack. Start services, watch logs, check identity, and drive the proxy — from a keyboard-first TUI, the CLI, or an agent over MCP.',

  // Project page: https://amr-m-abdelgawad.github.io/devctl/
  base: '/devctl/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,

  // README.md is the wiki index; the landing page (index.md) replaces it here.
  srcExclude: ['README.md'],

  // Docs share their source with the GitHub Wiki and use plenty of ../ links
  // that only resolve on GitHub. We rewrite those below; keep the build green.
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', href: '/devctl/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#0d9488' }],
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
        href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap'
      }
    ]
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/logo.svg',
    siteTitle: 'devctl',

    nav: [
      { text: 'Overview', link: '/overview' },
      { text: 'Quick start', link: '/quickstart' },
      {
        text: 'Guides',
        items: [
          { text: 'TUI', link: '/tui' },
          { text: 'CLI', link: '/cli' },
          { text: 'MCP', link: '/mcp' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Services', link: '/services' },
          { text: 'Proxy', link: '/proxy' }
        ]
      },
      { text: 'Architecture', link: '/devctl-architecture' },
      {
        text: 'v0.2.3',
        items: [
          { text: 'Changelog', link: `${blob}/CHANGELOG.md` },
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
          { text: 'Developer setup', link: '/developer-setup' },
          { text: 'Demo platform', link: `${blob}/examples/demo-platform/README.md` },
          { text: 'Agent skills', link: `${blob}/skills/README.md` }
        ]
      },
      {
        text: 'Using it',
        collapsed: false,
        items: [
          { text: 'TUI', link: '/tui' },
          { text: 'CLI', link: '/cli' },
          { text: 'MCP', link: '/mcp' },
          { text: 'Logs', link: '/logs' },
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
          { text: 'Building from source', link: '/typescript' },
          { text: 'npm publishing', link: '/npm-publishing' },
          { text: 'Architecture spec', link: '/devctl-architecture' },
          { text: 'Contributing', link: `${blob}/CONTRIBUTING.md` },
          { text: 'Security policy', link: `${blob}/SECURITY.md` },
          { text: 'License', link: `${blob}/LICENSE` }
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
    // Mermaid pulls in CJS-only deps (fastdom, etc.). Rollup handles them in
    // `build`, but the dev server needs them force-bundled or the page errors
    // with "does not provide an export named 'default'".
    optimizeDeps: {
      include: ['mermaid', 'fastdom', 'dayjs', 'cytoscape', '@braintree/sanitize-url']
    }
  }
})

export type ChangelogInline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'link'; label: string; href: string }

export type ChangelogSection = {
  kind: string
  items: string[]
}

export type ChangelogRelease = {
  version: string
  date: string | undefined
  href: string | undefined
  unreleased: boolean
  sections: ChangelogSection[]
}

export type ChangelogDocument = {
  releases: ChangelogRelease[]
}

const RELEASE_HEADING = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/
const SECTION_HEADING = /^###\s+(.+)\s*$/
const HASH_HEADING = /^#\s+(.+)\s*$/
const LIST_ITEM = /^-\s+(.*)$/
const LINK_DEFINITION = /^\[([^\]]+)\]:\s+(\S+)\s*$/
const INLINE_TOKEN = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*)/g
const DOCS_HREF = /^docs\/([^?#]+)(\?[^#]*)?(#.*)?$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const VERSION_INDEX_DIGITS = 2

function collectLinkDefinitions(lines: readonly string[]): Map<string, string> {
  const definitions = new Map<string, string>()
  for (const line of lines) {
    const match = LINK_DEFINITION.exec(line.trim())
    if (match) definitions.set(match[1], match[2])
  }
  return definitions
}

export function parseChangelog(source: string): ChangelogDocument {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  const definitions = collectLinkDefinitions(lines)
  const releases: ChangelogRelease[] = []
  let current: ChangelogRelease | undefined
  let section: ChangelogSection | undefined

  const flushSection = () => {
    if (current && section && section.items.length > 0) current.sections.push(section)
    section = undefined
  }

  const startRelease = (version: string, date: string | undefined) => {
    flushSection()
    current = {
      version,
      date,
      href: definitions.get(version),
      unreleased: version.toLowerCase() === 'unreleased',
      sections: []
    }
    releases.push(current)
  }

  const startSection = (kind: string) => {
    flushSection()
    section = { kind, items: [] }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const releaseMatch = RELEASE_HEADING.exec(line)
    const sectionMatch = SECTION_HEADING.exec(line)
    const hashMatch = HASH_HEADING.exec(line)
    const itemMatch = LIST_ITEM.exec(line)

    if (LINK_DEFINITION.test(line.trim())) {
      flushSection()
      current = undefined
    } else if (releaseMatch) {
      startRelease(releaseMatch[1], releaseMatch[2])
    } else if (current && sectionMatch) {
      startSection(sectionMatch[1])
    } else if (current && hashMatch && hashMatch[1] !== 'Changelog') {
      startSection(hashMatch[1])
    } else if (current && itemMatch) {
      if (!section) startSection('Notes')
      section?.items.push(itemMatch[1])
    }
  }

  flushSection()
  return { releases }
}

export function tokenizeInline(text: string): ChangelogInline[] {
  const parts: ChangelogInline[] = []
  let cursor = 0
  for (const match of text.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0
    if (index > cursor) parts.push({ type: 'text', value: text.slice(cursor, index) })
    if (match[2] !== undefined && match[3] !== undefined) {
      parts.push({ type: 'link', label: match[2], href: match[3] })
    } else if (match[4] !== undefined) {
      parts.push({ type: 'code', value: match[4] })
    } else if (match[5] !== undefined) {
      parts.push({ type: 'strong', value: match[5] })
    }
    cursor = index + match[0].length
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) })
  return parts.length > 0 ? parts : [{ type: 'text', value: text }]
}

export function rewriteChangelogHref(href: string): { href: string; internal: boolean } {
  const match = DOCS_HREF.exec(href)
  if (!match) return { href, internal: false }
  const page = match[1].replace(/\.md$/, '')
  return { href: `/${page}${match[2] ?? ''}${match[3] ?? ''}`, internal: true }
}

export function formatReleaseDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  const monthName = MONTHS[(month ?? 1) - 1]
  if (!monthName || !year || !day) return iso
  return `${day} ${monthName} ${year}`
}

export function releaseAnchor(version: string): string {
  return version.toLowerCase() === 'unreleased' ? 'unreleased' : `v${version}`
}

export function padReleaseIndex(index: number): string {
  return String(index + 1).padStart(VERSION_INDEX_DIGITS, '0')
}

export function releaseLinkLabel(href: string): string {
  return href.includes('/compare/') ? 'See the diff' : 'See the release'
}

const INLINE_MARKUP = /\[([^\]]+)\]\([^)]+\)|`([^`]+)`|\*\*([^*]+)\*\*/g
const TEASER_MAX_CHARS = 160

export function stripInlineMarkdown(text: string): string {
  return text
    .replace(INLINE_MARKUP, (_match, link: string | undefined, code: string | undefined, strong: string | undefined) => link ?? code ?? strong ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function changelogTeaser(release: ChangelogRelease | undefined): string {
  const first = release?.sections[0]?.items[0]
  if (!first) return ''
  const plain = stripInlineMarkdown(first)
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain
  if (sentence.length <= TEASER_MAX_CHARS) return sentence
  const slice = sentence.slice(0, TEASER_MAX_CHARS)
  const lastSpace = slice.lastIndexOf(' ')
  const clipped = lastSpace > 0 ? slice.slice(0, lastSpace) : slice
  return `${clipped.replace(/[.,;:]+$/, '')}…`
}

export function kindsIn(releases: readonly ChangelogRelease[]): string[] {
  const kinds: string[] = []
  for (const release of releases) {
    for (const section of release.sections) {
      if (!kinds.includes(section.kind)) kinds.push(section.kind)
    }
  }
  return kinds
}

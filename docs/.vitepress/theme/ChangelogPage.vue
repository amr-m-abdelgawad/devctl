<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import type { Component } from 'vue'
import changelogSource from '../../../CHANGELOG.md?raw'
import ChangelogInline from './ChangelogInline.vue'
import {
  formatReleaseDate,
  kindsIn,
  padReleaseIndex,
  parseChangelog,
  releaseAnchor,
  releaseLinkLabel,
  type ChangelogRelease
} from './changelog'
import {
  ArrowUpRight,
  ArrowsClockwise,
  Circle,
  Lightning,
  Minus,
  PlusCircle,
  ShieldWarning,
  Warning,
  Wrench
} from './phosphor'

const SOURCE_URL = 'https://github.com/amr-m-abdelgawad/devctl/blob/main/CHANGELOG.md'
const KEEP_A_CHANGELOG = 'https://keepachangelog.com/en/1.1.0/'
const SEMVER = 'https://semver.org/spec/v2.0.0.html'

const KIND_ICONS: Record<string, Component> = {
  Added: PlusCircle,
  Changed: ArrowsClockwise,
  Fixed: Wrench,
  Removed: Minus,
  Deprecated: Warning,
  Security: ShieldWarning,
  'Hot Fix': Lightning
}

const changelog = parseChangelog(changelogSource)
const activeKind = ref('all')
const landingRoot = ref<HTMLElement | null>(null)
let revealObserver: IntersectionObserver | undefined
let motionPreference: MediaQueryList | undefined

const kinds = kindsIn(changelog.releases)
const publishedCount = changelog.releases.filter(release => !release.unreleased).length
const latest = changelog.releases.find(release => !release.unreleased)
const latestHref = latest ? `#${releaseAnchor(latest.version)}` : '#unreleased'

const visibleReleases = computed(() => {
  if (activeKind.value === 'all') return changelog.releases
  return changelog.releases.flatMap(release => {
    const sections = release.sections.filter(section => section.kind === activeKind.value)
    return sections.length > 0 ? [{ ...release, sections }] : []
  })
})

function iconFor(kind: string): Component {
  return KIND_ICONS[kind] ?? Circle
}

function releaseNumber(version: string): string {
  return padReleaseIndex(changelog.releases.findIndex(release => release.version === version))
}

function eyebrowFor(release: ChangelogRelease): string {
  if (release.unreleased) return 'NOW / UNRELEASED'
  return `${releaseNumber(release.version)} / ${release.version}`
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

async function jumpTo(event: MouseEvent, version: string) {
  event.preventDefault()
  activeKind.value = 'all'
  const id = releaseAnchor(version)
  history.replaceState(null, '', `#${id}`)
  await nextTick()
  document.getElementById(id)?.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'start'
  })
}

function revealAll() {
  revealObserver?.disconnect()
  landingRoot.value?.querySelectorAll('[data-reveal]').forEach(element => element.removeAttribute('data-reveal'))
}

function updateMotionPreference() {
  if (motionPreference?.matches) revealAll()
}

onMounted(() => {
  motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
  motionPreference.addEventListener('change', updateMotionPreference)
  if (motionPreference.matches || !('IntersectionObserver' in window)) return
  revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.setAttribute('data-reveal', 'visible')
        revealObserver?.unobserve(entry.target)
      }
    }
  }, { threshold: 0.06 })
  landingRoot.value?.querySelectorAll('.section-heading, .closing').forEach(element => {
    if (element.getBoundingClientRect().top < window.innerHeight) return
    element.setAttribute('data-reveal', 'pending')
    revealObserver?.observe(element)
  })
})

onUnmounted(() => {
  revealObserver?.disconnect()
  motionPreference?.removeEventListener('change', updateMotionPreference)
})
</script>

<template>
  <div ref="landingRoot" class="landing changelog vp-raw">
    <section class="landing-hero" aria-labelledby="changelog-title">
      <div class="hero-copy">
        <p class="eyebrow"><span class="status-dot"></span> THE RECORD</p>
        <h1 id="changelog-title">What changed.<br>When it <span>shipped.</span></h1>
        <p class="hero-description">Every notable change, newest first. Same source as the GitHub changelog — Keep a Changelog, Semantic Versioning.</p>
        <div class="hero-actions">
          <a class="primary-link" :href="latestHref" @click="latest && jumpTo($event, latest.version)">Latest release <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
          <a class="text-link" :href="SOURCE_URL" rel="noreferrer" target="_blank">Source on GitHub <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
        </div>
        <p class="hero-footnote">Sourced from CHANGELOG.md on main.</p>
      </div>
    </section>

    <div class="landing-signal">
      <span>Newest first. <b>{{ publishedCount }} versions.</b></span>
      <span>Keep a Changelog <i>/</i> SemVer</span>
      <span v-if="latest">{{ latest.version }} <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></span>
    </div>

    <nav class="changelog-jump" aria-label="Jump to a version">
      <a
        v-for="release in changelog.releases"
        :key="release.version"
        :href="`#${releaseAnchor(release.version)}`"
        :class="{ 'is-now': release.unreleased }"
        @click="jumpTo($event, release.version)"
      >{{ release.unreleased ? 'Now' : release.version }}</a>
    </nav>

    <section class="landing-section" aria-labelledby="releases-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">01 / RELEASES</p>
          <h2 id="releases-title">Newest first.</h2>
        </div>
        <div class="changelog-filters" role="group" aria-label="Filter by kind">
          <button type="button" :aria-pressed="activeKind === 'all'" @click="activeKind = 'all'">All notes</button>
          <button
            v-for="kind in kinds"
            :key="kind"
            type="button"
            :aria-pressed="activeKind === kind"
            @click="activeKind = kind"
          >{{ kind }}</button>
        </div>
      </div>

      <p v-if="visibleReleases.length === 0" class="changelog-empty">No notes of that kind.</p>

      <article
        v-for="release in visibleReleases"
        :id="releaseAnchor(release.version)"
        :key="release.version"
        class="details-section changelog-release"
        :data-unreleased="release.unreleased ? '' : undefined"
        :aria-labelledby="`${releaseAnchor(release.version)}-title`"
      >
        <div>
          <p class="eyebrow">{{ eyebrowFor(release) }}</p>
          <h2 :id="`${releaseAnchor(release.version)}-title`">{{ release.unreleased ? 'On the way' : release.version }}</h2>
          <p v-if="release.date">{{ formatReleaseDate(release.date) }}</p>
          <p v-else>Queued on main.</p>
          <a
            v-if="release.href"
            class="text-link"
            :href="release.href"
            rel="noreferrer"
            target="_blank"
          >{{ releaseLinkLabel(release.href) }} <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
        </div>
        <div class="changelog-body">
          <p v-if="release.sections.length === 0" class="changelog-empty">Nothing queued yet.</p>
          <div v-for="(section, sectionIndex) in release.sections" :key="sectionIndex" class="changelog-section">
            <h3 class="changelog-kind">
              <component :is="iconFor(section.kind)" :size="16" weight="light" aria-hidden="true" />
              {{ section.kind }}
            </h3>
            <ul class="changelog-items">
              <li v-for="(item, itemIndex) in section.items" :key="itemIndex">
                <ChangelogInline :text="item" />
              </li>
            </ul>
          </div>
        </div>
      </article>
    </section>

    <p class="changelog-spec">
      The format follows
      <a :href="KEEP_A_CHANGELOG" rel="noreferrer" target="_blank">Keep a Changelog</a>
      and
      <a :href="SEMVER" rel="noreferrer" target="_blank">Semantic Versioning</a>.
    </p>

    <section class="closing">
      <p class="eyebrow">LESS FRICTION. MORE FORWARD.</p>
      <h2>Get your stack together.</h2>
      <a class="primary-link" :href="withBase('/quickstart')">Start your first session <span aria-hidden="true"><ArrowUpRight :size="14" weight="regular" /></span></a>
      <p>Free and open source · MIT licensed</p>
    </section>
  </div>
</template>

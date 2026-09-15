<script setup lang="ts">
import { withBase } from 'vitepress'
import { rewriteChangelogHref, tokenizeInline } from './changelog'

defineProps<{ text: string }>()

function linkAttrs(href: string) {
  const rewritten = rewriteChangelogHref(href)
  if (rewritten.internal) {
    return { href: withBase(rewritten.href) }
  }
  return { href: rewritten.href, target: '_blank', rel: 'noreferrer' }
}
</script>

<template>
  <template v-for="(part, index) in tokenizeInline(text)" :key="index">
    <code v-if="part.type === 'code'">{{ part.value }}</code>
    <strong v-else-if="part.type === 'strong'">{{ part.value }}</strong>
    <a v-else-if="part.type === 'link'" v-bind="linkAttrs(part.href)">{{ part.label }}</a>
    <template v-else>{{ part.value }}</template>
  </template>
</template>

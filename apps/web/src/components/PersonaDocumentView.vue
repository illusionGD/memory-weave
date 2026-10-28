<template>
  <div class="persona-document">
    <section v-for="section in sections" :key="section.title" class="persona-document__section">
      <h3>{{ section.title }}</h3>
      <p class="persona-document__hint">{{ section.hint }}</p>
      <p v-if="!section.items.length" class="persona-document__hint">原稿未整理出此类内容。</p>
      <ul v-else class="persona-document__items">
        <li v-for="item in section.items" :key="`${item.text}:${item.evidence}`">
          <p>{{ item.text }}</p>
          <details>
            <summary>原稿依据</summary>
            <blockquote>{{ item.evidence }}</blockquote>
          </details>
        </li>
      </ul>
    </section>
    <section class="persona-document__section">
      <h3>长期保留的约束</h3>
      <p v-if="!document.locks.length" class="persona-document__hint">没有单独指定的长期约束。</p>
      <ul v-else class="persona-document__items">
        <li v-for="lock in document.locks" :key="lock.text">{{ lock.text }}</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { PersonaDocument } from '@memory-weave/contracts';
const props = defineProps<{ document: PersonaDocument }>();
const sections = computed(() => [
  {
    title: '身份与背景',
    hint: '作为长期起点保留，不会被自动成长改写。',
    items: props.document.core,
  },
  {
    title: '可成长的倾向',
    hint: '兴趣、表达和看待世界的方式，可以随着经历逐渐发展。',
    items: props.document.inclinations,
  },
  {
    title: '起初的知识与技能',
    hint: '尚不了解某件事，不代表不喜欢它。',
    items: props.document.knowledge,
  },
]);
</script>

<style scoped lang="scss">
.persona-document {
  display: grid;
  gap: var(--space-6);
  &__section {
    display: grid;
    gap: var(--space-2);
    overflow-wrap: anywhere;
  }
  &__hint {
    color: var(--color-ink-soft);
    font-size: 0.9rem;
    line-height: 1.7;
  }
  &__items {
    display: grid;
    gap: var(--space-3);
    padding-left: var(--space-5);
    line-height: 1.8;
  }
  details {
    font-size: 0.85rem;
    color: var(--color-ink-soft);
  }
  summary {
    cursor: pointer;
  }
  blockquote {
    border-left: 2px solid var(--color-border);
    padding-left: var(--space-3);
    white-space: pre-wrap;
  }
}
</style>

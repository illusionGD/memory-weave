<template>
  <NAvatar
    class="avatar"
    round
    :size="size"
    :src="source"
    object-fit="cover"
    :img-props="{ alt: '' }"
    role="img"
    :aria-label="`${name}的头像`"
    :style="{ '--avatar-moon-size': `${size * 0.68}px` }"
  >
    <template v-if="!source" #default>
      <svg class="avatar__moon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M30 9a15 15 0 1 0 9 23A16 16 0 0 1 30 9Z" fill="currentColor" opacity=".9" />
        <path d="m34 13 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z" fill="currentColor" opacity=".6" />
      </svg>
    </template>
    <template #fallback>
      <svg class="avatar__moon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <path d="M30 9a15 15 0 1 0 9 23A16 16 0 0 1 30 9Z" fill="currentColor" opacity=".9" />
        <path d="m34 13 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z" fill="currentColor" opacity=".6" />
      </svg>
    </template>
  </NAvatar>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { NAvatar } from 'naive-ui';
import type { CompanionAvatar } from '@memory-weave/contracts';
const props = withDefaults(
  defineProps<{
    avatar?: CompanionAvatar | null;
    name: string;
    size?: number;
    preview?: string | null;
  }>(),
  { avatar: null, size: 48, preview: null },
);
const source = computed(() => props.preview ?? props.avatar?.url);
</script>
<style scoped lang="scss">
.avatar {
  flex: none;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  vertical-align: middle;
}
.avatar__moon {
  width: var(--avatar-moon-size);
  height: var(--avatar-moon-size);
  vertical-align: middle;
}
</style>

<template>
  <span
    class="avatar"
    :style="{ '--avatar-size': `${size}px` }"
    role="img"
    :aria-label="`${name}的头像`"
  >
    <img v-if="source && !failed" :src="source" alt="" @error="failed = true" />
    <svg v-else viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M30 9a15 15 0 1 0 9 23A16 16 0 0 1 30 9Z" fill="currentColor" opacity=".9" />
      <path d="m34 13 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z" fill="currentColor" opacity=".6" />
    </svg>
  </span>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
const failed = ref(false);
watch(source, () => {
  failed.value = false;
});
</script>
<style scoped lang="scss">
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--avatar-size);
  height: var(--avatar-size);
  border-radius: 50%;
  overflow: hidden;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  vertical-align: middle;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.avatar svg {
  width: 68%;
  height: 68%;
}
</style>

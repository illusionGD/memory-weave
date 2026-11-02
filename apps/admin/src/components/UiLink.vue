<template>
  <RouterLink v-slot="{ href, navigate, isExactActive }" :to="to" :replace="replace" custom>
    <NButton
      v-bind="$attrs"
      tag="a"
      :href="disabled ? undefined : href"
      :disabled="disabled"
      :aria-current="isExactActive ? 'page' : undefined"
      @click="navigate"
      ><slot
    /></NButton>
  </RouterLink>
</template>

<script setup lang="ts">
import { NButton } from 'naive-ui';
import { RouterLink } from 'vue-router';
import type { RouteLocationRaw } from 'vue-router';

defineOptions({ inheritAttrs: false });
withDefaults(
  defineProps<{
    /** 应用内部的路由目标。 */
    to: RouteLocationRaw;
    /** 是否替换当前浏览历史。 */
    replace?: boolean;
    /** 是否阻止当前导航操作。 */
    disabled?: boolean;
  }>(),
  { replace: false, disabled: false },
);
</script>

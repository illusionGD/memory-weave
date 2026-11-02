<template>
  <NConfigProvider :theme-overrides="naiveTheme" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider
      ><NDialogProvider><RouterView /></NDialogProvider
    ></NMessageProvider>
  </NConfigProvider>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router';
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN } from 'naive-ui';
import { naiveTheme } from '@/assets/styles/naive-theme';
</script>

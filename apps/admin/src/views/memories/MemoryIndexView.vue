<template>
  <AdminLayout>
    <section class="persona-page">
      <header class="persona-page__intro">
        <h1 class="persona-page__title">记忆记录</h1>
        <p class="persona-page__muted">选择一位伴侣，浏览当前人生阶段的记忆、时间线与来源关系。</p>
      </header>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <div class="persona-page__toolbar">
        <button class="button button--secondary" :disabled="loading" @click="refresh()">
          刷新列表</button
        ><span v-if="loading" role="status">正在读取…</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">伴侣</th>
              <th scope="col">人生阶段</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="companion in companions" :key="companion.id">
              <td>{{ companion.name }}</td>
              <td>{{ companion.runtimeEpoch }}</td>
              <td>
                <RouterLink
                  :to="{
                    name: 'memory-explorer',
                    params: { id: companion.id },
                    query: { runtimeEpoch: companion.runtimeEpoch },
                  }"
                  >浏览记忆</RouterLink
                >
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loading && !companions.length" class="admin-empty">
          暂无伴侣。创建伴侣并开始交流后，可以在这里查看记忆。
        </p>
      </div>
      <div class="persona-page__toolbar">
        <button
          v-if="next"
          class="button button--secondary"
          :disabled="loading"
          @click="refresh(next)"
        >
          下一页伴侣</button
        ><button class="button button--quiet" :disabled="loading" @click="refresh()">
          回到第一页
        </button>
      </div>
    </section>
  </AdminLayout>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { CompanionListResponse } from '@memory-weave/contracts';
import { listCompanions } from '@memory-weave/browser-client/personas';
import AdminLayout from '@/components/AdminLayout.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
const { loading, error, run } = usePersonaPage();
const companions = ref<CompanionListResponse['items']>([]);
const next = ref<string | null>(null);
/** 选择器使用服务端分页，每页替换，避免下载全部实例。 */
async function refresh(afterId?: string): Promise<void> {
  const result = await run(() => listCompanions(afterId));
  companions.value = result?.items ?? [];
  next.value = result?.nextAfterId ?? null;
}
onMounted(() => refresh());
</script>

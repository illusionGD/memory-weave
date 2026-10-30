<template>
  <AdminLayout>
    <div class="persona-page">
      <section class="persona-page__intro">
        <p class="eyebrow">Lives taking shape</p>
        <h1 class="persona-page__title">伴侣管理</h1>
        <p class="persona-page__muted">管理伴侣实例，查看初始人生、人格版本与运行状态。</p>
      </section>
      <div class="persona-page__toolbar">
        <RouterLink class="button button--primary" to="/companions/new">创建伴侣</RouterLink>
        <RouterLink class="button button--secondary" to="/persona-templates"
          >管理人设模板</RouterLink
        >
        <button class="button button--quiet" :disabled="loading" @click="refresh">刷新列表</button>
      </div>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="loading" role="status">正在读取伴侣…</p>
      <section v-if="!loading && !items.length && !error" class="persona-page__panel">
        <h2>还没有伴侣</h2>
        <p class="persona-page__muted">不必先填写复杂表格，写下你希望认识的那个人就好。</p>
      </section>
      <div v-if="items.length" class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">伴侣</th>
              <th scope="col">初始设定</th>
              <th scope="col">人格状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="companion in items" :key="companion.id">
              <td>
                <CompanionAvatar :name="companion.name" :avatar="companion.avatar" :size="32" />
                <strong>{{ companion.name }}</strong
                ><small class="companion-table__id">{{ companion.id.slice(0, 8) }}</small>
              </td>
              <td class="companion-table__profile">
                {{ companion.initialSnapshot.profileText.slice(0, 80)
                }}{{ companion.initialSnapshot.profileText.length > 80 ? '…' : '' }}
              </td>
              <td>
                <span class="admin-tag">{{
                  companion.currentPersonaVersion.document ? '已建立' : '原稿已保存'
                }}</span>
              </td>
              <td>
                <RouterLink :to="`/companions/${companion.id}`"
                  >查看 {{ companion.name }}</RouterLink
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <button v-if="nextAfterId" class="button button--secondary" :disabled="loading" @click="more">
        加载更多伴侣
      </button>
    </div>
  </AdminLayout>
</template>

<script setup lang="ts">
import CompanionAvatar from '@/components/CompanionAvatar.vue';
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { CompanionDetail } from '@memory-weave/contracts';
import AdminLayout from '@/components/AdminLayout.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { listCompanions } from '@memory-weave/browser-client/personas';
const { loading, error, run } = usePersonaPage();
const items = ref<CompanionDetail[]>([]);
const nextAfterId = ref<string | null>(null);
onMounted(refresh);
/** 刷新从第一页开始，保留服务端稳定游标。 */
async function refresh(): Promise<void> {
  const result = await run(() => listCompanions());
  if (result) {
    items.value = result.items;
    nextAfterId.value = result.nextAfterId;
  }
}
/** 仅在用户请求时读取下一页。 */
async function more(): Promise<void> {
  if (!nextAfterId.value) return;
  const result = await run(() => listCompanions(nextAfterId.value!));
  if (result) {
    items.value.push(...result.items);
    nextAfterId.value = result.nextAfterId;
  }
}
</script>

<style scoped lang="scss">
.companion-table__id {
  display: block;
  color: var(--color-ink-soft);
  font-size: 11px;
  margin-top: 4px;
}
.companion-table__profile {
  max-width: 400px;
  min-width: 200px;
  color: var(--color-ink-soft);
}
</style>

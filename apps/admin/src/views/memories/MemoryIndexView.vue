<template>
  <AdminLayout>
    <section class="persona-page">
      <header class="persona-page__intro">
        <h1 class="persona-page__title">记忆记录</h1>
        <p class="persona-page__muted">按私聊查看所属伴侣的记忆、原文证据和整理批次。</p>
      </header>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <div class="persona-page__toolbar">
        <button class="button button--secondary" :disabled="loading" @click="refresh">
          刷新列表</button
        ><span v-if="loading" role="status">正在读取…</span>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th scope="col">私聊</th>
              <th scope="col">人生阶段</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="chat in chats" :key="chat.id">
              <td>
                {{ chat.title }}<small class="memory-index__id">{{ chat.id.slice(0, 8) }}</small>
              </td>
              <td>{{ chat.runtimeEpoch }}</td>
              <td>
                {{
                  chat.availability === 'active'
                    ? '有效'
                    : chat.availability === 'cleaning'
                      ? '清理中'
                      : '已归档'
                }}
              </td>
              <td>
                <RouterLink
                  v-if="chat.availability === 'active'"
                  :to="{
                    name: 'memories',
                    params: { id: chat.companionId, conversationId: chat.id },
                    query: { runtimeEpoch: chat.runtimeEpoch },
                  }"
                  >查看记忆</RouterLink
                ><span v-else class="persona-page__muted">暂不可整理</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loading && !chats.length" class="admin-empty">
          暂无私聊。开始聊天后，可以在这里查看记忆整理情况。
        </p>
      </div>
      <button v-if="next" class="button button--secondary" :disabled="loading" @click="more">
        下一页
      </button>
    </section>
  </AdminLayout>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { Chat } from '@memory-weave/contracts';
import { listChats } from '@memory-weave/browser-client/chats';
import AdminLayout from '@/components/AdminLayout.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
const { loading, error, run } = usePersonaPage();
const chats = ref<Chat[]>([]);
const next = ref<string | null>(null);
/** 刷新第一页，不把未读取的会话统计成全量。 */
async function refresh(): Promise<void> {
  const result = await run(() => listChats());
  if (result) {
    chats.value = result.items;
    next.value = result.nextAfterId;
  }
}
/** 使用服务端游标翻页，管理列表保持有界。 */
async function more(): Promise<void> {
  if (!next.value) return;
  const result = await run(() => listChats(next.value!));
  if (result) {
    chats.value = result.items;
    next.value = result.nextAfterId;
  }
}
onMounted(refresh);
</script>
<style scoped lang="scss">
.memory-index__id {
  display: block;
  color: var(--color-ink-soft);
  font-size: 11px;
  margin-top: 4px;
}
</style>

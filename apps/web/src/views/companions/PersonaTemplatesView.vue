<template>
  <CompanionLayout>
    <div class="persona-page">
      <section class="persona-page__intro">
        <p class="eyebrow">Beginnings worth keeping</p>
        <h1 class="persona-page__title">人设模板</h1>
        <p class="persona-page__muted">
          复用初始设定，每个伴侣仍有独立的人生。模板更新只影响以后选用新版的创建。
        </p>
      </section>
      <div class="persona-page__toolbar">
        <button class="button button--primary" :disabled="saving" @click="newTemplate">
          新建模板
        </button>
        <button class="button button--quiet" :disabled="saving || loading" @click="loadPage">
          刷新模板
        </button>
      </div>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="loading" role="status">正在读取模板…</p>
      <section v-if="formMode" class="persona-page__panel">
        <h2>{{ formMode === 'new' ? '新的人设模板' : '编辑模板，保留旧版' }}</h2>
        <PersonaInput
          :key="formKey"
          :initial="initialInput"
          template-mode
          :busy="saving"
          :submit-label="formMode === 'new' ? '保存模板' : '保存新版本'"
          @submit="save"
        />
        <button class="button button--quiet" :disabled="saving" @click="closeForm">取消编辑</button>
      </section>
      <section v-else-if="selected" class="persona-page__panel">
        <h2>{{ selected.name }} · 第 {{ selected.version }} 版</h2>
        <p class="persona-page__text">{{ selected.initialProfile }}</p>
        <ul v-if="selected.lockedFeatures.length" class="template-page__locks">
          <li v-for="lock in selected.lockedFeatures" :key="lock">{{ lock }}</li>
        </ul>
        <div class="persona-page__toolbar">
          <RouterLink
            class="button button--primary"
            :to="{
              name: 'companion-create',
              query: { template: selected.id, version: selected.version },
            }"
            >用此版本创建伴侣</RouterLink
          >
          <button
            v-if="selected.version === latestVersion"
            class="button button--secondary"
            :disabled="saving"
            @click="editTemplate"
          >
            编辑模板
          </button>
          <button v-else class="button button--secondary" :disabled="loading" @click="latest">
            返回最新版本
          </button>
        </div>
        <form class="persona-page__toolbar" @submit.prevent="loadVersion">
          <label for="template-version">模板历史版本</label>
          <input
            id="template-version"
            v-model.number="versionNumber"
            class="persona-page__input template-page__version"
            type="number"
            min="1"
            :max="latestVersion"
            required
          />
          <button class="button button--quiet" type="submit" :disabled="loading">
            读取模板版本
          </button>
        </form>
      </section>
      <p v-if="!items.length && !loading && !error" class="persona-page__muted">
        还没有模板。保存一段设定，以后可以从它创建不同伴侣。
      </p>
      <div class="persona-page__grid">
        <article v-for="template in items" :key="template.id" class="persona-page__card">
          <h2 class="persona-page__card-title">{{ template.name }}</h2>
          <p class="persona-page__muted">最新为第 {{ template.version }} 版</p>
          <button
            class="button button--secondary"
            :disabled="saving"
            @click="openTemplate(template.id)"
          >
            查看 {{ template.name }}
          </button>
        </article>
      </div>
      <button
        v-if="nextAfterId"
        class="button button--secondary"
        :disabled="loading || saving"
        @click="more"
      >
        加载更多模板
      </button>
    </div>
  </CompanionLayout>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { createPersonaTemplateSchema, updatePersonaTemplateSchema } from '@memory-weave/contracts';
import type { PersonaTemplate } from '@memory-weave/contracts';
import CompanionLayout from '@/components/CompanionLayout.vue';
import PersonaInput from '@/components/PersonaInput.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { useCommandIdentity } from '@/composables/useCommandIdentity';
import { listTemplates, getTemplate, createTemplate, updateTemplate } from '@/services/personas';
const route = useRoute();
const router = useRouter();
const { loading, saving, error, run } = usePersonaPage();
const identify = useCommandIdentity();
const items = ref<PersonaTemplate[]>([]);
const nextAfterId = ref<string | null>(null);
const selected = ref<PersonaTemplate | null>(null);
const latestVersion = ref(1);
const versionNumber = ref(1);
const formMode = ref<'new' | 'edit' | null>(null);
const formKey = computed(
  () => `${formMode.value}:${selected.value?.id}:${selected.value?.version}`,
);
const initialInput = computed(() =>
  formMode.value === 'edit' && selected.value
    ? {
        name: selected.value.name,
        profileText: selected.value.initialProfile,
        lockedFeatures: selected.value.lockedFeatures,
      }
    : undefined,
);
watch(() => route.fullPath, loadPage, { immediate: true });
/** URL 记录所选模板，刷新后仍可读取，不在浏览器持久缓存私人原稿。 */
async function loadPage(): Promise<void> {
  if (route.name !== 'persona-templates') return;
  const id = typeof route.query.id === 'string' ? route.query.id : null;
  const result = await run(async () => ({
    list: await listTemplates(),
    selected: id ? await getTemplate(id) : null,
  }));
  if (result) {
    items.value = result.list.items;
    nextAfterId.value = result.list.nextAfterId;
    selected.value = result.selected;
    latestVersion.value = result.selected?.version ?? 1;
    versionNumber.value = latestVersion.value;
    formMode.value = route.query.new === '1' ? 'new' : null;
  }
}
/** 进入新建表单。 */
async function newTemplate(): Promise<void> {
  if (route.query.new === '1') formMode.value = 'new';
  else await router.push({ name: 'persona-templates', query: { new: '1' } });
}
/** 查询指定模板最新版本。 */
async function openTemplate(id: string): Promise<void> {
  if (route.query.id === id) await loadPage();
  else await router.push({ name: 'persona-templates', query: { id } });
}
/** 在当前最新版本上编辑，保存时仍由后端检查乐观版本。 */
function editTemplate(): void {
  formMode.value = 'edit';
}
/** 仅关闭本地表单。 */
function closeForm(): void {
  formMode.value = null;
}
/** 模板保存不调用模型，也不向已有实例传播。 */
async function save(value: {
  name: string;
  profileText: string;
  lockedFeatures: string[];
}): Promise<void> {
  const base = {
    name: value.name,
    initialProfile: value.profileText,
    lockedFeatures: value.lockedFeatures,
  };
  if (formMode.value === 'edit' && selected.value) {
    const payload = { ...base, expectedVersion: selected.value.version };
    const parsed = updatePersonaTemplateSchema.safeParse({
      ...payload,
      requestId: identify({ id: selected.value.id, ...payload }),
    });
    if (!parsed.success) {
      error.value = '请检查模板内容。';
      return;
    }
    const result = await run(() => updateTemplate(selected.value!.id, parsed.data), true);
    if (result) {
      selected.value = result;
      latestVersion.value = result.version;
      versionNumber.value = result.version;
      items.value = items.value.map((item) => (item.id === result.id ? result : item));
      formMode.value = null;
    }
  } else {
    const parsed = createPersonaTemplateSchema.safeParse({ ...base, requestId: identify(base) });
    if (!parsed.success) {
      error.value = '请检查模板内容。';
      return;
    }
    const result = await run(() => createTemplate(parsed.data), true);
    if (result) {
      formMode.value = null;
      await openTemplate(result.id);
    }
  }
}
/** 历史内容只读；编辑必须重新选择最新版本。 */
async function loadVersion(): Promise<void> {
  if (!selected.value || !Number.isInteger(versionNumber.value) || versionNumber.value < 1) {
    error.value = '请输入有效版本号。';
    return;
  }
  const result = await run(() => getTemplate(selected.value!.id, versionNumber.value));
  if (result) selected.value = result;
}
/** 回到当前最新模板后再编辑。 */
async function latest(): Promise<void> {
  await loadPage();
}
/** 按需读取后续模板。 */
async function more(): Promise<void> {
  if (!nextAfterId.value) return;
  const result = await run(() => listTemplates(nextAfterId.value!));
  if (result) {
    items.value.push(...result.items);
    nextAfterId.value = result.nextAfterId;
  }
}
</script>

<style scoped lang="scss">
.template-page {
  &__locks {
    padding-left: var(--space-5);
    line-height: 1.8;
    overflow-wrap: anywhere;
  }
  &__version {
    width: 90px;
  }
}
</style>

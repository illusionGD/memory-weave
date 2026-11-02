<template>
  <AdminLayout>
    <div class="persona-page">
      <section class="persona-page__intro">
        <p class="eyebrow">Beginnings worth keeping</p>
        <h1 class="persona-page__title">人设模板</h1>
        <p class="persona-page__muted">
          复用初始设定，每个伴侣仍有独立的人生。模板更新只影响以后选用新版的创建。
        </p>
      </section>
      <div class="persona-page__toolbar">
        <NButton type="primary" :disabled="saving" @click="newTemplate"> 新建模板 </NButton>
        <NButton quaternary :disabled="saving || loading" @click="loadPage"> 刷新模板 </NButton>
      </div>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NSpin v-if="loading" size="small" role="status" description="正在读取模板…" />
      <NCard
        v-if="formMode"
        class="persona-page__panel"
        content-class="persona-page__panel-content"
      >
        <h2>{{ formMode === 'new' ? '新的人设模板' : '编辑模板，保留旧版' }}</h2>
        <PersonaInput
          :key="formKey"
          :initial="initialInput"
          template-mode
          :busy="saving"
          :submit-label="formMode === 'new' ? '保存模板' : '保存新版本'"
          @submit="save"
        />
        <NButton quaternary :disabled="saving" @click="closeForm">取消编辑</NButton>
      </NCard>
      <NCard
        v-else-if="selected"
        class="persona-page__panel"
        content-class="persona-page__panel-content"
      >
        <h2>{{ selected.name }} · 第 {{ selected.version }} 版</h2>
        <p class="persona-page__text">{{ selected.initialProfile }}</p>
        <ul v-if="selected.lockedFeatures.length" class="template-page__locks">
          <li v-for="lock in selected.lockedFeatures" :key="lock">{{ lock }}</li>
        </ul>
        <div class="persona-page__toolbar">
          <UiLink
            type="primary"
            :to="{
              name: 'companion-create',
              query: { template: selected.id, version: selected.version },
            }"
            >用此版本创建伴侣</UiLink
          >
          <NButton
            v-if="selected.version === latestVersion"
            secondary
            :disabled="saving"
            @click="editTemplate"
          >
            编辑模板
          </NButton>
          <NButton v-else secondary :disabled="loading" @click="latest"> 返回最新版本 </NButton>
        </div>
        <NForm
          class="persona-page__toolbar"
          inline
          :show-feedback="false"
          @submit.prevent="loadVersion"
        >
          <NFormItem label="模板历史版本" :label-props="{ for: 'template-version' }">
            <NInputNumber
              v-model:value="versionNumber"
              class="template-page__version"
              :input-props="{ id: 'template-version', required: true }"
              :min="1"
              :max="latestVersion"
              :precision="0"
            />
          </NFormItem>
          <NButton quaternary attr-type="submit" :disabled="loading"> 读取模板版本 </NButton>
        </NForm>
      </NCard>
      <NEmpty
        v-if="!items.length && !loading && !error"
        description="还没有模板。保存一段设定，以后可以从它创建不同伴侣。"
      />
      <div class="persona-page__grid">
        <NCard
          v-for="template in items"
          :key="template.id"
          class="persona-page__card"
          content-class="persona-page__card-content"
        >
          <h2 class="persona-page__card-title">{{ template.name }}</h2>
          <p class="persona-page__muted">最新为第 {{ template.version }} 版</p>
          <NButton secondary :disabled="saving" @click="openTemplate(template.id)">
            查看 {{ template.name }}
          </NButton>
        </NCard>
      </div>
      <NButton v-if="nextAfterId" secondary :disabled="loading || saving" @click="more">
        加载更多模板
      </NButton>
    </div>
  </AdminLayout>
</template>

<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInputNumber, NSpin } from 'naive-ui';
import UiLink from '@/components/UiLink.vue';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { createPersonaTemplateSchema, updatePersonaTemplateSchema } from '@memory-weave/contracts';
import type { PersonaTemplate } from '@memory-weave/contracts';
import AdminLayout from '@/components/AdminLayout.vue';
import PersonaInput from '@/components/PersonaInput.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { useCommandIdentity } from '@/composables/useCommandIdentity';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
} from '@memory-weave/browser-client/personas';
const route = useRoute();
const router = useRouter();
const { loading, saving, error, run } = usePersonaPage();
const identify = useCommandIdentity();
const items = ref<PersonaTemplate[]>([]);
const nextAfterId = ref<string | null>(null);
const selected = ref<PersonaTemplate | null>(null);
const latestVersion = ref(1);
const versionNumber = ref<number | null>(1);
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
/**
 * 加载模板列表及当前选中的模板。
 *
 * URL 记录所选模板，刷新后仍可读取，不在浏览器持久缓存私人原稿。
 */
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
/** 打开人设模板新建表单。 */
async function newTemplate(): Promise<void> {
  if (route.query.new === '1') formMode.value = 'new';
  else await router.push({ name: 'persona-templates', query: { new: '1' } });
}
/** 加载指定模板的最新版本。 */
async function openTemplate(id: string): Promise<void> {
  if (route.query.id === id) await loadPage();
  else await router.push({ name: 'persona-templates', query: { id } });
}
/**
 * 打开当前模板的编辑表单。
 *
 * 在当前最新版本上编辑，保存时仍由后端检查乐观版本。
 */
function editTemplate(): void {
  formMode.value = 'edit';
}
/**
 * 关闭模板编辑表单。
 *
 * 仅关闭本地表单。
 */
function closeForm(): void {
  formMode.value = null;
}
/**
 * 创建人设模板或保存新的模板版本。
 *
 * 模板保存不调用模型，也不向已有实例传播。
 */
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
/**
 * 加载模板的指定历史版本。
 *
 * 历史内容只读；编辑必须重新选择最新版本。
 */
async function loadVersion(): Promise<void> {
  const version = versionNumber.value;
  if (!selected.value || version === null || !Number.isInteger(version) || version < 1) {
    error.value = '请输入有效版本号。';
    return;
  }
  const result = await run(() => getTemplate(selected.value!.id, version));
  if (result) selected.value = result;
}
/**
 * 显示模板的最新版本。
 *
 * 回到当前最新模板后再编辑。
 */
async function latest(): Promise<void> {
  await loadPage();
}
/**
 * 加载下一页人设模板。
 *
 * 按需读取后续模板。
 */
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
    width: 130px;
  }
}
</style>

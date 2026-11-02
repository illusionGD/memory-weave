<template>
  <AdminLayout>
    <div class="persona-page">
      <section class="persona-page__intro">
        <p class="eyebrow">A beginning of their own</p>
        <h1 class="persona-page__title">创建伴侣</h1>
        <p class="persona-page__muted">
          原稿长期保留，模型自动整理初始人格。你不需要逐项确认或编辑。
        </p>
      </section>
      <NAlert v-if="testMode" type="info">
        测试模式：可以体验创建和保存流程，当前测试模型不会理解或整理人设。配置实际模型后才能评估真实效果。
      </NAlert>
      <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
      <NButton v-if="!prepared && !loading" secondary @click="prepare"> 重新读取创建配置 </NButton>
      <NSpin v-if="loading" size="small" role="status" description="正在准备…" />
      <NCard
        v-if="prepared"
        class="persona-page__panel"
        content-class="persona-page__panel-content"
      >
        <template v-if="template">
          <h2>使用「{{ template.name }}」第 {{ template.version }} 版</h2>
          <p class="persona-page__text">{{ template.initialProfile }}</p>
          <NForm label-placement="top" @submit.prevent="createFromTemplate">
            <NFormItem label="名字（可选）" :label-props="{ for: 'template-companion-name' }">
              <NInput
                v-model:value="name"
                :input-props="{ id: 'template-companion-name' }"
                :maxlength="80"
                :disabled="saving"
              />
            </NFormItem>
            <p class="persona-page__muted">创建独立实例，模板以后更新不会覆盖她的人格。</p>
            <NButton type="primary" attr-type="submit" :loading="saving" :disabled="saving">
              {{ saving ? '正在保存…' : '创建伴侣' }}
            </NButton>
          </NForm>
          <UiLink quaternary to="/companions/new">改为自己写一段人设</UiLink>
        </template>
        <PersonaInput v-else submit-label="创建伴侣" :busy="saving" @submit="createFromText" />
      </NCard>
      <UiLink quaternary to="/persona-templates">从人设模板选择</UiLink>
    </div>
  </AdminLayout>
</template>

<script setup lang="ts">
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpin } from 'naive-ui';
import UiLink from '@/components/UiLink.vue';
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  companionCreationSchema,
  uuidSchema,
  positiveIntegerSchema,
} from '@memory-weave/contracts';
import type { CompanionCreation, PersonaTemplate } from '@memory-weave/contracts';
import AdminLayout from '@/components/AdminLayout.vue';
import PersonaInput from '@/components/PersonaInput.vue';
import { usePersonaPage } from '@/composables/usePersonaPage';
import { useCommandIdentity } from '@/composables/useCommandIdentity';
import {
  createCompanion,
  getTemplate,
  getPersonaModelConfiguration,
} from '@memory-weave/browser-client/personas';
const route = useRoute();
const router = useRouter();
const { loading, saving, error, run } = usePersonaPage();
const identify = useCommandIdentity();
const template = ref<PersonaTemplate | null>(null);
const name = ref('');
const prepared = ref(false);
const testMode = ref(false);
watch(() => route.fullPath, prepare, { immediate: true });
/** 加载模型模式和创建所需的模板版本。 */
async function prepare(): Promise<void> {
  if (route.name !== 'companion-create') return;
  prepared.value = false;
  template.value = null;
  const id = typeof route.query.template === 'string' ? route.query.template : null;
  const version = Number(route.query.version);
  if (
    id &&
    (!uuidSchema.safeParse(id).success || !positiveIntegerSchema.safeParse(version).success)
  ) {
    error.value = '模板链接缺少有效的模板或版本号。';
    return;
  }
  const result = await run(async () => ({
    model: await getPersonaModelConfiguration(),
    template: id ? await getTemplate(id, version) : null,
  }));
  if (result) {
    testMode.value = result.model.config.tasks.persona.providerId === 'test';
    template.value = result.template;
    prepared.value = true;
  }
}
/**
 * 提交伴侣创建请求并打开详情页。
 *
 * 服务端接受原稿后转入详情，后台继续整理。
 */
async function create(input: Omit<CompanionCreation, 'requestId'>): Promise<void> {
  const parsed = companionCreationSchema.safeParse({ ...input, requestId: identify(input) });
  if (!parsed.success) {
    error.value = '请检查人设、名称和明确约束的长度。';
    return;
  }
  const result = await run(() => createCompanion(parsed.data), true);
  if (result) await router.push(`/companions/${result.companion.id}`);
}
/**
 * 根据输入的原稿创建伴侣。
 *
 * 普通创建只要求原稿，名字和约束可省略。
 */
async function createFromText(value: {
  name: string;
  profileText: string;
  lockedFeatures: string[];
}): Promise<void> {
  await create({
    ...(value.name ? { name: value.name } : {}),
    source: { kind: 'text', profileText: value.profileText, lockedFeatures: value.lockedFeatures },
  });
}
/** 根据选中的模板版本创建伴侣。 */
async function createFromTemplate(): Promise<void> {
  if (template.value)
    await create({
      ...(name.value.trim() ? { name: name.value.trim() } : {}),
      source: {
        kind: 'template',
        template: { id: template.value.id, version: template.value.version },
      },
    });
}
</script>

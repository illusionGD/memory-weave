<template>
  <NForm class="persona-input" :show-feedback="false" @submit.prevent="submit">
    <NFormItem
      :label="templateMode ? '模板名称' : '名字（可选）'"
      :label-props="{ for: 'persona-name' }"
    >
      <NInput
        v-model:value="name"
        :input-props="{ id: 'persona-name', autocomplete: 'off', required: templateMode }"
        :maxlength="80"
        :disabled="busy"
      />
    </NFormItem>
    <NFormItem label="一段人设" :label-props="{ for: 'persona-profile' }">
      <div class="persona-input__field">
        <NInput
          v-model:value="profileText"
          type="textarea"
          :rows="8"
          :input-props="{
            id: 'persona-profile',
            required: true,
            'aria-describedby': 'profile-hint',
          }"
          :maxlength="4000"
          :disabled="busy"
          placeholder="她是谁，有怎样的背景，喜欢什么，如何看待世界……"
        />
        <p id="profile-hint" class="persona-input__hint">
          {{ profileText.length }} / 4000 字。原稿会一直保留，无需逐项确认整理结果。
        </p>
      </div>
    </NFormItem>
    <NCollapse :default-expanded-names="initial?.lockedFeatures.length ? ['locks'] : []">
      <NCollapseItem name="locks">
        <template #header="{ collapsed }">
          <NButton
            class="persona-input__collapse-title"
            text
            :aria-expanded="!collapsed"
            aria-controls="persona-locks-fields"
          >
            明确要长期保留的约束（可选）
          </NButton>
        </template>
        <div id="persona-locks-fields" class="persona-input__field">
          <NFormItem label="明确约束，每行一条" :label-props="{ for: 'persona-locks' }">
            <NInput
              v-model:value="locks"
              type="textarea"
              :rows="3"
              :input-props="{ id: 'persona-locks', 'aria-describedby': 'locks-hint' }"
              :disabled="busy"
              placeholder="例如：始终保留独立思考"
            />
          </NFormItem>
          <p id="locks-hint" class="persona-input__hint">
            普通兴趣和性格可以逐渐发展；只有明确要保留的内容才需要填在这里。
          </p>
        </div>
      </NCollapseItem>
    </NCollapse>
    <NAlert v-if="validation" type="error" :show-icon="false">{{ validation }}</NAlert>
    <NButton
      class="persona-input__submit"
      type="primary"
      attr-type="submit"
      :disabled="busy"
      :loading="busy"
    >
      {{ busy ? '正在保存…' : submitLabel }}
    </NButton>
  </NForm>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { NAlert, NButton, NCollapse, NCollapseItem, NForm, NFormItem, NInput } from 'naive-ui';
import { lockedFeaturesSchema } from '@memory-weave/contracts';
interface InputValue {
  name: string;
  profileText: string;
  lockedFeatures: string[];
}
const props = withDefaults(
  defineProps<{
    templateMode?: boolean;
    initial?: InputValue;
    submitLabel: string;
    busy: boolean;
  }>(),
  { templateMode: false, initial: undefined },
);
const emit = defineEmits<{ submit: [value: InputValue] }>();
const name = ref(props.initial?.name ?? '');
const profileText = ref(props.initial?.profileText ?? '');
const locks = ref(props.initial?.lockedFeatures.join('\n') ?? '');
const validation = ref<string | null>(null);
/**
 * 校验并提交人设表单。
 *
 * 一段原稿即可提交，明确约束只有填写时才单独校验。
 */
function submit(): void {
  const parsed = lockedFeaturesSchema.safeParse(
    locks.value
      .split('\n')
      .map((text) => text.trim())
      .filter(Boolean),
  );
  if (
    !profileText.value.trim() ||
    profileText.value.length > 4000 ||
    (props.templateMode && !name.value.trim())
  ) {
    validation.value = '请填写有效的人设原稿和名称。';
    return;
  }
  if (!parsed.success) {
    validation.value = '明确约束最多 20 条，每条不超过 300 字。';
    return;
  }
  validation.value = null;
  emit('submit', {
    name: name.value.trim(),
    profileText: profileText.value,
    lockedFeatures: parsed.data,
  });
}
</script>

<style scoped lang="scss">
.persona-input {
  display: grid;
  gap: var(--space-6);
  &__field {
    display: grid;
    gap: var(--space-2);
    width: 100%;
    min-width: 0;
  }
  &__hint {
    color: var(--color-ink-soft);
    font-size: 0.85rem;
  }
  &__collapse-title {
    flex-shrink: 1;
    min-width: 0;
    max-width: 100%;
    white-space: normal;
    text-align: left;
    line-height: 1.6;
  }
  &__submit {
    justify-self: start;
  }
}
</style>

<template>
  <form class="persona-input" @submit.prevent="submit">
    <div class="persona-input__field">
      <label for="persona-name">{{ templateMode ? '模板名称' : '名字（可选）' }}</label>
      <input
        id="persona-name"
        v-model="name"
        :required="templateMode"
        maxlength="80"
        :disabled="busy"
        autocomplete="off"
      />
    </div>
    <div class="persona-input__field">
      <label for="persona-profile">一段人设</label>
      <textarea
        id="persona-profile"
        v-model="profileText"
        rows="8"
        required
        maxlength="4000"
        :disabled="busy"
        aria-describedby="profile-hint"
        placeholder="她是谁，有怎样的背景，喜欢什么，如何看待世界……"
      />
      <p id="profile-hint" class="persona-input__hint">
        {{ profileText.length }} / 4000 字。原稿会一直保留，无需逐项确认整理结果。
      </p>
    </div>
    <details :open="Boolean(initial?.lockedFeatures.length)">
      <summary>明确要长期保留的约束（可选）</summary>
      <div class="persona-input__field">
        <label for="persona-locks">明确约束，每行一条</label>
        <textarea
          id="persona-locks"
          v-model="locks"
          rows="3"
          :disabled="busy"
          placeholder="例如：始终保留独立思考"
        />
        <p class="persona-input__hint">
          普通兴趣和性格可以逐渐发展；只有明确要保留的内容才需要填在这里。
        </p>
      </div>
    </details>
    <p v-if="validation" class="notice notice--error" role="alert">{{ validation }}</p>
    <button class="button button--primary" type="submit" :disabled="busy" :aria-busy="busy">
      {{ busy ? '正在保存…' : submitLabel }}
    </button>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue';
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
/** 一段原稿即可提交，明确约束只有填写时才单独校验。 */
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
  }
  &__hint {
    color: var(--color-ink-soft);
    font-size: 0.85rem;
  }
  input,
  textarea {
    width: 100%;
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-ink);
    resize: vertical;
  }
  summary {
    cursor: pointer;
    margin-bottom: var(--space-3);
  }
  button {
    justify-self: start;
  }
}
</style>

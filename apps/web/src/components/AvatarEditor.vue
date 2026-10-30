<template>
  <section class="avatar-editor" aria-label="自定义头像">
    <CompanionAvatar
      :name="companion.name"
      :avatar="companion.avatar"
      :preview="preview"
      :size="72"
    />
    <div class="avatar-editor__body">
      <h2>伴侣头像</h2>
      <p class="avatar-editor__hint">
        选一张属于 {{ companion.name }} 的照片。JPG、PNG、WebP，最大 2 MB，保存时居中裁成正方形。
      </p>
      <div class="avatar-editor__actions">
        <button
          class="button button--secondary"
          :disabled="busy || restricted"
          @click="picker?.click()"
        >
          {{ companion.avatar ? '更换头像' : '选择头像' }}
        </button>
        <input
          ref="picker"
          class="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="选择头像图片"
          :disabled="busy || restricted"
          @change="select"
        />
        <button
          v-if="selected"
          class="button button--primary"
          :disabled="busy || restricted"
          @click="save"
        >
          {{ busy ? '正在保存…' : '保存头像' }}
        </button>
        <button v-if="selected" class="button button--quiet" :disabled="busy" @click="discard">
          取消
        </button>
        <button
          v-else-if="companion.avatar"
          class="button button--quiet"
          :disabled="busy || restricted"
          @click="reset"
        >
          恢复默认头像
        </button>
      </div>
      <p v-if="error" class="notice notice--error" role="alert">{{ error }}</p>
      <p v-if="message" class="avatar-editor__hint" role="status">{{ message }}</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { AVATAR_MAX_BYTES, AVATAR_MEDIA_TYPES } from '@memory-weave/contracts';
import type { AvatarState, CompanionDetail, ChangeAvatar } from '@memory-weave/contracts';
import { uploadAvatar, clearAvatar } from '@memory-weave/browser-client/avatars';
import { ApiError } from '@memory-weave/browser-client/http';
import CompanionAvatar from './CompanionAvatar.vue';
const props = defineProps<{ companion: CompanionDetail }>();
const emit = defineEmits<{ changed: [state: AvatarState]; refresh: [] }>();
const picker = ref<HTMLInputElement | null>(null);
const selected = ref<File | null>(null);
const preview = ref<string | null>(null);
const busy = ref(false);
const error = ref('');
const message = ref('');
const restricted = computed(() => Boolean(props.companion.lifecycleOperationId));
let command: ChangeAvatar | null = null;
let generation = 0;
watch([() => props.companion.id, () => props.companion.runtimeEpoch], () => {
  generation++;
  discard();
  busy.value = false;
  error.value = '';
  message.value = '';
});
onScopeDispose(() => {
  generation++;
  discard();
});
/** 释放仅存在当前页面的原图预览，不把图片写入浏览器持久缓存。 */
function discard(): void {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = null;
  selected.value = null;
  command = null;
  if (picker.value) picker.value.value = '';
}
/** 选图时固定版本，避免保存过程中用新版本覆盖其他终端的修改。 */
function select(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  discard();
  error.value = '';
  message.value = '';
  if (
    !AVATAR_MEDIA_TYPES.includes(file.type as (typeof AVATAR_MEDIA_TYPES)[number]) ||
    file.size > AVATAR_MAX_BYTES ||
    !file.size
  ) {
    error.value = '请选择 2 MB 以内的 JPG、PNG 或 WebP 图片。';
    return;
  }
  selected.value = file;
  preview.value = URL.createObjectURL(file);
  command = {
    requestId: crypto.randomUUID(),
    runtimeEpoch: props.companion.runtimeEpoch,
    expectedVersion: props.companion.avatarVersion,
  };
}
/** 上传成功后只更新展示字段；冲突时回查并要求重新选择，禁止静默覆盖。 */
async function apply(operation: () => Promise<AvatarState>): Promise<void> {
  const token = generation;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const state = await operation();
    if (token !== generation) return;
    emit('changed', state);
    discard();
    message.value = '头像已保存。';
  } catch (cause) {
    if (token !== generation) return;
    error.value = cause instanceof ApiError ? cause.message : '头像保存失败，请重试。';
    if (cause instanceof ApiError && [401, 404, 409].includes(cause.status ?? 0)) {
      discard();
      emit('refresh');
    }
  } finally {
    if (token === generation) busy.value = false;
  }
}
/** 重试保留同一图片与命令身份。 */
async function save(): Promise<void> {
  if (selected.value && command && !busy.value && !restricted.value) {
    const file = selected.value;
    const input = command;
    await apply(() => uploadAvatar(props.companion.id, input, file));
  }
}
/** 恢复默认不需要删除确认，之后可再次上传。 */
async function reset(): Promise<void> {
  if (busy.value || restricted.value) return;
  const input = {
    requestId: crypto.randomUUID(),
    runtimeEpoch: props.companion.runtimeEpoch,
    expectedVersion: props.companion.avatarVersion,
  };
  await apply(() => clearAvatar(props.companion.id, input));
}
</script>
<style scoped lang="scss">
.avatar-editor {
  display: flex;
  align-items: flex-start;
  gap: 22px;
  padding: 24px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.avatar-editor__body {
  min-width: 0;
  display: grid;
  gap: 12px;
}
.avatar-editor h2 {
  font-size: 16px;
  font-weight: 500;
}
.avatar-editor__hint {
  font-size: 12px;
  color: var(--color-ink-soft);
}
.avatar-editor__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.avatar-editor .button {
  font-size: 12px;
  min-height: 36px;
  padding: 8px 12px;
}
@media (max-width: 560px) {
  .avatar-editor {
    gap: 16px;
    padding: 18px;
    flex-wrap: wrap;
  }
}
</style>

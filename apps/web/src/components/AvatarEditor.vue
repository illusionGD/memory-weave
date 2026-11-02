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
        <!-- 选择队列由业务状态保存，组件只负责选图，避免触发内置上传。 -->
        <NUpload
          class="avatar-editor__upload"
          accept="image/jpeg,image/png,image/webp"
          :default-upload="false"
          :show-file-list="false"
          :file-list="[]"
          :disabled="busy || restricted"
          :input-props="{ 'aria-label': '选择头像图片' }"
          @change="select"
        >
          <NButton secondary size="small" :disabled="busy || restricted">
            {{ companion.avatar ? '更换头像' : '选择头像' }}
          </NButton>
        </NUpload>
        <NButton
          v-if="selected"
          type="primary"
          size="small"
          :disabled="busy || restricted"
          :loading="busy"
          @click="save"
        >
          {{ busy ? '正在保存…' : '保存头像' }}
        </NButton>
        <NButton v-if="selected" quaternary size="small" :disabled="busy" @click="discard"
          >取消</NButton
        >
        <NButton
          v-else-if="companion.avatar"
          quaternary
          size="small"
          :disabled="busy || restricted"
          :loading="busy"
          @click="reset"
        >
          恢复默认头像
        </NButton>
      </div>
      <NAlert v-if="error" type="error" :show-icon="false">{{ error }}</NAlert>
      <p v-if="message" class="avatar-editor__hint" role="status">{{ message }}</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { NAlert, NButton, NUpload } from 'naive-ui';
import type { UploadFileInfo } from 'naive-ui';
import { AVATAR_MAX_BYTES, AVATAR_MEDIA_TYPES } from '@memory-weave/contracts';
import type { AvatarState, CompanionDetail, ChangeAvatar } from '@memory-weave/contracts';
import { uploadAvatar, clearAvatar } from '@memory-weave/browser-client/avatars';
import { ApiError } from '@memory-weave/browser-client/http';
import CompanionAvatar from './CompanionAvatar.vue';
const props = defineProps<{ companion: CompanionDetail }>();
const emit = defineEmits<{ changed: [state: AvatarState]; refresh: [] }>();
const selected = ref<File | null>(null);
const preview = ref<string | null>(null);
const busy = ref(false);
const error = ref('');
const message = ref('');
const restricted = computed(() => Boolean(props.companion.lifecycleOperationId));
let command: ChangeAvatar | null = null;
let generation = 0;
let disposed = false;
watch([() => props.companion.id, () => props.companion.runtimeEpoch], () => {
  generation++;
  discard();
  busy.value = false;
  error.value = '';
  message.value = '';
});
onScopeDispose(() => {
  disposed = true;
  generation++;
  discard();
});
/**
 * 释放当前选中图片的本地预览。
 *
 * 释放仅存在当前页面的原图预览，不把图片写入浏览器持久缓存。
 */
function discard(): void {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = null;
  selected.value = null;
  command = null;
}
/**
 * 读取选中的头像图片并准备预览。
 *
 * 选图时固定版本，避免保存过程中用新版本覆盖其他终端的修改。
 */
function select({ file: candidate }: { file: UploadFileInfo }): void {
  const file = candidate.file;
  if (!file || disposed || busy.value || restricted.value) return;
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
/**
 * 上传头像或恢复默认头像，并同步页面资料。
 *
 * 上传成功后只更新展示字段；冲突时回查并要求重新选择，禁止静默覆盖。
 */
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
/**
 * 保存选中的头像图片。
 *
 * 重试保留同一图片与命令身份。
 */
async function save(): Promise<void> {
  if (selected.value && command && !busy.value && !restricted.value) {
    const file = selected.value;
    const input = command;
    await apply(() => uploadAvatar(props.companion.id, input, file));
  }
}
/**
 * 恢复伴侣的默认头像。
 *
 * 恢复默认不需要删除确认，之后可再次上传。
 */
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
.avatar-editor__upload {
  width: auto;
}
@media (max-width: 560px) {
  .avatar-editor {
    gap: 16px;
    padding: 18px;
    flex-wrap: wrap;
  }
}
</style>

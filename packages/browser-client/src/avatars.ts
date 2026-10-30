import { avatarStateSchema } from '@memory-weave/contracts';
import type { AvatarState, ChangeAvatar } from '@memory-weave/contracts';
import { requestJson } from './http';

/** 上传原始图片；重试须沿用调用方固定的版本、代次与命令身份。 */
export function uploadAvatar(id: string, input: ChangeAvatar, file: File): Promise<AvatarState> {
  const query = new URLSearchParams({
    requestId: input.requestId,
    runtimeEpoch: String(input.runtimeEpoch),
    expectedVersion: String(input.expectedVersion),
  });
  return requestJson(`/api/companions/${id}/avatar?${query}`, avatarStateSchema, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
}
/** 恢复默认头像，不修改人格或消息记录。 */
export function clearAvatar(id: string, input: ChangeAvatar): Promise<AvatarState> {
  return requestJson(`/api/companions/${id}/avatar`, avatarStateSchema, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

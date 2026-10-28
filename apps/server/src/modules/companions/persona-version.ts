import type { PersonaVersion } from '@memory-weave/contracts';
import type { personaVersions } from '../../database/schema';

/** 将持久版本转换成公共记录，不暴露内部命令指纹。 */
export function toPersonaVersion(row: typeof personaVersions.$inferSelect): PersonaVersion {
  return {
    id: row.id,
    ownerId: row.ownerId,
    companionId: row.companionId,
    runtimeEpoch: row.runtimeEpoch,
    version: row.version,
    profileText: row.profileText,
    document: row.document,
    origin: row.origin,
    parentVersionId: row.parentVersionId,
    modelCallId: row.modelCallId,
    mode: row.mode,
    createdAt: row.createdAt.toISOString(),
  };
}

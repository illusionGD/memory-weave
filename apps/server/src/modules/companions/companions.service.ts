import { ApiErrorCode } from '@memory-weave/contracts';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  CompanionDetail,
  CompanionListResponse,
  IdPaginationQuery,
  CreateCompanionRequest,
} from '@memory-weave/contracts';
import { and, asc, eq, gt } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import type { Database, DatabaseTransaction } from '../../database/database.service';
import { companions, personaVersions } from '../../database/schema';
import { fingerprint } from '../shared/http';
import { ApiException } from '../../http/api-exception';

/** 保存部署管理者的实例身份、不可变初始快照及当前人格版本。 */
@Injectable()
export class CompanionsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 将初始文本直接保存到独立快照和当前版本，不调用模型。 */
  create(input: CreateCompanionRequest): Promise<CompanionDetail> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(async (tx) => {
        const id = randomUUID();
        const personaId = randomUUID();
        const createdAt = new Date();
        const requestFingerprint = fingerprint({
          name: input.name,
          initialProfile: input.initialProfile,
        });
        const inserted = await tx
          .insert(companions)
          .values({
            id,
            ownerId,
            name: input.name,
            runtimeEpoch: 1,
            version: 1,
            initialSnapshot: {
              id: randomUUID(),
              schemaVersion: 1,
              profileText: input.initialProfile,
              sourceKind: 'initial_setting',
              createdAt: createdAt.toISOString(),
            },
            currentPersonaVersionId: null,
            requestId: input.requestId,
            fingerprint: requestFingerprint,
            createdAt,
          })
          .onConflictDoNothing({ target: [companions.ownerId, companions.requestId] })
          .returning({ id: companions.id });
        // 唯一键等待并发创建提交后，当前事务再读取已保存结果，避免生成第二份人格。
        if (inserted.length === 0) {
          const [existing] = await tx
            .select({ id: companions.id, fingerprint: companions.fingerprint })
            .from(companions)
            .where(and(eq(companions.ownerId, ownerId), eq(companions.requestId, input.requestId)))
            .limit(1);
          if (!existing || existing.fingerprint !== requestFingerprint) {
            throw new ApiException(ApiErrorCode.IDEMPOTENCY_CONFLICT);
          }
          return this.detail(tx, ownerId, existing.id);
        }
        await tx.insert(personaVersions).values({
          id: personaId,
          ownerId,
          companionId: id,
          runtimeEpoch: 1,
          version: 1,
          profileText: input.initialProfile,
          createdAt,
        });
        await tx
          .update(companions)
          .set({ currentPersonaVersionId: personaId })
          .where(and(eq(companions.ownerId, ownerId), eq(companions.id, id)));
        return this.detail(tx, ownerId, id);
      }),
    );
  }

  /** 按当前部署归属查找实例，不能跨管理者查询。 */
  get(id: string): Promise<CompanionDetail> {
    return this.database.withOwner((ownerId, db) => this.detail(db, ownerId, id));
  }

  /** 按稳定 UUID 查询多一条，以判断下一页是否实际存在。 */
  list(query: IdPaginationQuery): Promise<CompanionListResponse> {
    return this.database.withOwner(async (ownerId, db) => {
      const rows = await db
        .select({ companion: companions, persona: personaVersions })
        .from(companions)
        .innerJoin(
          personaVersions,
          and(
            eq(personaVersions.ownerId, companions.ownerId),
            eq(personaVersions.companionId, companions.id),
            eq(personaVersions.id, companions.currentPersonaVersionId),
          ),
        )
        .where(
          and(
            eq(companions.ownerId, ownerId),
            query.afterId ? gt(companions.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(companions.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit).map((row) => this.toDetail(row));
      return {
        items,
        nextAfterId: rows.length > query.limit ? items.at(-1)!.id : null,
      };
    });
  }

  /** 限定管理者及实例关系，当前人格必须属于同一实例。 */
  private async detail(
    db: Database | DatabaseTransaction,
    ownerId: string,
    id: string,
  ): Promise<CompanionDetail> {
    const [row] = await db
      .select({ companion: companions, persona: personaVersions })
      .from(companions)
      .innerJoin(
        personaVersions,
        and(
          eq(personaVersions.ownerId, companions.ownerId),
          eq(personaVersions.companionId, companions.id),
          eq(personaVersions.id, companions.currentPersonaVersionId),
        ),
      )
      .where(and(eq(companions.ownerId, ownerId), eq(companions.id, id)))
      .limit(1);
    if (!row) throw new ApiException(ApiErrorCode.RESOURCE_NOT_FOUND);
    return this.toDetail(row);
  }

  /** 只映射公共字段，幂等指纹等内部字段不进入响应。 */
  private toDetail(row: {
    companion: typeof companions.$inferSelect;
    persona: typeof personaVersions.$inferSelect;
  }): CompanionDetail {
    return {
      id: row.companion.id,
      ownerId: row.companion.ownerId,
      name: row.companion.name,
      runtimeEpoch: row.companion.runtimeEpoch,
      version: row.companion.version,
      initialSnapshot: row.companion.initialSnapshot,
      currentPersonaVersionId: row.persona.id,
      currentPersonaVersion: {
        id: row.persona.id,
        ownerId: row.persona.ownerId,
        companionId: row.persona.companionId,
        runtimeEpoch: row.persona.runtimeEpoch,
        version: row.persona.version,
        profileText: row.persona.profileText,
        createdAt: row.persona.createdAt.toISOString(),
      },
      createdAt: row.companion.createdAt.toISOString(),
    };
  }
}

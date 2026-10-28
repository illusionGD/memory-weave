import { API_CODES } from '@memory-weave/contracts';
import type {
  CreatePersonaTemplate,
  UpdatePersonaTemplate,
  IdPaginationQuery,
  PersonaTemplate,
  PersonaTemplateList,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import type { Database, DatabaseTransaction } from '../../database/database.service';
import { personaTemplates, personaTemplateVersions } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';

/** 保存独立模板，绝不以模板更新覆盖实例。 */
@Injectable()
export class PersonaTemplatesService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 幂等保存模板首版，不调用模型。 */
  create(input: CreatePersonaTemplate): Promise<PersonaTemplate> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          const id = randomUUID();
          const hash = fingerprint(input);
          await tx
            .insert(personaTemplates)
            .values({ id, ownerId, version: 1, requestId: input.requestId, fingerprint: hash })
            .onDuplicateKeyUpdate({ set: { id: sql`${personaTemplates.id}` } });
          const [head] = await tx
            .select()
            .from(personaTemplates)
            .where(
              and(
                eq(personaTemplates.ownerId, ownerId),
                eq(personaTemplates.requestId, input.requestId),
              ),
            )
            .for('update');
          if (!head || head.fingerprint !== hash)
            throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
          if (head.id === id)
            await tx.insert(personaTemplateVersions).values({
              ...input,
              id: randomUUID(),
              ownerId,
              templateId: id,
              version: 1,
              fingerprint: hash,
            });
          return this.read(tx, ownerId, head.id, 1);
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }

  /** 读取最新版本，或由创建命令指定的历史版本。 */
  get(id: string, version?: number): Promise<PersonaTemplate> {
    return this.database.withOwner((ownerId, db) => this.read(db, ownerId, id, version));
  }

  /** 旧命令重放原版本；新的编辑必须基于最新版本。 */
  update(id: string, input: UpdatePersonaTemplate): Promise<PersonaTemplate> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          const [head] = await tx
            .select()
            .from(personaTemplates)
            .where(and(eq(personaTemplates.ownerId, ownerId), eq(personaTemplates.id, id)))
            .for('update');
          if (!head) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
          const hash = fingerprint(input);
          const [replay] = await tx
            .select()
            .from(personaTemplateVersions)
            .where(
              and(
                eq(personaTemplateVersions.ownerId, ownerId),
                eq(personaTemplateVersions.templateId, id),
                eq(personaTemplateVersions.requestId, input.requestId),
              ),
            );
          if (replay) {
            if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
            return toTemplate(replay);
          }
          if (head.version !== input.expectedVersion)
            throw new ApiException(API_CODES.VERSION_CONFLICT);
          if (head.version >= 2_147_483_647)
            throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
          const row = {
            id: randomUUID(),
            ownerId,
            templateId: id,
            version: head.version + 1,
            requestId: input.requestId,
            fingerprint: hash,
            name: input.name,
            initialProfile: input.initialProfile,
            lockedFeatures: input.lockedFeatures,
            createdAt: new Date(),
          };
          await tx.insert(personaTemplateVersions).values(row);
          await tx
            .update(personaTemplates)
            .set({ version: row.version })
            .where(eq(personaTemplates.id, id));
          return toTemplate(row);
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }

  /** 按稳定标识分页列出模板最新版本。 */
  list(query: IdPaginationQuery): Promise<PersonaTemplateList> {
    return this.database.withOwner(async (ownerId, db) => {
      const rows = await db
        .select({ value: personaTemplateVersions })
        .from(personaTemplates)
        .innerJoin(
          personaTemplateVersions,
          and(
            eq(personaTemplateVersions.ownerId, personaTemplates.ownerId),
            eq(personaTemplateVersions.templateId, personaTemplates.id),
            eq(personaTemplateVersions.version, personaTemplates.version),
          ),
        )
        .where(
          and(
            eq(personaTemplates.ownerId, ownerId),
            query.afterId ? gt(personaTemplates.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(personaTemplates.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit).map(({ value }) => toTemplate(value));
      return { items, nextAfterId: rows.length > query.limit ? items.at(-1)!.id : null };
    });
  }

  private async read(
    db: Database | DatabaseTransaction,
    ownerId: string,
    id: string,
    version?: number,
  ): Promise<PersonaTemplate> {
    const [row] = await db
      .select({ value: personaTemplateVersions })
      .from(personaTemplates)
      .innerJoin(
        personaTemplateVersions,
        and(
          eq(personaTemplateVersions.ownerId, personaTemplates.ownerId),
          eq(personaTemplateVersions.templateId, personaTemplates.id),
          eq(personaTemplateVersions.version, version ?? personaTemplates.version),
        ),
      )
      .where(and(eq(personaTemplates.ownerId, ownerId), eq(personaTemplates.id, id)))
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return toTemplate(row.value);
  }
}

function toTemplate(row: typeof personaTemplateVersions.$inferSelect): PersonaTemplate {
  return {
    id: row.templateId,
    version: row.version,
    name: row.name,
    initialProfile: row.initialProfile,
    lockedFeatures: row.lockedFeatures,
    createdAt: row.createdAt.toISOString(),
  };
}

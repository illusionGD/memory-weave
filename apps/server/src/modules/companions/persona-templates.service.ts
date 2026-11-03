import type {
  CreatePersonaTemplate,
  IdPaginationQuery,
  PersonaTemplate,
  PersonaTemplateList,
  UpdatePersonaTemplate,
} from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { idCursorPage } from '../../database/cursor-pagination';
import type { Database, DatabaseTransaction } from '../../database/database.service';
import { DatabaseService } from '../../database/database.service';
import { personaTemplates, personaTemplateVersions } from '../../database/schema';
import { tables } from '../../database/tables';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { PersonaTemplateRepository } from './persona-template.repository';

/** 保存独立模板，绝不以模板更新覆盖实例。 */
@Injectable()
export class PersonaTemplatesService {
  /** 初始化人设模板的数据访问服务。 */
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * 创建人设模板及其首个版本。
   *
   * 幂等保存模板首版，不调用模型。
   */
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
            await tables.personaTemplateVersions.bind(tx, ownerId).insert({
              ...input,
              id: randomUUID(),
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

  /** 查询模板的最新版本或指定历史版本。 */
  get(id: string, version?: number): Promise<PersonaTemplate> {
    return this.database.withOwner((ownerId, db) => this.read(db, ownerId, id, version));
  }

  /**
   * 保存人设模板的新版本。
   *
   * 旧命令重放原版本；新的编辑必须基于最新版本。
   */
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
          const replay = await tables.personaTemplateVersions.bind(tx, ownerId).findOne({
            where: { templateId: id, requestId: input.requestId },
          });
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
            templateId: id,
            version: head.version + 1,
            requestId: input.requestId,
            fingerprint: hash,
            name: input.name,
            initialProfile: input.initialProfile,
            lockedFeatures: input.lockedFeatures,
            createdAt: new Date(),
          };
          await tables.personaTemplateVersions.bind(tx, ownerId).insert(row);
          await tables.personaTemplates
            .bind(tx, ownerId)
            .updateWhere({ where: { id }, set: { version: row.version } });
          return toTemplate({ ...row, ownerId });
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }

  /** 分页查询人设模板列表。 */
  list(query: IdPaginationQuery): Promise<PersonaTemplateList> {
    return this.database.withOwner(async (ownerId, db) => {
      const rows = await new PersonaTemplateRepository(db, ownerId).listCurrent(query);
      const page = idCursorPage(rows, query.limit, (row) => row.templateId);
      return { items: page.items.map(toTemplate), nextAfterId: page.nextAfterId };
    });
  }

  /** 读取指定的人设模板版本。 */
  private async read(
    db: Database | DatabaseTransaction,
    ownerId: string,
    id: string,
    version?: number,
  ): Promise<PersonaTemplate> {
    const row = await new PersonaTemplateRepository(db, ownerId).getVersion(id, version);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return toTemplate(row);
  }
}

/** 将模板存储记录转换为公共响应。 */
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

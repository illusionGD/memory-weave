import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { IdPaginationQuery } from '@memory-weave/contracts';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { QueryDatabase } from '../../database/database.service';
import { personaTemplates, personaTemplateVersions } from '../../database/schema';

/** 在当前连接上读取模板版本，复用身份与版本的关联条件。 */
@Injectable()
export class PersonaTemplateRepository {
  /** 注入共享数据库入口，身份和事务由每次调用确定。 */
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 读取最新版本或指定历史版本，不将缺失结果转换成业务异常。 */
  async getVersion(
    id: string,
    version?: number,
    connection?: QueryDatabase,
  ): Promise<typeof personaTemplateVersions.$inferSelect | null> {
    const db = connection ?? (await this.database.current());
    const [row] = await this.versions(db, version)
      .where(and(eq(personaTemplates.ownerId, db.ownerId), eq(personaTemplates.id, id)))
      .limit(1);
    return row?.value ?? null;
  }

  /** 按模板 ID 游标读取当前版本，多取一条供调用方判断后续页。 */
  async listCurrent(
    query: IdPaginationQuery,
  ): Promise<(typeof personaTemplateVersions.$inferSelect)[]> {
    const db = await this.database.current();
    const rows = await this.versions(db)
      .where(
        and(
          eq(personaTemplates.ownerId, db.ownerId),
          query.afterId ? gt(personaTemplates.id, query.afterId) : undefined,
        ),
      )
      .orderBy(asc(personaTemplates.id))
      .limit(query.limit + 1);
    return rows.map(({ value }) => value);
  }

  /** 组合模板身份与精确版本，避免列表和详情分别维护关联规则。 */
  private versions(db: QueryDatabase, version?: number) {
    return db.sql
      .select({ value: personaTemplateVersions })
      .from(personaTemplates)
      .innerJoin(
        personaTemplateVersions,
        and(
          eq(personaTemplateVersions.ownerId, personaTemplates.ownerId),
          eq(personaTemplateVersions.templateId, personaTemplates.id),
          eq(personaTemplateVersions.version, version ?? personaTemplates.version),
        ),
      );
  }
}

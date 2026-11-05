import type { IdPaginationQuery } from '@memory-weave/contracts';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { QueryDatabase } from '../../database/database.service';
import { personaTemplates, personaTemplateVersions } from '../../database/schema';

/** 在当前连接上读取模板版本，复用身份与版本的关联条件。 */
export class PersonaTemplateRepository {
  /** 固定本次查询的连接与数据归属，事务由服务层持有。 */
  constructor(
    private readonly db: QueryDatabase,
    private readonly ownerId: string,
  ) {}

  /** 读取最新版本或指定历史版本，不将缺失结果转换成业务异常。 */
  async getVersion(
    id: string,
    version?: number,
  ): Promise<typeof personaTemplateVersions.$inferSelect | null> {
    const [row] = await this.versions(version)
      .where(and(eq(personaTemplates.ownerId, this.ownerId), eq(personaTemplates.id, id)))
      .limit(1);
    return row?.value ?? null;
  }

  /** 按模板 ID 游标读取当前版本，多取一条供调用方判断后续页。 */
  async listCurrent(
    query: IdPaginationQuery,
  ): Promise<(typeof personaTemplateVersions.$inferSelect)[]> {
    const rows = await this.versions()
      .where(
        and(
          eq(personaTemplates.ownerId, this.ownerId),
          query.afterId ? gt(personaTemplates.id, query.afterId) : undefined,
        ),
      )
      .orderBy(asc(personaTemplates.id))
      .limit(query.limit + 1);
    return rows.map(({ value }) => value);
  }

  /** 组合模板身份与精确版本，避免列表和详情分别维护关联规则。 */
  private versions(version?: number) {
    return this.db.sql
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

import { Inject, Injectable } from '@nestjs/common';
import type { IdPaginationQuery } from '@memory-weave/contracts';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import type { QueryDatabase } from '../../database/database.service';
import { companions, personaVersions } from '../../database/schema';

/** 集中维护伴侣与当前人格的关联查询，列表与详情使用同一归属规则。 */
@Injectable()
export class CompanionRepository {
  /** 注入复用的数据库入口，不在单例中保存当前用户或事务。 */
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** 读取未删除伴侣及其当前人格，可复用调用方的事务。 */
  async get(id: string, connection?: QueryDatabase) {
    const db = connection ?? (await this.database.current());
    const [row] = await this.joinPersona(db)
      .where(
        and(
          eq(companions.ownerId, db.ownerId),
          eq(companions.id, id),
          isNull(companions.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** 按 ID 游标读取伴侣及当前人格，多取一条用于判断下一页。 */
  async list(query: IdPaginationQuery) {
    const db = await this.database.current();
    return this.joinPersona(db)
      .where(
        and(
          eq(companions.ownerId, db.ownerId),
          isNull(companions.deletedAt),
          query.afterId ? gt(companions.id, query.afterId) : undefined,
        ),
      )
      .orderBy(asc(companions.id))
      .limit(query.limit + 1);
  }

  /** 固定人格必须属于同一用户与同一伴侣，不能只根据版本 ID 关联。 */
  private joinPersona(db: QueryDatabase) {
    return db.sql
      .select({ companion: companions, persona: personaVersions })
      .from(companions)
      .innerJoin(
        personaVersions,
        and(
          eq(personaVersions.ownerId, companions.ownerId),
          eq(personaVersions.companionId, companions.id),
          eq(personaVersions.id, companions.currentPersonaVersionId),
        ),
      );
  }
}

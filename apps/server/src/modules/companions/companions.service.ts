import type {
  CompanionDetail,
  CompanionListResponse,
  CreateCompanionRequest,
  IdPaginationQuery,
} from '@memory-weave/contracts';
import { API_CODES } from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { idCursorPage } from '../../database/cursor-pagination';
import type { Database, DatabaseTransaction } from '../../database/database.service';
import { DatabaseService } from '../../database/database.service';
import { companions, personaVersions } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { lockTaskScheduler } from '../tasks/task-store';
import { CompanionRepository } from './companion.repository';
import { publicAvatar } from './avatar-files';
import { toPersonaVersion } from './persona-version';

/** 保存部署管理者的实例身份、不可变初始快照及当前人格版本。 */
@Injectable()
export class CompanionsService {
  /** 初始化伴侣实例的数据访问服务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CompanionRepository) private readonly repository: CompanionRepository,
  ) {}

  /**
   * 根据初始文本创建伴侣及人格记录。
   *
   * 将初始文本直接保存到独立快照和当前版本，不调用模型。
   */
  async create(input: CreateCompanionRequest): Promise<CompanionDetail> {
    return this.database.transaction(
      async (tx) => {
        const ownerId = tx.ownerId;

        return this.createInTransaction(ownerId, tx, input);
      },
      { isolationLevel: 'read committed' },
    );
  }

  /**
   * 在当前事务中保存伴侣原稿与初始人格。
   *
   * 在已有领域事务中保存原稿，供创建任务与实例原子提交。
   */
  async createInTransaction(
    ownerId: string,
    tx: DatabaseTransaction,
    input: CreateCompanionRequest,
  ): Promise<CompanionDetail> {
    await lockTaskScheduler(ownerId, tx);
    const id = randomUUID();
    const personaId = randomUUID();
    const createdAt = new Date();
    const requestFingerprint = fingerprint({
      name: input.name,
      initialProfile: input.initialProfile,
    });
    await tx.sql
      .insert(companions)
      .values({
        id,
        ownerId,
        name: input.name,
        runtimeEpoch: 1,
        version: 1,
        initialSnapshot: {
          id: randomUUID(),

          profileText: input.initialProfile,
          sourceKind: 'initial_setting',
          createdAt: createdAt.toISOString(),
        },
        currentPersonaVersionId: null,
        requestId: input.requestId,
        fingerprint: requestFingerprint,
        createdAt,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${companions.id}` } });
    const [stored] = await tx.sql
      .select({ id: companions.id, fingerprint: companions.fingerprint })
      .from(companions)
      .where(and(eq(companions.ownerId, ownerId), eq(companions.requestId, input.requestId)))
      .limit(1)
      .for('update');
    if (!stored) throw new ApiException(API_CODES.CONFLICT);
    // 唯一键等待并发创建提交后，当前事务再读取已保存结果，避免生成第二份人格。
    if (stored.id !== id) {
      if (stored.fingerprint !== requestFingerprint)
        throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
      return this.readInTransaction(tx, stored.id);
    }
    await tx.personaVersions.insert({
      id: personaId,
      companionId: id,
      runtimeEpoch: 1,
      version: 1,
      profileText: input.initialProfile,
      createdAt,
    });
    await tx.companions.updateWhere({
      where: { id: id },
      set: { currentPersonaVersionId: personaId },
    });
    return this.readInTransaction(tx, id);
  }

  /**
   * 查询当前管理者拥有的伴侣。
   *
   * 按当前部署归属查找实例，不能跨管理者查询。
   */
  async get(id: string): Promise<CompanionDetail> {
    const db = await this.database.current();
    return this.readInTransaction(db, id);
  }

  /**
   * 分页查询伴侣列表和后续游标。
   *
   * 按稳定 UUID 查询多一条，以判断下一页是否实际存在。
   */
  async list(query: IdPaginationQuery): Promise<CompanionListResponse> {
    const rows = await this.repository.list(query);
    const page = idCursorPage(rows, query.limit, (row) => row.companion.id);
    return {
      items: page.items.map((row) => this.toDetail(row)),
      nextAfterId: page.nextAfterId,
    };
  }

  /**
   * 在当前事务中读取伴侣及当前人格。
   *
   * 限定管理者及实例关系，当前人格必须属于同一实例。
   */
  async readInTransaction(
    db: Database | DatabaseTransaction,
    id: string,
  ): Promise<CompanionDetail> {
    const row = await this.repository.get(id, db);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return this.toDetail(row);
  }

  /**
   * 将伴侣和人格记录转换为详情响应。
   *
   * 只映射公共字段，幂等指纹等内部字段不进入响应。
   */
  private toDetail(row: {
    companion: typeof companions.$inferSelect;
    persona: typeof personaVersions.$inferSelect;
  }): CompanionDetail {
    return {
      id: row.companion.id,
      ownerId: row.companion.ownerId,
      name: row.companion.name,
      avatar: publicAvatar(row.companion.id, row.companion.avatar),
      avatarVersion: row.companion.avatarVersion,
      runtimeEpoch: row.companion.runtimeEpoch,
      version: row.companion.version,
      initialSnapshot: row.companion.initialSnapshot!,
      lifecycleOperationId: row.companion.lifecycleOperationId,
      currentPersonaVersionId: row.persona.id,
      currentPersonaVersion: toPersonaVersion(row.persona),
      createdAt: row.companion.createdAt.toISOString(),
    };
  }
}

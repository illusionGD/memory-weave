import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  EmbeddingSelection,
  ModelConfigurationVersion,
  SwitchEmbedding,
  SwitchedEmbedding,
} from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  memoryEmbeddingSelections,
  memoryEmbeddingSpaces,
  memoryEntries,
  memoryVectorIndexes,
  memoryVersions,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { embeddingSpace, RetrievalVector, vectorCollection } from '../retrieval/retrieval-vector';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';

type Selection = typeof memoryEmbeddingSelections.$inferSelect;
type Registration = typeof memoryEmbeddingSpaces.$inferSelect;

/** 独立于模型默认配置，原子决定查询编码与集合。 */
@Injectable()
export class EmbeddingSpaces {
  /** 初始化编码登记、核对和切换服务。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(ModelConfigurationService) private readonly models: ModelConfigurationService,
    @Inject(RetrievalVector) private readonly vectors: RetrievalVector,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  /** 登记部署最新的编码并继续维护当前、前一版本和新候选。 */
  async sync(ownerId: string, current: ModelConfigurationVersion) {
    const configured = this.configuredSpace(current);
    return this.store.locked(ownerId, async (tx, now) => {
      let selected = await this.selection(ownerId, tx);
      if (configured) {
        await tx
          .insert(memoryEmbeddingSpaces)
          .values({ ownerId, space: configured, configVersion: current.version })
          .onDuplicateKeyUpdate({
            set: {
              configVersion: sql`greatest(${memoryEmbeddingSpaces.configVersion}, ${current.version})`,
            },
          });
        if (!selected) {
          const [legacy] = await tx
            .select({
              space: memoryVectorIndexes.space,
              configVersion: memoryVectorIndexes.configVersion,
            })
            .from(memoryVectorIndexes)
            .where(
              and(
                eq(memoryVectorIndexes.ownerId, ownerId),
                eq(memoryVectorIndexes.status, 'indexed'),
              ),
            )
            .orderBy(desc(memoryVectorIndexes.configVersion))
            .limit(1);
          if (legacy && legacy.space !== configured)
            await tx.insert(memoryEmbeddingSpaces).values({ ownerId, ...legacy });
          selected = {
            ownerId,
            version: 1,
            requestId: null,
            fingerprint: null,
            space: legacy?.space ?? configured,
            previous: null,
            evaluationNote: legacy ? '沿用已有查询编码。' : '首个已配置向量空间。',
            createdAt: now,
          };
          await tx.insert(memoryEmbeddingSelections).values(selected);
        }
      }
      const rows = await tx
        .select()
        .from(memoryEmbeddingSpaces)
        .where(eq(memoryEmbeddingSpaces.ownerId, ownerId))
        .orderBy(desc(memoryEmbeddingSpaces.configVersion));
      return { selected, configured, rows };
    });
  }

  /** 对一个请求锁定同一编码版本；兼容性改变时保留词法查询。 */
  async queryConfiguration(ownerId: string, current: ModelConfigurationVersion) {
    const selected = await this.selection(ownerId);
    if (!selected)
      return {
        configuration: current,
        space: embeddingSpace(current.config.tasks.embedding, this.config),
        vectorEnabled: true,
      };
    const row = await this.registration(ownerId, selected.space);
    const configuration = row && (await this.models.getVersion(ownerId, row.configVersion));
    return {
      configuration: configuration ?? current,
      space: selected.space,
      vectorEnabled: Boolean(
        configuration && this.configuredSpace(configuration) === selected.space,
      ),
    };
  }

  /** 在提交结果或派发时核对捕获的查询空间仍然有效。 */
  async isCurrent(ownerId: string, space: string, tx: DatabaseTransaction) {
    const selected = await this.selection(ownerId, tx);
    return !selected || selected.space === space;
  }

  /** 查询目标集合、实际覆盖和兼容性。 */
  async status(ownerId: string): Promise<EmbeddingSelection> {
    const current = await this.models.get(ownerId);
    const { selected, configured, rows } = await this.sync(ownerId, current);
    const live = await this.countEligible(ownerId);
    const spaces: EmbeddingSelection['spaces'] = [];
    for (const row of rows) {
      const configuration = await this.models.getVersion(ownerId, row.configVersion);
      const counts = await this.countIndexed(ownerId, row.space);
      const task = configuration.config.tasks.embedding;
      spaces.push({
        space: row.space,
        configVersion: row.configVersion,
        providerId: task.providerId,
        model: task.model,
        dimensions: task.dimensions!,
        collection: vectorCollection(ownerId, row.space),
        eligibleVersions: live,
        indexedVersions: counts.current,
        staleVersions: counts.stale,
        compatible: this.configuredSpace(configuration) === row.space,
        syncing: this.isMaintained(row, selected, configured),
      });
    }
    return {
      version: selected?.version ?? 0,
      active: selected?.space ?? null,
      previous: selected?.previous ?? null,
      configured,
      spaces,
    };
  }

  /** 当前、上一使用空间及部署候选在构建与回滚窗口内保持同步。 */
  isMaintained(row: Registration, selected: Selection | null, configured: string | null) {
    return [selected?.space, selected?.previous, configured].includes(row.space);
  }

  /** 先在外部向量库验证完整性，再核对主库版本集合未变化并原子提交。 */
  async switch(ownerId: string, command: SwitchEmbedding): Promise<SwitchedEmbedding> {
    const hash = fingerprint(command);
    const initial = await this.store.locked(ownerId, async (tx) => {
      const replay = await this.replay(ownerId, command.requestId, hash, tx);
      if (replay) return { replay };
      const head = await this.selection(ownerId, tx);
      if (!head || head.version !== command.expectedVersion || head.space === command.targetSpace)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const row = await this.registration(ownerId, command.targetSpace, tx);
      if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      return { row };
    });
    if (initial.replay) return this.toSwitch(initial.replay);
    const row = initial.row!;
    const configuration = await this.models.getVersion(ownerId, row.configVersion);
    if (this.configuredSpace(configuration) !== row.space)
      throw new ApiException(API_CODES.VERSION_CONFLICT, '编码配置与当前部署不兼容。');
    const collection = vectorCollection(ownerId, row.space);
    await this.vectors.ensure(collection, configuration.config.tasks.embedding.dimensions!);
    const before = await this.coverage(ownerId, row.space, this.database.sql, collection);
    if ((await this.vectors.count(collection)) !== before.count) throw this.unready();
    return this.store.locked(ownerId, async (tx, now) => {
      const replay = await this.replay(ownerId, command.requestId, hash, tx);
      if (replay) return this.toSwitch(replay);
      const head = await this.selection(ownerId, tx);
      if (!head || head.version !== command.expectedVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (head.version >= 2_147_483_647) throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const after = await this.coverage(ownerId, row.space, tx);
      if (after.hash !== before.hash || after.count !== before.count) throw this.unready();
      const next = {
        ownerId,
        version: head.version + 1,
        requestId: command.requestId,
        fingerprint: hash,
        space: row.space,
        previous: head.space,
        evaluationNote: command.evaluationNote,
        createdAt: now,
      };
      await tx.insert(memoryEmbeddingSelections).values(next);
      return this.toSwitch(next);
    });
  }

  /** 切换校验使用全部权威版本的键，不只依赖库内累计数。 */
  private async coverage(
    ownerId: string,
    space: string,
    client: DatabaseTransaction | DatabaseService['sql'],
    collection?: string,
  ) {
    const hash = createHash('sha256');
    let after: string | undefined;
    let count = 0;
    for (;;) {
      const rows = await client
        .select({ id: memoryVersions.id, state: memoryVectorIndexes.status })
        .from(memoryEntries)
        .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEntries.currentVersionId))
        .leftJoin(
          memoryVectorIndexes,
          and(
            eq(memoryVectorIndexes.ownerId, ownerId),
            eq(memoryVectorIndexes.versionId, memoryVersions.id),
            eq(memoryVectorIndexes.space, space),
          ),
        )
        .where(and(this.eligible(ownerId), after ? gt(memoryVersions.id, after) : undefined))
        .orderBy(asc(memoryVersions.id))
        .limit(200);
      if (rows.some((row) => row.state !== 'indexed')) throw this.unready();
      const ids = rows.map((row) => row.id);
      if (collection && ids.length && !(await this.vectors.contains(collection, ids)))
        throw this.unready();
      hash.update(ids.join(''));
      count += ids.length;
      if (ids.length < 200) return { hash: hash.digest('hex'), count };
      after = ids.at(-1);
    }
  }

  /** 评估只统计现行有效、带正文的记忆版本。 */
  private eligible(ownerId: string) {
    return and(
      eq(memoryEntries.ownerId, ownerId),
      ne(memoryEntries.status, 'invalidated'),
      isNull(memoryVersions.invalidatedAt),
      isNotNull(memoryVersions.document),
    );
  }

  /** 读取主库当前应索引数。 */
  private async countEligible(ownerId: string) {
    const [row] = await this.database.sql
      .select({ total: sql<number>`count(*)` })
      .from(memoryEntries)
      .innerJoin(memoryVersions, eq(memoryVersions.id, memoryEntries.currentVersionId))
      .where(this.eligible(ownerId));
    return Number(row?.total ?? 0);
  }

  /** 统计已有向量记录和待删除旧版本。 */
  private async countIndexed(ownerId: string, space: string) {
    const [row] = await this.database.sql
      .select({
        current: sql<number>`sum(case when ${this.eligible(ownerId)} and ${memoryEntries.currentVersionId} = ${memoryVectorIndexes.versionId} and ${memoryVectorIndexes.status} = 'indexed' then 1 else 0 end)`,
        stale: sql<number>`sum(case when (${memoryVersions.invalidatedAt} is not null or ${memoryEntries.currentVersionId} <> ${memoryVectorIndexes.versionId} or ${memoryEntries.status} = 'invalidated') and ${memoryVectorIndexes.status} <> 'deleted' then 1 else 0 end)`,
      })
      .from(memoryVectorIndexes)
      .innerJoin(memoryEntries, eq(memoryEntries.id, memoryVectorIndexes.memoryId))
      .innerJoin(memoryVersions, eq(memoryVersions.id, memoryVectorIndexes.versionId))
      .where(and(eq(memoryVectorIndexes.ownerId, ownerId), eq(memoryVectorIndexes.space, space)));
    return { current: Number(row?.current ?? 0), stale: Number(row?.stale ?? 0) };
  }

  /** 只有可调用的真实编码进入向量登记。 */
  private configuredSpace(current: ModelConfigurationVersion) {
    const task = current.config.tasks.embedding;
    return this.config.retrievalConfiguration?.vectorEnabled !== false &&
      task.enabled &&
      task.providerId !== 'test'
      ? embeddingSpace(task, this.config)
      : null;
  }

  /** 查找一次仍可复验的切换结果。 */
  private async replay(ownerId: string, requestId: string, hash: string, tx: DatabaseTransaction) {
    const [row] = await tx
      .select()
      .from(memoryEmbeddingSelections)
      .where(
        and(
          eq(memoryEmbeddingSelections.ownerId, ownerId),
          eq(memoryEmbeddingSelections.requestId, requestId),
        ),
      )
      .limit(1);
    if (row && row.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
    return row;
  }

  /** 查询当前选择历史的末尾。 */
  private async selection(
    ownerId: string,
    client: DatabaseTransaction | DatabaseService['sql'] = this.database.sql,
  ) {
    const [row] = await client
      .select()
      .from(memoryEmbeddingSelections)
      .where(eq(memoryEmbeddingSelections.ownerId, ownerId))
      .orderBy(desc(memoryEmbeddingSelections.version))
      .limit(1);
    return row ?? null;
  }

  /** 查询目标空间的不可混用编码身份。 */
  private async registration(
    ownerId: string,
    space: string,
    client: DatabaseTransaction | DatabaseService['sql'] = this.database.sql,
  ) {
    const [row] = await client
      .select()
      .from(memoryEmbeddingSpaces)
      .where(
        and(eq(memoryEmbeddingSpaces.ownerId, ownerId), eq(memoryEmbeddingSpaces.space, space)),
      )
      .limit(1);
    return row;
  }

  /** 返回已经落地的切换结果。 */
  private toSwitch(row: Selection): SwitchedEmbedding {
    return {
      version: row.version,
      space: row.space,
      previous: row.previous,
      evaluationNote: row.evaluationNote,
      switchedAt: row.createdAt.toISOString(),
    };
  }

  /** 构建期间保留现有查询空间，完成后可重试同一命令。 */
  private unready() {
    return new ApiException(API_CODES.CONFLICT, '向量构建或删除同步尚未完成，请复核后重试。');
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type {
  ReflectionContext,
  ReflectionFinding,
  ReflectionFindingList,
  ReflectionHistoryQuery,
  ReflectionQuery,
  ReflectionRunList,
} from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  conversationMembers,
  reflectionFindings,
  reflectionRunMessages,
  reflectionRuns,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireCompanionMember } from '../conversations/conversation-access';
import { lexicalTerms } from '../retrieval/retrieval-lexical';
import { TaskStore } from '../tasks/task-store';
import { reflectionOriginals } from './reflection-input';
import type { OriginalRef } from './reflection-input';
import { accessError } from './reflection-planning';

type Member = typeof conversationMembers.$inferSelect;
type Finding = typeof reflectionFindings.$inferSelect;

/** 公开轮次与实际采用查询，所有内容均在原访问范围内返回。 */
@Injectable()
export class ReflectionService {
  /** 初始化反思轮次与历史查询。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
  ) {}

  /** 查询当前范围的轮次、任务状态与实际采用数量。 */
  runs(ownerId: string, companionId: string, query: ReflectionQuery): Promise<ReflectionRunList> {
    return this.store.locked(ownerId, async (tx) => {
      const member = await requireCompanionMember(
        this.database,
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      const rows = await tx
        .select({ run: reflectionRuns, job: { status: tasks.status, reason: tasks.reason } })
        .from(reflectionRuns)
        .innerJoin(tasks, and(eq(tasks.ownerId, ownerId), eq(tasks.id, reflectionRuns.id)))
        .where(
          and(
            eq(reflectionRuns.ownerId, ownerId),
            eq(reflectionRuns.companionId, companionId),
            eq(reflectionRuns.runtimeEpoch, query.runtimeEpoch),
            eq(reflectionRuns.conversationId, query.conversationId),
            query.afterId ? gt(reflectionRuns.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(reflectionRuns.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items = [];
      for (const { run, job } of page) {
        const available =
          !run.invalidatedAt && (!run.result || (await this.visibleSources(member, run.id, tx)));
        const result = available ? run.result : null;
        items.push({
          id: run.id,
          companionId,
          scope: { runtimeEpoch: run.runtimeEpoch, conversationId: run.conversationId },
          status: job.status,
          reason: available ? job.reason : 'reflection_source_changed',
          eventCount: run.eventCount,
          mode: run.mode,
          conclusion: result?.conclusion ?? null,
          adopted: result?.adopted ?? 0,
          observing: result?.observing ?? 0,
          rejected: result?.rejected ?? 0,
          completedAt: run.completedAt?.toISOString() ?? null,
          createdAt: run.createdAt.toISOString(),
        });
      }
      return { items, nextAfterId: rows.length > query.limit ? page.at(-1)!.run.id : null };
    });
  }

  /** 返回有来源的现行认识、自传与观察候选。 */
  findings(
    ownerId: string,
    companionId: string,
    query: ReflectionQuery,
  ): Promise<ReflectionFindingList> {
    return this.store.locked(ownerId, async (tx) => {
      const member = await requireCompanionMember(
        this.database,
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      const rows = await tx
        .select()
        .from(reflectionFindings)
        .where(
          and(
            eq(reflectionFindings.ownerId, ownerId),
            eq(reflectionFindings.companionId, companionId),
            eq(reflectionFindings.runtimeEpoch, query.runtimeEpoch),
            eq(reflectionFindings.conversationId, query.conversationId),
            ne(reflectionFindings.status, 'historical'),
            query.afterId ? gt(reflectionFindings.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(reflectionFindings.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items = await this.toFindings(member, page, tx);
      return { items, nextAfterId: rows.length > query.limit ? page.at(-1)!.id : null };
    });
  }

  /** 回查同一认识或自传的修订历史。 */
  history(ownerId: string, companionId: string, rootId: string, query: ReflectionHistoryQuery) {
    return this.store.locked(ownerId, async (tx) => {
      const [root] = await tx
        .select()
        .from(reflectionFindings)
        .where(
          and(
            eq(reflectionFindings.ownerId, ownerId),
            eq(reflectionFindings.companionId, companionId),
            eq(reflectionFindings.rootId, rootId),
            eq(reflectionFindings.version, 1),
          ),
        )
        .limit(1);
      if (!root) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      const member = await requireCompanionMember(
        this.database,
        ownerId,
        companionId,
        root.runtimeEpoch,
        root.conversationId,
        tx,
      );
      const rows = await tx
        .select()
        .from(reflectionFindings)
        .where(
          and(
            eq(reflectionFindings.ownerId, ownerId),
            eq(reflectionFindings.rootId, rootId),
            query.beforeVersion ? lt(reflectionFindings.version, query.beforeVersion) : undefined,
          ),
        )
        .orderBy(desc(reflectionFindings.version))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        items: await this.toFindings(member, page, tx),
        nextBeforeVersion: rows.length > query.limit ? page.at(-1)!.version : null,
      };
    });
  }

  /** 按本轮信息选择少量确切相关且仍有效的反思认识。 */
  async snapshot(
    member: Member,
    mode: 'test' | 'model',
    query: string,
    tx: DatabaseTransaction,
  ): Promise<ReflectionContext[]> {
    const terms = new Set(lexicalTerms(query));
    if (!terms.size) return [];
    const rows = await tx
      .select()
      .from(reflectionFindings)
      .where(
        and(
          eq(reflectionFindings.ownerId, member.ownerId),
          eq(reflectionFindings.companionId, member.companionId!),
          eq(reflectionFindings.runtimeEpoch, member.runtimeEpoch!),
          eq(reflectionFindings.conversationId, member.conversationId),
          eq(reflectionFindings.mode, mode),
          eq(reflectionFindings.status, 'current'),
        ),
      )
      .orderBy(desc(reflectionFindings.createdAt), asc(reflectionFindings.id))
      .limit(24);
    const ranked = rows
      .filter((row) => row.document)
      .map((row) => ({
        row,
        matches: lexicalTerms(
          `${row.topic} ${row.document!.interpretation} ${row.document!.account}`,
        ).filter((term) => terms.has(term)).length,
      }))
      .filter(({ matches }) => matches > 0)
      .sort((first, second) => second.matches - first.matches);
    const current: ReflectionContext[] = [];
    for (const { row } of ranked) {
      if (current.length >= 3) break;
      const sources = await this.visibleSources(member, row.runId, tx);
      if (!sources) continue;
      const { interpretation, applicability, uncertainty } = row.document!;
      current.push({
        versionId: row.id,
        kind: row.kind,
        interpretation,
        applicability,
        uncertainty,
        sources,
      });
    }
    return current;
  }

  /** 仍可访问的历史版本可完成当前聊天，已失效的依据立刻停止发布。 */
  async validateSnapshot(
    member: Member,
    contexts: ReflectionContext[],
    tx: DatabaseTransaction,
  ): Promise<void> {
    for (const item of contexts) {
      const [record] = await tx
        .select({ runId: reflectionFindings.runId })
        .from(reflectionFindings)
        .where(
          and(
            eq(reflectionFindings.ownerId, member.ownerId),
            eq(reflectionFindings.id, item.versionId),
            eq(reflectionFindings.companionId, member.companionId!),
            eq(reflectionFindings.runtimeEpoch, member.runtimeEpoch!),
            eq(reflectionFindings.conversationId, member.conversationId),
            ne(reflectionFindings.status, 'invalidated'),
          ),
        )
        .limit(1);
      if (!record || !(await this.visibleSources(member, record.runId, tx)))
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    }
  }

  /** 显示状态及安全的内容，来源失效后不呈现原文和推断。 */
  private async toFindings(
    member: Member,
    rows: Finding[],
    tx: DatabaseTransaction,
  ): Promise<ReflectionFinding[]> {
    const adopted = [];
    for (const row of rows) {
      const available =
        row.status !== 'invalidated' &&
        Boolean(row.document) &&
        (await this.visibleSources(member, row.runId, tx));
      adopted.push({
        id: row.rootId,
        versionId: row.id,
        topic: available ? row.topic : 'redacted',
        kind: row.kind,
        version: row.version,
        status: available ? row.status : ('invalidated' as const),
        mode: row.mode,
        document: available ? row.document : null,
        evidence: available ? (row.evidence ?? []) : [],
        createdAt: row.createdAt.toISOString(),
      });
    }
    return adopted;
  }

  /** 从实际输入反查原文权限，失效的派生记录不能继续读取。 */
  private async visibleSources(
    member: Member,
    runId: string,
    tx: DatabaseTransaction,
  ): Promise<OriginalRef[] | null> {
    const [run] = await tx
      .select({ id: reflectionRuns.id })
      .from(reflectionRuns)
      .where(
        and(
          eq(reflectionRuns.ownerId, member.ownerId),
          eq(reflectionRuns.id, runId),
          isNull(reflectionRuns.invalidatedAt),
        ),
      )
      .limit(1);
    if (!run) return null;
    const refs = await tx
      .select({
        messageId: reflectionRunMessages.messageId,
        contentVersion: reflectionRunMessages.contentVersion,
      })
      .from(reflectionRunMessages)
      .where(
        and(
          eq(reflectionRunMessages.ownerId, member.ownerId),
          eq(reflectionRunMessages.runId, runId),
        ),
      );
    try {
      await reflectionOriginals(member, refs, tx);
      return refs;
    } catch (error) {
      if (!accessError(error)) throw error;
      return null;
    }
  }
}

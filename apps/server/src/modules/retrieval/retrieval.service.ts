import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, ne, isNotNull } from 'drizzle-orm';
import { retrievalConfigurationSchema } from '@memory-weave/contracts';
import type { RecallQuery, RecallResult, RecallSource } from '@memory-weave/contracts';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import {
  conversationMembers,
  conversations,
  messages,
  processingRanges,
  memoryVectorIndexes,
} from '../../database/schema';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { TaskStore } from '../tasks/task-store';
import { recallConversationScope } from './retrieval-access';
import { recallCandidates } from './retrieval-candidates';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import {
  embeddingDefinition,
  embeddingSpace,
  vectorCollection,
  RetrievalVector,
} from './retrieval-vector';
import type { ModelDispatchGuard } from '../models/model-task';

/** 查询与回复共用入口；未整理补读独立于向量索引和其他实例进度。 */
@Injectable()
export class RetrievalService {
  constructor(
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(RetrievalVector) private readonly vectors: RetrievalVector,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(SERVER_CONFIG) private readonly config: RuntimeConfig,
  ) {}
  /** 取得授权范围内的新原文，超过预算时明确标记覆盖不足。 */
  async recall(
    companionId: string,
    query: RecallQuery,
    guard?: ModelDispatchGuard,
  ): Promise<RecallResult> {
    const limits = this.config.retrievalConfiguration ?? retrievalConfigurationSchema.parse({});
    const configuration = await this.configuration.get();
    const embedding = configuration.config.tasks.embedding;
    const space = embeddingSpace(embedding, this.config);
    const available = await this.store.locked(async (ownerId, tx) => {
      if (guard) await guard(ownerId, tx);
      const scope = await recallConversationScope(
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      const rows = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, ownerId),
            isNull(conversations.lifecycleOperationId),
            scope,
          ),
        )
        .limit(201);
      const [blocked] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerId, ownerId),
            isNotNull(conversations.lifecycleOperationId),
            scope,
          ),
        )
        .limit(1);
      const [indexed] = await tx
        .select({ id: memoryVectorIndexes.id })
        .from(memoryVectorIndexes)
        .where(
          and(
            eq(memoryVectorIndexes.ownerId, ownerId),
            eq(memoryVectorIndexes.companionId, companionId),
            eq(memoryVectorIndexes.runtimeEpoch, query.runtimeEpoch),
            eq(memoryVectorIndexes.space, space),
            eq(memoryVectorIndexes.status, 'indexed'),
          ),
        )
        .limit(1);
      return {
        ownerId,
        conversations: rows.slice(0, 200).map((row) => row.id),
        limited: rows.length > 200,
        indexed: Boolean(indexed),
        blocked: Boolean(blocked),
      };
    });
    let vector: RecallResult['coverage']['vector'] =
      embedding.providerId === 'test' ? 'test' : 'disabled';
    let vectorIds: string[] = [];
    if (
      limits.vectorEnabled &&
      embedding.enabled &&
      embedding.providerId !== 'test' &&
      !query.memoryId &&
      !/^(?:嗯+|好(?:的)?|ok|谢谢|哈哈+)[。！!~\s]*$/iu.test(query.query)
    ) {
      vector = available.indexed ? 'unavailable' : 'building';
      if (available.indexed)
        try {
          const call = await this.models.execute(
            {
              requestId: query.requestId,
              expectedConfigVersion: configuration.version,
              role: 'embedding',
              operation: 'embedding',
              lane: 'interactive',
              inputText: query.context
                ? JSON.stringify({ query: query.query, context: query.context })
                : query.query,
            },
            embeddingDefinition(embedding),
            { companionId, runtimeEpoch: query.runtimeEpoch, conversationId: query.conversationId },
            async (ownerId, tx) => {
              if (guard) await guard(ownerId, tx);
              await recallConversationScope(
                ownerId,
                companionId,
                query.runtimeEpoch,
                query.conversationId,
                tx,
              );
            },
          );
          if (call.status === 'succeeded' && call.result?.kind === 'embedding') {
            const scope = {
              owner: available.ownerId,
              companion: companionId,
              epoch: query.runtimeEpoch,
              space,
              conversations: available.conversations,
            };
            vectorIds = await this.vectors.query(
              vectorCollection(available.ownerId, space),
              call.result.vector,
              scope,
              limits.candidates,
              limits.vectorSearchMode === 'exact',
            );
            if (limits.vectorSearchMode === 'ann' && vectorIds.length < limits.results)
              vectorIds = await this.vectors.query(
                vectorCollection(available.ownerId, space),
                call.result.vector,
                scope,
                limits.candidates,
                true,
              );
            vector = 'ready';
          } else if (call.status === 'unknown' || call.status === 'running') vector = 'unknown';
        } catch {
          vector = 'unavailable';
        }
    }
    return this.store.locked(async (ownerId, tx) => {
      if (guard) await guard(ownerId, tx);
      const scope = await recallConversationScope(
        ownerId,
        companionId,
        query.runtimeEpoch,
        query.conversationId,
        tx,
      );
      const rows = await tx
        .select({ message: messages, speaker: conversationMembers.kind })
        .from(processingRanges)
        .innerJoin(
          messages,
          and(
            eq(messages.id, processingRanges.messageId),
            eq(messages.contentVersion, processingRanges.contentVersion),
          ),
        )
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(conversationMembers, eq(conversationMembers.id, messages.speakerMembershipId))
        .where(
          and(
            eq(processingRanges.ownerId, ownerId),
            eq(processingRanges.companionId, companionId),
            eq(processingRanges.runtimeEpoch, query.runtimeEpoch),
            ne(processingRanges.status, 'processed'),
            eq(messages.state, 'published'),
            isNull(messages.deletedAt),
            isNull(conversations.lifecycleOperationId),
            scope,
          ),
        )
        .orderBy(desc(messages.receivedAt), desc(messages.sequence), desc(messages.id))
        .limit(limits.pendingMessages + 1);
      const pending: RecallSource[] = [];
      let characters = 0;
      let complete = rows.length <= limits.pendingMessages;
      for (const { message, speaker } of rows.slice(0, limits.pendingMessages)) {
        const member = await requireCompanionMember(
          ownerId,
          companionId,
          query.runtimeEpoch,
          message.conversationId,
          tx,
        );
        await assertVisible(member, message.sequence!, tx);
        if (characters + message.text.length > limits.pendingCharacters) {
          complete = false;
          continue;
        }
        characters += message.text.length;
        pending.push({
          conversationId: message.conversationId,
          messageId: message.id,
          contentVersion: message.contentVersion,
          sequence: message.sequence!,
          text: message.text,
          sourceKind: message.sourceKind,
          reality: message.reality,
          speaker,
          permissionVersion: member.permissionVersion,
          receivedAt: message.receivedAt.toISOString(),
          occurredAt: message.occurredAt?.toISOString() ?? null,
        });
      }
      const candidates = await recallCandidates(
        ownerId,
        companionId,
        query,
        scope,
        limits,
        tx,
        vectorIds,
      );
      return {
        memories: candidates.memories,
        pending: pending.reverse(),
        coverage: {
          pendingComplete: complete && !available.blocked,
          candidateLimitReached: candidates.limited || available.limited,
          vector,
        },
      };
    });
  }
}

import { API_CODES, recallResultSchema } from '@memory-weave/contracts';
import type { ChatContext, ModelConfigurationVersion, RecallResult } from '@memory-weave/contracts';
import { Injectable } from '@nestjs/common';
import { isNull, and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import {
  chatRuns,
  conversationMembers,
  messages,
  owners,
  personaVersions,
  personaFoundations,
  readReceipts,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import {
  assertVisible,
  requireCompanion,
  requireCompanionMember,
} from '../conversations/conversation-access';
import { modelInputReservation } from '../models/model-runtime.service';
import { chatDefinition, chatDefinitionV1 } from './chat-definition';
import { validateRecallSnapshot } from '../retrieval/retrieval-snapshot';
import type { TaskLease } from '../tasks/task-types';

/** 选取有界的当前会话原文，固定来源后才能派发模型；不依赖记忆整理。 */
@Injectable()
export class ChatContextService {
  /**
   * 创建或恢复同一轮的精确上下文，后续恢复不重新抽样或混入新消息。
   * @param ownerId 部署归属。
   * @param tx 已持有调度与当前会话锁的事务。
   * @param lease 当前运行租约。
   * @param run 本轮持久记录。
   * @param config 当前模型配置；首次构建用于预算校验。
   * @returns 固定来源及可重建的模型输入。
   */
  async prepare(
    ownerId: string,
    tx: DatabaseTransaction,
    lease: TaskLease,
    run: typeof chatRuns.$inferSelect,
    config: ModelConfigurationVersion,
    recall?: RecallResult,
  ): Promise<{ context: ChatContext; inputText: string }> {
    const scope = lease.task.scope;
    const companion = await requireCompanion(ownerId, scope.companionId!, scope.runtimeEpoch!, tx);
    const member = await requireCompanionMember(
      ownerId,
      companion.id,
      scope.runtimeEpoch!,
      scope.conversationId!,
      tx,
    );
    if (!companion.currentPersonaVersionId) throw new ApiException(API_CODES.DATA_UNAVAILABLE);
    const context = run.context;
    if (context?.recall) await validateRecallSnapshot(ownerId, scope, context.recall, tx);
    if (recall) await validateRecallSnapshot(ownerId, scope, recall, tx);
    const [persona] = await tx
      .select()
      .from(personaVersions)
      .where(
        and(
          eq(personaVersions.ownerId, ownerId),
          eq(personaVersions.companionId, companion.id),
          eq(personaVersions.runtimeEpoch, scope.runtimeEpoch!),
          eq(personaVersions.id, context?.personaVersionId ?? companion.currentPersonaVersionId),
        ),
      );
    if (!persona) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    const [foundation] = !persona.document
      ? await tx
          .select()
          .from(personaFoundations)
          .where(
            and(
              eq(personaFoundations.ownerId, ownerId),
              eq(personaFoundations.companionId, companion.id),
              eq(personaFoundations.runtimeEpoch, scope.runtimeEpoch!),
            ),
          )
      : [];

    const rows = context
      ? await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.ownerId, ownerId),
              eq(messages.conversationId, scope.conversationId!),
              inArray(
                messages.id,
                context.sources.map((source) => source.messageId),
              ),
            ),
          )
          .orderBy(asc(messages.sequence))
      : (
          await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.ownerId, ownerId),
                eq(messages.conversationId, scope.conversationId!),
                eq(messages.state, 'published'),
                isNull(messages.deletedAt),
              ),
            )
            .orderBy(desc(messages.sequence))
            .limit(run.configuration.historyMessages)
        ).reverse();
    for (const row of rows) {
      if (row.deletedAt || row.sequence === null || row.state !== 'published')
        throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      await assertVisible(member, row.sequence, tx);
    }
    if (
      context &&
      (rows.length !== context.sources.length ||
        rows.some(
          (row, index) =>
            row.id !== context.sources[index]?.messageId ||
            row.contentVersion !== context.sources[index]?.contentVersion,
        ))
    )
      throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    const members = await tx
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.ownerId, ownerId),
          eq(conversationMembers.conversationId, scope.conversationId!),
        ),
      );
    const [owner] = await tx.select().from(owners).where(eq(owners.id, ownerId));
    const selected = [...rows];
    if (!context) {
      // 最近页可能从旧回复的中间开始；丢弃没有对应用户发言的旧片段。
      while (
        selected.length &&
        selected[0]!.sequence! < run.firstUserSequence &&
        members.find((item) => item.id === selected[0]!.speakerMembershipId)?.kind !== 'user'
      )
        selected.shift();
    }
    const snapshot: ChatContext = context ?? {
      ...(recall ? { recall: structuredClone(recall) } : {}),
      personaVersionId: persona.id,
      explicitLocks: persona.document ? [] : (foundation?.explicitLocks ?? []),
      sources: [],
      omittedThroughSequence: Math.max(0, (selected[0]?.sequence ?? 1) - 1),
      environment: 'web',
      userName: owner!.displayName,
    };
    // MySQL JSON 会调整字段顺序；每次按同一 schema 重建新格式，确保恢复时 inputText 字节一致。
    if (snapshot.recall) snapshot.recall = recallResultSchema.parse(snapshot.recall);
    const assemble = (): string =>
      JSON.stringify({
        ...(snapshot.recall ? { recall: snapshot.recall } : {}),
        persona: {
          name: persona.document?.name ?? companion.name,
          document: persona.document,
          originalProfile: persona.document ? null : persona.profileText,
          ...(snapshot.explicitLocks === undefined
            ? {}
            : { explicitLocks: snapshot.explicitLocks }),
        },
        userName: snapshot.userName,
        environment: { terminal: 'web', tools: [] },
        currentInputFromSequence: run.firstUserSequence,
        omittedThroughSequence: snapshot.omittedThroughSequence,
        messages: selected.map((row) => ({
          id: row.id,
          contentVersion: row.contentVersion,
          sequence: row.sequence,
          role:
            members.find((item) => item.id === row.speakerMembershipId)?.kind === 'user'
              ? 'user'
              : 'assistant',
          text: row.text,
        })),
      });
    let inputText = assemble();
    if (!context) {
      // 必须保留当前待回应的交流；旧历史只移除完整的用户发言及其后续回复。
      if (!selected.some((row) => row.sequence === run.firstUserSequence))
        throw new ApiException(API_CODES.CHAT_CONTEXT_LIMIT);
      while (
        modelInputReservation(
          inputText,
          config.config.tasks.chat.promptVersion === 'chat-v1' ? chatDefinitionV1 : chatDefinition,
          'text',
        ) > config.config.tasks.chat.maxInputTokens ||
        inputText.length > 65536
      ) {
        const next = selected.findIndex(
          (row, index) =>
            index > 0 &&
            members.find((item) => item.id === row.speakerMembershipId)?.kind === 'user' &&
            (row.sequence === run.firstUserSequence ||
              members.find((item) => item.id === selected[index - 1]!.speakerMembershipId)?.kind ===
                'companion'),
        );
        if (
          next < 0 ||
          selected[0]!.sequence! >= run.firstUserSequence ||
          selected[next - 1]!.sequence! >= run.firstUserSequence
        ) {
          if (snapshot.recall?.memories.length) {
            snapshot.recall.memories.pop();
            snapshot.recall.coverage.candidateLimitReached = true;
            inputText = assemble();
            continue;
          }
          if (snapshot.recall?.pending.length) {
            snapshot.recall.pending.shift();
            snapshot.recall.coverage.pendingComplete = false;
            inputText = assemble();
            continue;
          }
          throw new ApiException(API_CODES.CHAT_CONTEXT_LIMIT);
        }
        snapshot.omittedThroughSequence = selected[next - 1]!.sequence!;
        selected.splice(0, next);
        inputText = assemble();
      }
      snapshot.sources = selected.map((row) => ({
        messageId: row.id,
        contentVersion: row.contentVersion,
      }));
    }
    if (selected.length)
      await tx
        .insert(readReceipts)
        .values(
          selected.map((row) => ({
            ownerId,
            companionId: companion.id,
            runtimeEpoch: scope.runtimeEpoch!,
            conversationId: scope.conversationId!,
            messageId: row.id,
            contentVersion: row.contentVersion,
            startOffset: 0,
            endOffset: row.text.length,
          })),
        )
        .onDuplicateKeyUpdate({ set: { id: sql`${readReceipts.id}` } });
    if (snapshot.recall?.pending.length)
      await tx
        .insert(readReceipts)
        .values(
          snapshot.recall.pending.map((source) => ({
            ownerId,
            companionId: companion.id,
            runtimeEpoch: scope.runtimeEpoch!,
            conversationId: source.conversationId,
            messageId: source.messageId,
            contentVersion: source.contentVersion,
            startOffset: 0,
            endOffset: source.text.length,
          })),
        )
        .onDuplicateKeyUpdate({ set: { id: sql`${readReceipts.id}` } });
    if (snapshot.recall?.querySources?.length)
      await tx
        .insert(readReceipts)
        .values(
          snapshot.recall.querySources.map((source) => ({
            ownerId,
            companionId: companion.id,
            runtimeEpoch: scope.runtimeEpoch!,
            conversationId: source.conversationId,
            messageId: source.messageId,
            contentVersion: source.contentVersion,
            startOffset: source.startOffset,
            endOffset: source.endOffset,
          })),
        )
        .onDuplicateKeyUpdate({ set: { id: sql`${readReceipts.id}` } });
    return { context: snapshot, inputText };
  }
}

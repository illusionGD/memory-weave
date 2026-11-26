import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import type { ContactIntent, ContactIntents, IdPaginationQuery } from '@memory-weave/contracts';
import { and, asc, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { contactIntents, conversations, messages } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { ConversationsService } from '../conversations/conversations.service';
import { requireConversation } from '../conversations/conversation-access';
import { TaskStore } from '../tasks/task-store';
import { AutonomyBudget } from './autonomy-budget';
import {
  autonomyScopeUnavailable,
  currentAutonomyPolicy,
  requireAutonomyScope,
} from './autonomy-policy';

type Intent = typeof contactIntents.$inferSelect;

/** 联系意向先持久保存，实际发布是用户级配额的一次事务。 */
@Injectable()
export class AutonomyContacts {
  /** 初始化用户级联系与交付确认。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(AutonomyBudget) private readonly budget: AutonomyBudget,
    @Inject(ConversationsService) private readonly originals: ConversationsService,
  ) {}

  /** 选择一个仍有效的意向，静默结束后避免集中补发。 */
  async deliver(ownerId: string): Promise<void> {
    if (!this.budget.limits.enabled) return;
    await this.store.locked(ownerId, async (tx, now) => {
      const waiting = await tx
        .select()
        .from(contactIntents)
        .where(and(eq(contactIntents.ownerId, ownerId), eq(contactIntents.state, 'pending')))
        .orderBy(asc(contactIntents.createdAt), asc(contactIntents.id))
        .limit(12);
      if (!waiting.length) return;
      const restriction = await this.restriction(ownerId, now, tx);
      for (const item of waiting) {
        if (item.expiresAt <= now) {
          await this.change(item, { state: 'expired', reason: 'contact_expired', text: null }, tx);
          continue;
        }
        const policy = await currentAutonomyPolicy(
          ownerId,
          item.companionId,
          item.runtimeEpoch,
          tx,
        );
        if (
          !policy?.enabled ||
          !policy.contactsEnabled ||
          policy.version !== item.policyVersion ||
          policy.conversationId !== item.conversationId ||
          !item.text
        ) {
          await this.change(
            item,
            { state: 'cancelled', reason: 'contact_permission_changed', text: null },
            tx,
          );
          continue;
        }
        let available;
        try {
          available = await requireAutonomyScope(this.database, policy, tx);
        } catch (error) {
          if (!autonomyScopeUnavailable(error)) throw error;
          await this.change(
            item,
            { state: 'cancelled', reason: 'contact_scope_changed', text: null },
            tx,
          );
          continue;
        }
        const { conversation, user } = available;
        const latest = await latestUserMessage(ownerId, item.conversationId, user.id, tx);
        if (
          (latest?.id ?? null) !== item.sourceMessageId ||
          (latest?.contentVersion ?? null) !== item.sourceContentVersion
        ) {
          await this.change(
            item,
            { state: 'cancelled', reason: 'contact_context_changed', text: null },
            tx,
          );
          continue;
        }
        const thread = await this.database.chatThreads.findOne(
          ownerId,
          { where: { conversationId: item.conversationId } },
          tx,
        );
        const job = thread?.currentRunId
          ? await this.database.tasks.findById(ownerId, thread.currentRunId, tx)
          : null;
        const busy = job && ['queued', 'running', 'waiting'].includes(job.status);
        const reason = restriction ?? (busy ? 'contact_conversation_busy' : null);
        if (reason) {
          if (item.reason !== reason) await this.change(item, { reason }, tx);
          continue;
        }
        const draft = await this.originals.saveInTransaction(
          ownerId,
          tx,
          item.conversationId,
          {
            requestId: item.id,
            expectedConversationVersion: conversation.version,
            speaker: {
              kind: 'companion',
              companionId: item.companionId,
              runtimeEpoch: item.runtimeEpoch,
            },
            text: item.text,
            epistemicKind: 'statement',
            reality: 'unspecified',
            sources: latest
              ? [
                  {
                    messageId: latest.id,
                    contentVersion: latest.contentVersion,
                    relation: 'reference',
                  },
                ]
              : [],
          },
          true,
        );
        const published = await this.originals.publishInTransaction(
          ownerId,
          tx,
          item.conversationId,
          draft.id,
          {
            requestId: item.id,
            expectedConversationVersion: conversation.version,
            expectedRevision: draft.revision,
          },
        );
        await this.budget.record(ownerId, 'contact', null, item.id, now, tx);
        await this.change(
          item,
          {
            state: 'published',
            reason: null,
            publishedAt: now,
            messageId: published.id,
            text: null,
          },
          tx,
        );
        return;
      }
    });
  }

  /** 查询发送、等待、过期与实际确认。 */
  list(ownerId: string, query: IdPaginationQuery): Promise<ContactIntents> {
    return this.store.locked(ownerId, async (tx) => {
      const rows = await tx
        .select({ item: contactIntents, restricted: conversations.lifecycleOperationId })
        .from(contactIntents)
        .innerJoin(
          conversations,
          and(
            eq(conversations.ownerId, ownerId),
            eq(conversations.id, contactIntents.conversationId),
          ),
        )
        .where(
          and(
            eq(contactIntents.ownerId, ownerId),
            query.afterId ? gt(contactIntents.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(contactIntents.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        items: page.map(({ item, restricted }) =>
          contactView(restricted ? { ...item, explanation: null } : item),
        ),
        nextAfterId: rows.length > query.limit ? page.at(-1)!.item.id : null,
      };
    });
  }

  /** 确认已发布的联系，重复回执沿用首次确认时间。 */
  acknowledge(ownerId: string, id: string): Promise<ContactIntent> {
    return this.store.locked(ownerId, async (tx, now) => {
      const [item] = await tx
        .select()
        .from(contactIntents)
        .where(and(eq(contactIntents.ownerId, ownerId), eq(contactIntents.id, id)))
        .limit(1);
      if (!item) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      await requireConversation(ownerId, item.conversationId, tx);
      if (item.state === 'acknowledged') return contactView(item);
      if (item.state !== 'published') throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
      await this.change(item, { state: 'acknowledged', acknowledgedAt: now }, tx);
      return contactView({ ...item, state: 'acknowledged', acknowledgedAt: now });
    });
  }

  /** 查用户跨实例和终端共享的联系频率及未回复冷却。 */
  private async restriction(
    ownerId: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<string | null> {
    if (this.budget.quiet(now)) return 'contact_quiet_hours';
    if (
      (await this.budget.count(ownerId, 'contact', null, now, tx)) >=
      this.budget.limits.contactsPerDay
    )
      return 'contact_daily_limit';
    const [latest] = await tx
      .select()
      .from(contactIntents)
      .where(and(eq(contactIntents.ownerId, ownerId), isNotNull(contactIntents.publishedAt)))
      .orderBy(desc(contactIntents.publishedAt), desc(contactIntents.id))
      .limit(1);
    if (!latest?.publishedAt) return null;
    const elapsed = now.getTime() - latest.publishedAt.getTime();
    if (elapsed < this.budget.limits.contactIntervalMs) return 'contact_cooldown';
    if (elapsed >= this.budget.limits.unansweredIntervalMs) return null;
    const user = await this.database.conversationMembers.findOne(
      ownerId,
      {
        where: { conversationId: latest.conversationId, kind: 'user', userId: ownerId },
      },
      tx,
    );
    const lastUser = user
      ? await latestUserMessage(ownerId, latest.conversationId, user.id, tx)
      : null;
    const sent = latest.messageId
      ? await this.database.messages.findById(ownerId, latest.messageId, tx)
      : null;
    return (lastUser?.sequence ?? 0) > (sent?.sequence ?? Number.MAX_SAFE_INTEGER)
      ? null
      : 'contact_awaiting_reply';
  }

  /** 保存具体意向变化及其发送记录。 */
  private async change(
    item: Intent,
    set: Partial<
      Pick<Intent, 'state' | 'reason' | 'text' | 'publishedAt' | 'messageId' | 'acknowledgedAt'>
    >,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .update(contactIntents)
      .set(set)
      .where(and(eq(contactIntents.ownerId, item.ownerId), eq(contactIntents.id, item.id)));
  }
}

/** 真正来自用户的最新已发布原文，用于识别已经继续的交流。 */
export async function latestUserMessage(
  ownerId: string,
  conversationId: string,
  membershipId: string,
  tx: DatabaseTransaction,
) {
  const [row] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.ownerId, ownerId),
        eq(messages.conversationId, conversationId),
        eq(messages.speakerMembershipId, membershipId),
        eq(messages.state, 'published'),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(desc(messages.sequence))
    .limit(1);
  return row;
}

/** 不提前公开尚未发布的文字。 */
function contactView(row: Intent): ContactIntent {
  return {
    id: row.id,
    companionId: row.companionId,
    conversationId: row.conversationId,
    state: row.state,
    reason: row.reason,
    explanation: row.explanation,
    messageId: row.messageId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  };
}

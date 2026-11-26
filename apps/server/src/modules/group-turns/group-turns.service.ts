import { Inject, Injectable } from '@nestjs/common';
import { API_CODES, publishedMessageSchema } from '@memory-weave/contracts';
import type {
  CreatedGroupTurn,
  GroupTurn,
  GroupTurnList,
  GroupTurnRequest,
  IdPaginationQuery,
  PublishedMessage,
} from '@memory-weave/contracts';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { groupTurnHeads, groupTurnSteps, groupTurns, messages } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { requireConversation, toMessage } from '../conversations/conversation-access';
import { ConversationsService } from '../conversations/conversations.service';
import { activeMemberships, requireOpenConversation } from '../conversations/membership-store';
import type { MemberRow } from '../conversations/membership-store';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { fingerprint } from '../shared/http';
import { TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';
import { interruptGroupTurn } from './group-turn-store';

type Turn = typeof groupTurns.$inferSelect;

/** 明确的发送命令才建立接话任务，历史查询只读取。 */
@Injectable()
export class GroupTurnsService {
  /** 初始化多参与者接话命令。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(ConversationsService) private readonly originals: ConversationsService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
  ) {}

  /** 发布本轮用户消息并登记最多一个会话有效接话任务。 */
  async send(
    ownerId: string,
    conversationId: string,
    command: GroupTurnRequest,
  ): Promise<CreatedGroupTurn> {
    const config = await this.configuration.get(ownerId);
    const requestId = command.requestId.toLowerCase();
    const hash = fingerprint({ ...command, requestId });
    return this.store.locked(ownerId, async (tx, now) => {
      const conversation = await requireOpenConversation(ownerId, conversationId, tx);
      if (conversation.kind !== 'group') throw new ApiException(API_CODES.INVALID_REQUEST);
      const [replay] = await tx
        .select()
        .from(groupTurns)
        .where(
          and(
            eq(groupTurns.ownerId, ownerId),
            eq(groupTurns.conversationId, conversationId),
            eq(groupTurns.requestId, requestId),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        const saved = await this.database.messages.findById(ownerId, replay.triggerMessageId, tx);
        if (!saved || saved.deletedAt) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
        return {
          message: publishedMessageSchema.parse(await toMessage(ownerId, this.database, saved, tx)),
          turn: await this.view(replay, tx),
        };
      }
      if (conversation.version !== command.expectedConversationVersion)
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const available = (await activeMemberships(ownerId, conversationId, tx)).filter(
        (member) => member.kind === 'companion',
      );
      const selected = await this.choose(
        ownerId,
        conversationId,
        command.addressing,
        available,
        tx,
      );
      if (!selected.length)
        throw new ApiException(API_CODES.CONFLICT, '当前会话没有可安排的伴侣。');
      const draft = await this.originals.saveInTransaction(ownerId, tx, conversationId, {
        requestId,
        expectedConversationVersion: conversation.version,
        speaker: { kind: 'user' },
        text: command.text,
        epistemicKind: 'statement',
        reality: 'unspecified',
        sources: [],
      });
      const message = publishedMessageSchema.parse(
        await this.originals.publishInTransaction(ownerId, tx, conversationId, draft.id, {
          requestId,
          expectedRevision: draft.revision,
          expectedConversationVersion: conversation.version,
        }),
      );
      const turn = await this.enqueue(
        ownerId,
        message,
        selected,
        {
          requestId,
          fingerprint: hash,
          origin: 'user',
          addressing: command.addressing.mode,
          version: config.version,
          mode: config.config.tasks.chat.providerId === 'test' ? 'test' : 'model',
        },
        tx,
        now,
      );
      return { message, turn: await this.view(turn, tx) };
    });
  }

  /** 在已经串行校验的会话内安排接话，支持后续自主行为复用。 */
  async enqueue(
    ownerId: string,
    trigger: PublishedMessage,
    selected: MemberRow[],
    metadata: Pick<Turn, 'requestId' | 'fingerprint' | 'origin' | 'addressing' | 'mode'> & {
      version: number;
    },
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<Turn> {
    const conversationId = trigger.conversationId;
    if (
      !selected.length ||
      selected.length > 20 ||
      trigger.ownerId !== ownerId ||
      selected.some(
        (member) =>
          member.conversationId !== conversationId ||
          member.ownerId !== ownerId ||
          member.kind !== 'companion' ||
          !member.companionId ||
          !member.runtimeEpoch,
      )
    )
      throw new ApiException(API_CODES.INVALID_REQUEST);
    const id = randomUUID();
    await interruptGroupTurn(ownerId, conversationId, now, tx, this.jobs);
    await this.database.tasks.insert(
      ownerId,
      {
        id,
        kind: metadata.origin === 'autonomous' ? 'peer_turn' : 'group_turn',
        input: { kind: 'group_turn', configVersion: metadata.version },
        requestKey: `group-turn:${conversationId}:${metadata.requestId}`,
        fingerprint: metadata.fingerprint,
        scope: { companionId: null, runtimeEpoch: null, conversationId },
        totalSteps: selected.length,
        availableAt: now,
      },
      tx,
    );
    const row = {
      id,
      ownerId,
      conversationId,
      requestId: metadata.requestId,
      fingerprint: metadata.fingerprint,
      triggerMessageId: trigger.id,
      triggerContentVersion: trigger.contentVersion,
      triggerSequence: trigger.sequence,
      origin: metadata.origin,
      addressing: metadata.addressing,
      mode: metadata.mode,
      interruptedAt: null,
      createdAt: now,
    };
    await tx.insert(groupTurns).values(row);
    await tx.insert(groupTurnSteps).values(
      selected.map((member, index) => ({
        ownerId,
        turnId: id,
        ordinal: index + 1,
        membershipId: member.id,
        companionId: member.companionId!,
        runtimeEpoch: member.runtimeEpoch!,
        status: 'pending' as const,
      })),
    );
    await tx
      .insert(groupTurnHeads)
      .values({ ownerId, conversationId, turnId: id })
      .onDuplicateKeyUpdate({ set: { turnId: id } });
    return row;
  }

  /** 查询会话各轮次的确切发言和等待状态。 */
  list(ownerId: string, conversationId: string, query: IdPaginationQuery): Promise<GroupTurnList> {
    return this.store.locked(ownerId, async (tx) => {
      await requireConversation(ownerId, conversationId, tx);
      const rows = await tx
        .select()
        .from(groupTurns)
        .where(
          and(
            eq(groupTurns.ownerId, ownerId),
            eq(groupTurns.conversationId, conversationId),
            query.afterId ? gt(groupTurns.id, query.afterId) : undefined,
          ),
        )
        .orderBy(asc(groupTurns.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const items = [];
      for (const row of page) items.push(await this.view(row, tx));
      return { items, nextAfterId: rows.length > query.limit ? page.at(-1)!.id : null };
    });
  }

  /** 查询指定轮次。 */
  get(ownerId: string, conversationId: string, id: string): Promise<GroupTurn> {
    return this.store.locked(ownerId, async (tx) => {
      await requireConversation(ownerId, conversationId, tx);
      return this.view(await this.row(ownerId, conversationId, id, tx), tx);
    });
  }

  /** 停止当前指定轮次，幂等保留此前已发布内容。 */
  stop(ownerId: string, conversationId: string, id: string): Promise<GroupTurn> {
    return this.store.locked(ownerId, async (tx, now) => {
      await requireConversation(ownerId, conversationId, tx);
      const row = await this.row(ownerId, conversationId, id, tx);
      if (row.interruptedAt) return this.view(row, tx);
      const [head] = await tx
        .select({ id: groupTurnHeads.turnId })
        .from(groupTurnHeads)
        .where(
          and(
            eq(groupTurnHeads.ownerId, ownerId),
            eq(groupTurnHeads.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (head?.id !== id) throw new ApiException(API_CODES.VERSION_CONFLICT);
      await interruptGroupTurn(ownerId, conversationId, now, tx, this.jobs);
      return this.view(await this.row(ownerId, conversationId, id, tx), tx);
    });
  }

  /** 点名与逐人顺序由命令明确，普通提问优先轮到其他成员。 */
  private async choose(
    ownerId: string,
    conversationId: string,
    addressing: GroupTurnRequest['addressing'],
    available: MemberRow[],
    tx: DatabaseTransaction,
  ): Promise<MemberRow[]> {
    if (addressing.mode !== 'any') {
      const ids =
        addressing.mode === 'mention' ? [addressing.membershipId] : addressing.membershipIds;
      return ids.map((id) => {
        const selected = available.find((member) => member.id === id.toLowerCase());
        if (!selected) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
        return selected;
      });
    }
    const recent = await this.database.messages.findMany(
      ownerId,
      {
        where: { conversationId, state: 'published', deletedAt: null },
        fields: { speaker: messages.speakerMembershipId },
        orderBy: [desc(messages.sequence)],
        limit: 20,
      },
      tx,
    );
    const last = recent.find(({ speaker }) => available.some((row) => row.id === speaker));
    const index = last ? available.findIndex((row) => row.id === last.speaker) : -1;
    const first = available[(index + 1) % available.length];
    if (!first || available.length === 1) return first ? [first] : [];
    return [first, available[(index + 2) % available.length]!];
  }

  /** 查询准确会话中的轮次记录。 */
  private async row(
    ownerId: string,
    conversationId: string,
    id: string,
    tx: DatabaseTransaction,
  ): Promise<Turn> {
    const [row] = await tx
      .select()
      .from(groupTurns)
      .where(
        and(
          eq(groupTurns.ownerId, ownerId),
          eq(groupTurns.conversationId, conversationId),
          eq(groupTurns.id, id),
        ),
      )
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }

  /** 结果包含实际任务与步骤状态，完整模型输入留在内部。 */
  private async view(row: Turn, tx: DatabaseTransaction): Promise<GroupTurn> {
    const task = await this.jobs.getInTransaction(row.ownerId, row.id, tx);
    const steps = await tx
      .select()
      .from(groupTurnSteps)
      .where(and(eq(groupTurnSteps.ownerId, row.ownerId), eq(groupTurnSteps.turnId, row.id)))
      .orderBy(asc(groupTurnSteps.ordinal));
    return {
      id: row.id,
      conversationId: row.conversationId,
      triggerMessageId: row.triggerMessageId,
      triggerSequence: row.triggerSequence,
      origin: row.origin,
      addressing: row.addressing,
      task,
      interruptedAt: row.interruptedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      steps: steps.map((step) => ({
        ordinal: step.ordinal,
        companionId: step.companionId,
        runtimeEpoch: step.runtimeEpoch,
        membershipId: step.membershipId,
        state: step.status,
        modelCallId: step.modelCallId,
        publishedMessageId: step.publishedMessageId,
        completedAt: step.completedAt?.toISOString() ?? null,
      })),
    };
  }
}

import { API_CODES } from '@memory-weave/contracts';
import type { ModelConfigurationVersion } from '@memory-weave/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DatabaseService, DatabaseTransaction } from '../../database/database.service';
import {
  companions,
  conversationMembers,
  groupTurns,
  groupTurnSteps,
  messages,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import { activeGrowth } from '../growth/growth-persona';
import { modelInputReservation } from '../models/model-runtime.service';
import { groupTurnDefinition } from './group-turn-definition';

export interface GroupSource {
  messageId: string;
  contentVersion: number;
}

/** 本位成员实际使用的输入，恢复时沿同一内容、权限和人格版本。 */
export interface GroupPreparation {
  permissionVersion: number;
  personaVersionId: string;
  growthIds: string[];
  growthSources: GroupSource[];
  messages: GroupSource[];
  inputText: string;
}

type Turn = typeof groupTurns.$inferSelect;
type Step = typeof groupTurnSteps.$inferSelect;

/** 选出当前成员实际可见的原文，前一位发表后才构建下一位的上下文。 */
export async function prepareGroupStep(
  database: DatabaseService,
  turn: Turn,
  step: Step,
  config: ModelConfigurationVersion,
  tx: DatabaseTransaction,
): Promise<GroupPreparation | null> {
  const { ownerId, conversationId } = turn;
  const member = await activeStepMember(database, turn, step, tx);
  if (!member) return null;
  const instance = await database.companions.findById(ownerId, step.companionId, tx);
  const version = instance?.currentPersonaVersionId;
  if (!instance || !version) return null;
  const row = await database.personaVersions.findOne(
    ownerId,
    {
      where: { id: version, companionId: step.companionId, runtimeEpoch: step.runtimeEpoch },
    },
    tx,
  );
  if (!row) return null;
  const { persona, sources: growthSources } = await activeGrowth(row, tx, turn.mode);
  const growthIds = persona.document?.growth?.map((trait) => trait.growthId) ?? [];
  const trigger = await database.messages.findOne(
    ownerId,
    {
      where: {
        id: turn.triggerMessageId,
        conversationId,
        state: 'published',
        deletedAt: null,
        contentVersion: turn.triggerContentVersion,
        sequence: turn.triggerSequence,
      },
    },
    tx,
  );
  if (!trigger) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
  if (!(await maySee(member, trigger.sequence!, tx))) return null;
  const latest = await database.messages.findMany(
    ownerId,
    {
      where: { conversationId, state: 'published', deletedAt: null },
      orderBy: [desc(messages.sequence)],
      limit: 32,
    },
    tx,
  );
  const selected: (typeof messages.$inferSelect)[] = [];
  for (const source of latest) {
    if (source.sequence !== null && (await maySee(member, source.sequence, tx)))
      selected.push(source);
    if (selected.length === 10) break;
  }
  if (!selected.some((source) => source.id === trigger.id)) {
    if (selected.length >= 10) selected.pop();
    selected.push(trigger);
  }
  selected.sort((left, right) => left.sequence! - right.sequence!);
  const participants = await tx
    .select({
      id: conversationMembers.id,
      kind: conversationMembers.kind,
      displayName: companions.name,
    })
    .from(conversationMembers)
    .leftJoin(
      companions,
      and(eq(companions.ownerId, ownerId), eq(companions.id, conversationMembers.companionId)),
    )
    .where(
      and(
        eq(conversationMembers.ownerId, ownerId),
        eq(conversationMembers.conversationId, conversationId),
        isNull(conversationMembers.deletedAt),
      ),
    )
    .limit(60);
  const workspace = await database.owners.findById(ownerId, ownerId, tx);
  /** 仅包含当前会话公开的发言者和实际原文。 */
  const assemble = () =>
    JSON.stringify({
      group: {
        self: {
          membershipId: member.id,
          name: instance.name,
          document: persona.document,
          originalProfile: persona.document ? null : persona.profileText,
        },
        participants: participants.map(({ id, kind, displayName }) => ({
          membershipId: id,
          kind,
          name: kind === 'user' ? workspace?.displayName : displayName,
        })),
        addressing: turn.addressing,
        step: step.ordinal,
        triggerSequence: turn.triggerSequence,
      },
      messages: selected.map((item) => ({
        membershipId: item.speakerMembershipId,
        messageId: item.id,
        contentVersion: item.contentVersion,
        sequence: item.sequence,
        text: item.text,
      })),
    });
  let inputText = assemble();
  while (
    modelInputReservation(inputText, groupTurnDefinition, 'structured') >
      config.config.tasks.chat.maxInputTokens ||
    inputText.length > 65536
  ) {
    const removable = selected.findIndex((item) => item.id !== trigger.id);
    if (removable < 0) throw new ApiException(API_CODES.CHAT_CONTEXT_LIMIT);
    selected.splice(removable, 1);
    inputText = assemble();
  }
  return {
    permissionVersion: member.permissionVersion,
    personaVersionId: persona.id,
    growthIds,
    growthSources,
    messages: selected.map((item) => ({ messageId: item.id, contentVersion: item.contentVersion })),
    inputText,
  };
}

/** 在派发、采用及恢复时校验冻结快照仍可由同一成员使用。 */
export async function validGroupStep(
  database: DatabaseService,
  turn: Turn,
  step: Step,
  context: GroupPreparation,
  tx: DatabaseTransaction,
): Promise<boolean> {
  const member = await activeStepMember(database, turn, step, tx);
  if (!member || member.permissionVersion !== context.permissionVersion) return false;
  const instance = await database.companions.findById(turn.ownerId, step.companionId, tx);
  if (instance?.currentPersonaVersionId !== context.personaVersionId) return false;
  if (context.growthIds.length) {
    const row = await database.personaVersions.findById(turn.ownerId, context.personaVersionId, tx);
    if (!row) return false;
    const { persona } = await activeGrowth(row, tx, turn.mode);
    if (
      JSON.stringify(persona.document?.growth?.map((trait) => trait.growthId) ?? []) !==
      JSON.stringify(context.growthIds)
    )
      return false;
  }
  for (const ref of context.messages) {
    const row = await database.messages.findOne(
      turn.ownerId,
      {
        where: {
          conversationId: turn.conversationId,
          id: ref.messageId,
          contentVersion: ref.contentVersion,
          state: 'published',
          deletedAt: null,
        },
        fields: { sequence: messages.sequence },
      },
      tx,
    );
    if (row?.sequence == null || !(await maySee(member, row.sequence, tx))) return false;
  }
  return true;
}

/** 退出、重置、清理或成员记录替换都不能继续代表该发言者。 */
async function activeStepMember(
  database: DatabaseService,
  turn: Turn,
  step: Step,
  tx: DatabaseTransaction,
) {
  try {
    const member = await requireCompanionMember(
      database,
      turn.ownerId,
      step.companionId,
      step.runtimeEpoch,
      turn.conversationId,
      tx,
    );
    return member.id === step.membershipId && !member.deletedAt && member.leftSequence === null
      ? member
      : null;
  } catch (error) {
    if (
      !(error instanceof ApiException) ||
      ![
        API_CODES.RESOURCE_NOT_FOUND,
        API_CODES.RUNTIME_EPOCH_MISMATCH,
        API_CODES.LIFECYCLE_RESTRICTED,
      ].some((code) => code === error.code)
    )
      throw error;
    return null;
  }
}

/** 不可见历史直接跳过，数据库错误仍交给任务恢复。 */
async function maySee(
  member: typeof conversationMembers.$inferSelect,
  sequence: number,
  tx: DatabaseTransaction,
): Promise<boolean> {
  try {
    await assertVisible(member, sequence, tx);
    return true;
  } catch (error) {
    if (!(error instanceof ApiException) || error.code !== API_CODES.RESOURCE_NOT_FOUND)
      throw error;
    return false;
  }
}

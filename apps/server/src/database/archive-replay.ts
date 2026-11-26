import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { createApplication } from '../app';
import type { ServerConfig } from '../config';
import { DatabaseService } from './database.service';
import {
  conversationHistoryShares,
  conversationMembers,
  conversationMembershipCommands,
  lifecycleOperations,
  messages,
  terminals,
  terminalGrants,
} from './schema';
import { ConversationHistory } from '../modules/conversations/conversation-history.service';
import { ConversationMembership } from '../modules/conversations/conversation-membership.service';
import { LifecycleExecutionService } from '../modules/lifecycle/lifecycle-execution.service';
import type { JournalRecord } from '../modules/lifecycle/lifecycle-journal';
import { LifecycleService } from '../modules/lifecycle/lifecycle.service';
import { TaskStore } from '../modules/tasks/task-store';
import { TerminalService } from '../modules/terminals/terminal-service';
import { TasksService } from '../modules/tasks/tasks.service';

/** 在 HTTP 和普通任务启动前应用最新限制，再完成尚未结束的清理。 */
export async function replayArchive(
  config: ServerConfig,
  ownerId: string,
  records: JournalRecord[],
) {
  const app = await createApplication({ ...config, lifecycleJournalDir: undefined });
  try {
    const database = app.get(DatabaseService);
    const jobs = app.get(TasksService);
    const lifecycle = app.get(LifecycleService);
    const execution = app.get(LifecycleExecutionService);
    const membership = app.get(ConversationMembership);
    const history = app.get(ConversationHistory);
    const store = app.get(TaskStore);
    const terminalService = app.get(TerminalService);

    /** 离线恢复只领取生命周期清理，其他任务仍按保存的状态等待首次启动。 */
    async function drain() {
      for (;;) {
        const [next] = await database.sql
          .select()
          .from(lifecycleOperations)
          .where(
            and(eq(lifecycleOperations.ownerId, ownerId), isNull(lifecycleOperations.completedAt)),
          )
          .limit(1);
        if (!next) return;
        const status = await lifecycle.get(ownerId, next.id);
        if (['failed', 'blocked', 'paused', 'cancelled'].includes(status.task.status))
          await lifecycle.retry(ownerId, next.id, { requestId: randomUUID() });
        const lease = await jobs.claim(ownerId, true);
        if (!lease) throw new Error('恢复的生命周期清理未获得租约。');
        const timer = setInterval(
          () => void jobs.heartbeat(lease).catch(() => undefined),
          Math.floor(lease.config.leaseMs / 3),
        );
        timer.unref();
        try {
          await execution.execute(lease);
        } finally {
          clearInterval(timer);
        }
        if ((await jobs.get(ownerId, lease.task.id)).status !== 'succeeded')
          throw new Error('恢复的生命周期清理未完成。');
      }
    }

    await drain();
    for (const { action } of records) {
      if (action.kind === 'lifecycle') {
        const input = action.command;
        if (
          await database.lifecycleOperations.findOne(ownerId, {
            where: { requestId: input.requestId },
          })
        )
          continue;
        if (input.kind === 'delete_messages') {
          const room = await database.conversations.findById(ownerId, input.conversationId);
          if (!room) continue;
          const targets = await database.sql
            .select({ messageId: messages.id, contentVersion: messages.contentVersion })
            .from(messages)
            .where(
              and(
                eq(messages.ownerId, ownerId),
                eq(messages.conversationId, room.id),
                isNull(messages.deletedAt),
                inArray(
                  messages.id,
                  input.messages.map((item) => item.messageId),
                ),
              ),
            );
          if (!targets.length) continue;
          await lifecycle.create(ownerId, {
            ...input,
            expectedVersion: room.version,
            messages: targets,
          });
        } else {
          const companion = await database.companions.findById(ownerId, input.companionId);
          if (!companion || companion.deletedAt || companion.runtimeEpoch > input.runtimeEpoch)
            continue;
          if (companion.runtimeEpoch < input.runtimeEpoch)
            throw new Error('独立生命周期日志缺少目标实例的中间代次。');
          await lifecycle.create(ownerId, { ...input, expectedVersion: companion.version });
        }
        await drain();
        continue;
      }
      if (action.kind === 'revoke_terminal') {
        const [terminal] = await database.sql
          .select({ id: terminals.id })
          .from(terminals)
          .where(and(eq(terminals.ownerId, ownerId), eq(terminals.id, action.terminalId)))
          .limit(1);
        if (terminal) await terminalService.revoke(ownerId, terminal.id);
        continue;
      }
      if (action.kind === 'disable_terminal_grant') {
        const [grant] = await database.sql
          .select()
          .from(terminalGrants)
          .where(
            and(
              eq(terminalGrants.ownerId, ownerId),
              eq(terminalGrants.id, action.grantId),
              eq(terminalGrants.terminalId, action.terminalId),
            ),
          )
          .limit(1);
        if (grant?.enabled && grant.version < action.version)
          await terminalService.grant(ownerId, grant.terminalId, {
            conversationId: grant.conversationId,
            companionId: grant.companionId,
            runtimeEpoch: grant.runtimeEpoch,
            workspaceId: grant.workspaceId,
            tool: grant.tool,
            expectedVersion: grant.version,
            enabled: false,
          });
        continue;
      }
      const room = await database.conversations.findById(ownerId, action.conversationId);
      if (!room) continue;
      const [applied] = await database.sql
        .select({ id: conversationMembershipCommands.requestId })
        .from(conversationMembershipCommands)
        .where(
          and(
            eq(conversationMembershipCommands.ownerId, ownerId),
            eq(conversationMembershipCommands.conversationId, room.id),
            eq(conversationMembershipCommands.requestId, action.requestId),
          ),
        )
        .limit(1);
      if (applied) continue;
      if (action.kind === 'revoke_history') {
        const [share] = await database.sql
          .select()
          .from(conversationHistoryShares)
          .where(
            and(
              eq(conversationHistoryShares.ownerId, ownerId),
              eq(conversationHistoryShares.conversationId, room.id),
              eq(conversationHistoryShares.id, action.shareId),
            ),
          )
          .limit(1);
        if (share?.state !== 'approved') continue;
        if (
          share.membershipId !== action.membershipId ||
          share.fromSequence !== action.startSequence ||
          share.throughSequence !== action.endSequence
        )
          throw new Error('恢复的历史授权身份或范围发生冲突。');
        await history.decide(ownerId, room.id, share.id, {
          requestId: action.requestId,
          expectedVersion: share.version,
          decision: 'revoke',
        });
      } else if (!room.closedAt) {
        const command = { requestId: action.requestId, expectedConversationVersion: room.version };
        if (action.kind === 'leave') {
          const [member] = await database.sql
            .select()
            .from(conversationMembers)
            .where(
              and(
                eq(conversationMembers.ownerId, ownerId),
                eq(conversationMembers.conversationId, room.id),
                eq(conversationMembers.id, action.membershipId),
              ),
            )
            .limit(1);
          if (member && member.leftSequence === null)
            await store.locked(ownerId, (tx, now) =>
              membership.exitInTransaction(
                ownerId,
                room.id,
                member.id,
                { ...command, expectedPermissionVersion: member.permissionVersion },
                action.actor,
                tx,
                now,
              ),
            );
        } else if (action.kind === 'close') await membership.close(ownerId, room.id, command);
        else if (room.peerInvitationsEnabled)
          await membership.policy(ownerId, room.id, { ...command, peerInvitationsEnabled: false });
      }
    }
    await drain();
  } finally {
    await app.close();
  }
}

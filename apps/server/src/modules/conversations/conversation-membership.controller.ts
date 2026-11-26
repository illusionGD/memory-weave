import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  conversationCloseSchema,
  historyDecisionSchema,
  historyRequestSchema,
  idPaginationQuerySchema,
  invitationDecisionSchema,
  memberExitSchema,
  membershipPolicySchema,
  newInvitationSchema,
  shareBackgroundSchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  ConversationClose,
  HistoryDecision,
  HistoryRequest,
  IdPaginationQuery,
  InvitationDecision,
  MemberExit,
  MembershipPolicy,
  NewInvitation,
  ShareBackground,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { ConversationBackground } from './conversation-background.service';
import { ConversationHistory } from './conversation-history.service';
import { ConversationInvitations } from './conversation-invitations.service';
import { ConversationMembership } from './conversation-membership.service';

const idSchema = uuidSchema.transform((value) => value.toLowerCase());

/** 已认证管理入口，真实成员身份和新范围由服务端核验。 */
@Controller('conversations/:conversationId')
export class ConversationMembershipController {
  /** 初始化邀请、退出和历史批准接口。 */
  constructor(
    @Inject(ConversationInvitations) private readonly invitations: ConversationInvitations,
    @Inject(ConversationMembership) private readonly members: ConversationMembership,
    @Inject(ConversationHistory) private readonly history: ConversationHistory,
    @Inject(ConversationBackground) private readonly background: ConversationBackground,
  ) {}

  /** 向目标实例代次发出邀请。 */
  @Post('invitations')
  invite(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Body(new ZodValidationPipe(newInvitationSchema)) command: NewInvitation,
  ) {
    return this.invitations.create(ownerId, conversationId, command);
  }

  /** 查询邀请状态和接受后得到的会话。 */
  @Get('invitations')
  listInvitations(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.invitations.list(ownerId, conversationId, query);
  }

  /** 记录明确的接受、拒绝、暂缓或取消。 */
  @Post('invitations/:id/decision')
  @HttpCode(200)
  decideInvitation(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(invitationDecisionSchema)) command: InvitationDecision,
  ) {
    return this.invitations.decide(ownerId, conversationId, id, command);
  }

  /** 管理当前会话的成员。 */
  @Post('members/:id/exit')
  @HttpCode(200)
  exit(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(memberExitSchema)) command: MemberExit,
  ) {
    return this.members.exit(ownerId, conversationId, id, command);
  }

  /** 将会话切换为历史可读的结束状态。 */
  @Post('close')
  @HttpCode(200)
  close(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Body(new ZodValidationPipe(conversationCloseSchema)) command: ConversationClose,
  ) {
    return this.members.close(ownerId, conversationId, command);
  }

  /** 设置本会话是否允许同伴继续邀请。 */
  @Post('membership-policy')
  @HttpCode(200)
  policy(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Body(new ZodValidationPipe(membershipPolicySchema)) command: MembershipPolicy,
  ) {
    return this.members.policy(ownerId, conversationId, command);
  }

  /** 提议开放确切的旧序号范围。 */
  @Post('history-requests')
  requestHistory(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Body(new ZodValidationPipe(historyRequestSchema)) command: HistoryRequest,
  ) {
    return this.history.request(ownerId, conversationId, command);
  }

  /** 查询历史审批及实际新增的整理范围数量。 */
  @Get('history-requests')
  listHistory(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.history.list(ownerId, conversationId, query);
  }

  /** 批准、拒绝或撤销已经开放的旧历史范围。 */
  @Post('history-requests/:id/decision')
  @HttpCode(200)
  decideHistory(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(historyDecisionSchema)) command: HistoryDecision,
  ) {
    return this.history.decide(ownerId, conversationId, id, command);
  }

  /** 发布管理账号可读的有出处背景片段。 */
  @Post('background')
  shareBackground(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Body(new ZodValidationPipe(shareBackgroundSchema)) command: ShareBackground,
  ) {
    return this.background.share(ownerId, conversationId, command);
  }
}

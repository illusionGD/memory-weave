import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  groupTurnRequestSchema,
  groupTurnsQuerySchema,
  stopGroupTurnSchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type { GroupTurnRequest, IdPaginationQuery, StopGroupTurn } from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { GroupTurnsService } from './group-turns.service';

const idSchema = uuidSchema.transform((value) => value.toLowerCase());

/** 发送、查看和停止多参与者接话轮次。 */
@Controller('conversations/:conversationId/turns')
export class GroupTurnsController {
  /** 初始化接话接口。 */
  constructor(@Inject(GroupTurnsService) private readonly turns: GroupTurnsService) {}

  /** 用户发言、点名或请求逐人表达。 */
  @Post()
  send(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Body(new ZodValidationPipe(groupTurnRequestSchema)) command: GroupTurnRequest,
  ) {
    return this.turns.send(ownerId, conversationId, command);
  }

  /** 只读分页查询，打开历史不会安排发言。 */
  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Query(new ZodValidationPipe(groupTurnsQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.turns.list(ownerId, conversationId, query);
  }

  /** 查看实际发言状态及每位参与者的完成情况。 */
  @Get(':id')
  get(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ) {
    return this.turns.get(ownerId, conversationId, id);
  }

  /** 停止当前未发布的接话机会。 */
  @Post(':id/stop')
  @HttpCode(200)
  stop(
    @CurrentOwner() ownerId: string,
    @Param('conversationId', new ZodValidationPipe(idSchema)) conversationId: string,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(stopGroupTurnSchema)) _body: StopGroupTurn,
  ) {
    return this.turns.stop(ownerId, conversationId, id);
  }
}

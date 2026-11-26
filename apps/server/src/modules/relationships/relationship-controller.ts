import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  relationshipHistoryQuerySchema,
  relationshipQuerySchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  RelationshipHistory,
  RelationshipHistoryQuery,
  RelationshipList,
  RelationshipQuery,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { RelationshipService } from './relationship-service';

/** 通过已认证的管理查询查看关系现状与证据。 */
@Controller('companions/:companionId/relationships')
export class RelationshipController {
  /** 初始化关系状态查询接口。 */
  constructor(@Inject(RelationshipService) private readonly relationships: RelationshipService) {}

  /** 分页查看实例在本会话中的关系视角。 */
  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Query(new ZodValidationPipe(relationshipQuerySchema)) query: RelationshipQuery,
  ): Promise<RelationshipList> {
    return this.relationships.list(ownerId, companionId.toLowerCase(), query);
  }

  /** 分页回查状态历史与实际依据。 */
  @Get(':id/versions')
  history(
    @CurrentOwner() ownerId: string,
    @Param('companionId', new ZodValidationPipe(uuidSchema)) companionId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(relationshipHistoryQuerySchema)) query: RelationshipHistoryQuery,
  ): Promise<RelationshipHistory> {
    return this.relationships.history(ownerId, companionId.toLowerCase(), id.toLowerCase(), query);
  }
}

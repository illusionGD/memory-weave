import { CurrentOwner } from '../auth/current-owner';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  uuidSchema,
  memoryExplorerQuerySchema,
  memoryExplorerConversationsQuerySchema,
  memoryGraphQuerySchema,
  memoryExplorerValidationSchema,
} from '@memory-weave/contracts';
import type {
  MemoryExplorerConversationsQuery,
  MemoryExplorerValidation,
  MemoryGraphQuery,
  MemoryExplorerQuery,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { MemoryExplorerService } from './memory-explorer.service';

/** 后台记忆浏览接口，沿用统一认证与数字响应码。 */
@Controller('companions/:id/memory-explorer')
export class MemoryExplorerController {
  /** 初始化记忆浏览接口所需的服务。 */
  constructor(@Inject(MemoryExplorerService) private readonly explorer: MemoryExplorerService) {}
  /** 分页查询可供筛选的会话选项。 */
  @Get('conversations') conversations(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(memoryExplorerConversationsQuerySchema))
    query: MemoryExplorerConversationsQuery,
  ) {
    return this.explorer.conversations(ownerId, id, query);
  }
  /**
   * 校验页面已展示的记忆引用。
   *
   * 当前画面依赖的有界校验，不保存读取记录。
   */
  @Post('validate') @HttpCode(200) validate(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(memoryExplorerValidationSchema)) body: MemoryExplorerValidation,
  ) {
    return this.explorer.validate(ownerId, id, body);
  }
  /**
   * 查询记忆图谱的邻接节点和关系。
   *
   * 展开实际来源与版本关系。
   */
  @Get('graph') graph(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(memoryGraphQuerySchema)) query: MemoryGraphQuery,
  ) {
    return this.explorer.graph(ownerId, id, query);
  }
  /**
   * 分页查询记忆版本时间线。
   *
   * 按记下时间查看历史版本。
   */
  @Get('timeline') timeline(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(memoryExplorerQuerySchema)) query: MemoryExplorerQuery,
  ) {
    return this.explorer.timeline(ownerId, id, query);
  }
  /** 分页查询伴侣的当前记忆。 */
  @Get('entries') entries(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(memoryExplorerQuerySchema)) query: MemoryExplorerQuery,
  ) {
    return this.explorer.entries(ownerId, id, query);
  }
}

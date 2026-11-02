import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  memoryExplorerQuerySchema,
  memoryExplorerConversationsQuerySchema,
  memoryGraphQuerySchema,
  memoryExplorerValidationSchema,
} from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { MemoryExplorerService } from './memory-explorer.service';
/** 后台记忆浏览接口，沿用统一认证与数字响应码。 */
@Controller('companions/:id/memory-explorer')
export class MemoryExplorerController {
  /** 初始化记忆浏览接口所需的服务。 */
  constructor(@Inject(MemoryExplorerService) private readonly explorer: MemoryExplorerService) {}
  /** 分页查询可供筛选的会话选项。 */
  @Get('conversations') conversations(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.conversations(
      parseId(id),
      parseInput(memoryExplorerConversationsQuerySchema, query),
    );
  }
  /**
   * 校验页面已展示的记忆引用。
   *
   * 当前画面依赖的有界校验，不保存读取记录。
   */
  @Post('validate') @HttpCode(200) validate(@Param('id') id: string, @Body() body: unknown) {
    return this.explorer.validate(parseId(id), parseInput(memoryExplorerValidationSchema, body));
  }
  /**
   * 查询记忆图谱的邻接节点和关系。
   *
   * 展开实际来源与版本关系。
   */
  @Get('graph') graph(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.graph(parseId(id), parseInput(memoryGraphQuerySchema, query));
  }
  /**
   * 分页查询记忆版本时间线。
   *
   * 按记下时间查看历史版本。
   */
  @Get('timeline') timeline(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.timeline(parseId(id), parseInput(memoryExplorerQuerySchema, query));
  }
  /** 分页查询伴侣的当前记忆。 */
  @Get('entries') entries(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.entries(parseId(id), parseInput(memoryExplorerQuerySchema, query));
  }
}

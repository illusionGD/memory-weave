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
  constructor(@Inject(MemoryExplorerService) private readonly explorer: MemoryExplorerService) {}
  /** 可用于单会话筛选的有界选择列表。 */
  @Get('conversations') conversations(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.conversations(
      parseId(id),
      parseInput(memoryExplorerConversationsQuerySchema, query),
    );
  }
  /** 当前画面依赖的有界校验，不保存读取记录。 */
  @Post('validate') @HttpCode(200) validate(@Param('id') id: string, @Body() body: unknown) {
    return this.explorer.validate(parseId(id), parseInput(memoryExplorerValidationSchema, body));
  }
  /** 展开实际来源与版本关系。 */
  @Get('graph') graph(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.graph(parseId(id), parseInput(memoryGraphQuerySchema, query));
  }
  /** 按记下时间查看历史版本。 */
  @Get('timeline') timeline(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.timeline(parseId(id), parseInput(memoryExplorerQuerySchema, query));
  }
  /** 按实例查询当前记忆。 */
  @Get('entries') entries(@Param('id') id: string, @Query() query: unknown) {
    return this.explorer.entries(parseId(id), parseInput(memoryExplorerQuerySchema, query));
  }
}

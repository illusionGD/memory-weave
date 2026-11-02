import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { changeAvatarSchema } from '@memory-weave/contracts';
import type { AvatarState } from '@memory-weave/contracts';
import { parseId, parseInput } from '../shared/http';
import { AvatarsService } from './avatars.service';

/** 头像和业务接口使用同一部署认证、Origin 限制与错误协议。 */
@Controller('companions/:id/avatar')
export class AvatarsController {
  /** 初始化头像接口所需的服务。 */
  constructor(@Inject(AvatarsService) private readonly service: AvatarsService) {}
  /** 接收并保存伴侣头像上传请求。 */
  @Put()
  upload(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers('content-type') mime: string,
    @Body() body: unknown,
  ): Promise<AvatarState> {
    return this.service.upload(
      parseId(id).toLowerCase(),
      parseInput(changeAvatarSchema, query),
      mime?.split(';')[0]?.trim() ?? '',
      body,
    );
  }
  /** 清除自定义头像并恢复默认头像。 */
  @Delete()
  clear(@Param('id') id: string, @Body() body: unknown): Promise<AvatarState> {
    return this.service.clear(parseId(id).toLowerCase(), parseInput(changeAvatarSchema, body));
  }
  /**
   * 返回伴侣当前头像的二进制图片。
   *
   * 二进制图片不包 JSON 外层；错误仍使用统一 code/data/message。
   */
  @Get(':assetId')
  async read(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Res() response: Response,
  ): Promise<void> {
    const bytes = await this.service.read(parseId(id).toLowerCase(), parseId(assetId));
    response
      .set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }
}

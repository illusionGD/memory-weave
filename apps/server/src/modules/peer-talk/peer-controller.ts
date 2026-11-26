import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import {
  configurePeerRoomSchema,
  configurePeerSchema,
  peerViewQuerySchema,
  runtimeEpochQuerySchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type { ConfigurePeer, ConfigurePeerRoom, IdPaginationQuery } from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { PeerPolicyService } from './peer-policy';
import { PeerService } from './peer-service';

/** 查看同伴公开简介和实际自主场次，用户可撤销授权。 */
@Controller()
export class PeerController {
  /** 初始化同伴管理和实际交流诊断。 */
  constructor(
    @Inject(PeerPolicyService) private readonly policy: PeerPolicyService,
    @Inject(PeerService) private readonly peers: PeerService,
  ) {}

  /** 查询已明确公开的同伴。 */
  @Get('peer-profiles')
  profiles(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(peerViewQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.policy.profiles(ownerId, query);
  }

  /** 回查实际实例许可。 */
  @Get('companions/:id/peer-policy')
  settings(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query('runtimeEpoch', new ZodValidationPipe(runtimeEpochQuerySchema)) epoch: number,
  ) {
    return this.policy.settings(ownerId, id.toLowerCase(), epoch);
  }

  /** 选择公开简介和同伴决策范围。 */
  @Put('companions/:id/peer-policy')
  configure(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(configurePeerSchema)) command: ConfigurePeer,
  ) {
    return this.policy.configure(ownerId, id.toLowerCase(), command);
  }

  /** 查看当前会话怎样允许自主发言。 */
  @Get('conversations/:id/peer-policy')
  room(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return this.policy.room(ownerId, id.toLowerCase());
  }

  /** 更新会话自主权限。 */
  @Put('conversations/:id/peer-policy')
  configureRoom(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(configurePeerRoomSchema)) command: ConfigurePeerRoom,
  ) {
    return this.policy.configureRoom(ownerId, id.toLowerCase(), command);
  }

  /** 回查每场实际调用、预留费用和停止原因。 */
  @Get('conversations/:id/peer-sessions')
  sessions(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(peerViewQuerySchema)) query: IdPaginationQuery,
  ) {
    return this.peers.sessions(ownerId, id.toLowerCase(), query);
  }
}

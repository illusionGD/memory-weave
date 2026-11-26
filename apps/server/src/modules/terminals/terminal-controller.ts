import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  connectTerminalSchema,
  idPaginationQuerySchema,
  registerTerminalSchema,
  requestTerminalActionSchema,
  terminalConnectionSchema,
  terminalReceiptSchema,
  updateTerminalGrantSchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  ConnectTerminal,
  IdPaginationQuery,
  RegisterTerminal,
  RequestTerminalAction,
  Terminal,
  TerminalAction,
  TerminalConnection,
  TerminalConnectionView,
  TerminalDispatch,
  TerminalGrant,
  TerminalReceipt,
  UpdateTerminalGrant,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { PublicRoute } from '../auth/public-route';
import { TerminalService } from './terminal-service';

/** 拥有者用会话管理终端与授权，设备仅能凭专用凭据参加执行协议。 */
@Controller('terminals')
export class TerminalController {
  constructor(@Inject(TerminalService) private readonly service: TerminalService) {}

  @Put(':id')
  register(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(registerTerminalSchema)) input: RegisterTerminal,
  ): Promise<Terminal> {
    return this.service.register(ownerId, id, input);
  }

  @Get()
  list(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): ReturnType<TerminalService['list']> {
    return this.service.list(ownerId, query);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<Terminal> {
    return this.service.revoke(ownerId, id);
  }

  @Put(':id/grants')
  grant(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(updateTerminalGrantSchema)) input: UpdateTerminalGrant,
  ): Promise<TerminalGrant> {
    return this.service.grant(ownerId, id, input);
  }

  @Get(':id/grants')
  listGrants(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(idPaginationQuerySchema)) query: IdPaginationQuery,
  ): ReturnType<TerminalService['listGrants']> {
    return this.service.listGrants(ownerId, id, query);
  }

  @Post('actions')
  request(
    @CurrentOwner() ownerId: string,
    @Body(new ZodValidationPipe(requestTerminalActionSchema)) input: RequestTerminalAction,
  ): Promise<TerminalAction> {
    return this.service.request(ownerId, input);
  }

  @Get('actions/:actionId')
  getAction(
    @CurrentOwner() ownerId: string,
    @Param('actionId', new ZodValidationPipe(uuidSchema)) actionId: string,
  ): Promise<TerminalAction> {
    return this.service.getAction(ownerId, actionId);
  }

  @Post('actions/:actionId/cancel')
  @HttpCode(200)
  cancelAction(
    @CurrentOwner() ownerId: string,
    @Param('actionId', new ZodValidationPipe(uuidSchema)) actionId: string,
  ): Promise<TerminalAction> {
    return this.service.cancelAction(ownerId, actionId);
  }

  @Post(':id/connect')
  @HttpCode(200)
  @PublicRoute()
  connect(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(connectTerminalSchema)) input: ConnectTerminal,
  ): Promise<TerminalConnectionView> {
    return this.service.connect(id, authorization, input);
  }

  @Post(':id/heartbeat')
  @HttpCode(200)
  @PublicRoute()
  heartbeat(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(terminalConnectionSchema)) input: TerminalConnection,
  ): Promise<TerminalConnectionView> {
    return this.service.heartbeat(id, authorization, input.connectionId);
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  @PublicRoute()
  disconnect(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(terminalConnectionSchema)) input: TerminalConnection,
  ): Promise<null> {
    return this.service.disconnect(id, authorization, input.connectionId);
  }

  @Post(':id/claim')
  @HttpCode(200)
  @PublicRoute()
  claim(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(terminalConnectionSchema)) input: TerminalConnection,
  ): Promise<TerminalDispatch | null> {
    return this.service.claim(id, authorization, input.connectionId);
  }

  @Put(':id/actions/:actionId/receipt')
  @PublicRoute()
  receipt(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('actionId', new ZodValidationPipe(uuidSchema)) actionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodValidationPipe(terminalReceiptSchema)) input: TerminalReceipt,
  ): Promise<TerminalAction> {
    return this.service.receipt(id, actionId, authorization, input);
  }
}

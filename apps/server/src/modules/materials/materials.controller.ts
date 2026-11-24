import { z } from 'zod';
import { Body, Controller, Get, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  materialSummaryRequestSchema,
  materialPartsQuerySchema,
  materialUploadSchema,
  uuidSchema,
} from '@memory-weave/contracts';
import type {
  MaterialPartsPage,
  MaterialPartsQuery,
  MaterialSummary,
  MaterialSummaryProgress,
  MaterialSummaryRequest,
  MaterialUpload,
} from '@memory-weave/contracts';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { CurrentOwner } from '../auth/current-owner';
import { MaterialSummaryService } from './material-summary.service';
import { MaterialsService } from './materials.service';

/** 仅从认证后的材料接口读取原件或结构化片段。 */
@Controller('materials')
export class MaterialsController {
  constructor(
    @Inject(MaterialsService) private readonly materials: MaterialsService,
    @Inject(MaterialSummaryService) private readonly summaries: MaterialSummaryService,
  ) {}

  @Put()
  upload(
    @CurrentOwner() ownerId: string,
    @Query(new ZodValidationPipe(materialUploadSchema)) input: MaterialUpload,
    @Body() bytes: unknown,
  ): Promise<MaterialSummary> {
    return this.materials.upload(ownerId, input, bytes);
  }

  @Get(':id')
  describe(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<MaterialSummary> {
    return this.materials.describe(ownerId, id);
  }

  @Get(':id/parts')
  parts(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(new ZodValidationPipe(materialPartsQuerySchema)) query: MaterialPartsQuery,
  ): Promise<MaterialPartsPage> {
    return this.materials.parts(ownerId, id, query);
  }

  @Post(':id/summaries')
  startSummary(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(materialSummaryRequestSchema)) command: MaterialSummaryRequest,
  ): Promise<MaterialSummaryProgress> {
    return this.summaries.start(ownerId, id, command);
  }

  @Get(':id/summaries')
  latestSummary(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(
      new ZodValidationPipe(
        z.strictObject({
          messageId: uuidSchema,
          contentVersion: z.coerce.number().int().positive(),
        }),
      ),
    )
    query: Pick<MaterialSummaryRequest, 'messageId' | 'contentVersion'>,
  ): Promise<MaterialSummaryProgress | null> {
    return this.summaries.latest(ownerId, id, query.messageId, query.contentVersion);
  }

  @Get(':id/summaries/:taskId')
  summary(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('taskId', new ZodValidationPipe(uuidSchema)) taskId: string,
  ): Promise<MaterialSummaryProgress> {
    return this.summaries.status(ownerId, id, taskId);
  }

  @Get(':id/preview')
  async preview(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query(
      new ZodValidationPipe(
        z.strictObject({ position: z.coerce.number().int().positive().optional() }),
      ),
    )
    query: { position?: number },
    @Res() response: Response,
  ): Promise<void> {
    const bytes = await this.materials.preview(ownerId, id, query.position);
    response
      .set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }

  @Get(':id/original')
  async original(
    @CurrentOwner() ownerId: string,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { row, bytes } = await this.materials.original(ownerId, id);
    const filename = encodeURIComponent(row.title).replace(
      /['()*]/gu,
      (value) => '%' + value.charCodeAt(0).toString(16).toUpperCase(),
    );
    response
      .set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }
}

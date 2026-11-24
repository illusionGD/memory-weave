import { withMaterialCapacity } from './material-capacity';
import { renderMaterialImage } from './image-parser';
import { perceptionDefinition, perceptionOutputSchema } from './perception-definition';
import { ModelRuntimeService } from '../models/model-runtime.service';
import type { ModelDispatchGuard } from '../models/model-task';
import { assertVisible, requireCompanionMember } from '../conversations/conversation-access';
import type { TaskLease } from '../tasks/task-types';
import { TasksService } from '../tasks/tasks.service';
import { API_CODES } from '@memory-weave/contracts';
import type {
  MaterialContext,
  ModelConfigurationVersion,
  TaskScope,
  MaterialPart,
  MaterialPartsPage,
  MaterialPartsQuery,
  MaterialSummary,
  MaterialUpload,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  isNotNull,
  gte,
  inArray,
  lt,
  lte,
  exists,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, statfs } from 'node:fs/promises';
import { SERVER_CONFIG } from '../../config';
import type { RuntimeConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction, QueryDatabase } from '../../database/database.service';
import {
  conversations,
  materialParts,
  materialReadings,
  materialVersions,
  messageMaterials,
  messages,
  modelCalls,
  tasks,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { TaskStore } from '../tasks/task-store';
import { fingerprint } from '../shared/http';
import { extractMaterial, MaterialWorkerError } from './material-worker-client';
import { materialConfigurationSchema } from './material-config';
import type { MaterialConfiguration } from './material-config';
import type { MaterialFileReference } from './material-files';
import { MaterialFiles } from './material-files';
import { materialSummary } from './material-queries';

type MaterialRow = typeof materialVersions.$inferSelect;
type StoredPart = MaterialPart & { asset?: MaterialFileReference };

/** 材料文件与消息的发布都经过调度锁，解析不占用数据库事务。 */
@Injectable()
export class MaterialsService {
  private readonly limits: MaterialConfiguration;
  private readonly files: MaterialFiles;
  private uploads = 0;
  private lastSweep = 0;
  private readonly sweepCursors = new Map<string, string>();

  /** 初始化集中预算与原件目录。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
    @Inject(SERVER_CONFIG) private readonly configuration: RuntimeConfig,
  ) {
    this.limits = configuration.materialConfiguration ?? materialConfigurationSchema.parse({});
    this.files = new MaterialFiles(configuration.dataDir, this.limits);
  }

  /** 校验上传身份、提取片段并发布完整原件引用。 */
  async upload(ownerId: string, input: MaterialUpload, bytes: unknown): Promise<MaterialSummary> {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ApiException(API_CODES.INVALID_REQUEST);
    if (bytes.length > this.limits.maxFileBytes)
      throw new ApiException(API_CODES.REQUEST_BODY_TOO_LARGE);
    const digest = fingerprint({
      filename: input.filename,
      kind: input.kind,
      hash: createHash('sha256').update(bytes).digest('hex'),
    });
    const existing = await this.lookup(ownerId, input.requestId, this.database.sql);
    if (existing) return this.replay(ownerId, existing, digest, this.database.sql);

    if (this.uploads >= 1)
      throw new ApiException(API_CODES.RATE_LIMITED, '正在提取材料，请稍后重试。');
    this.uploads++;
    try {
      const parts = await withMaterialCapacity(this.configuration.databaseUrl, () =>
        this.parseUpload(input, bytes),
      );
      if (!parts) throw new ApiException(API_CODES.RATE_LIMITED, '正在提取材料，请稍后重试。');
      if (!(await this.hasSpace(ownerId, bytes.length, this.database.sql)))
        throw new ApiException(
          API_CODES.DATA_UNAVAILABLE,
          '材料存储空间不足，请清理材料或扩充存储。',
        );
      const file = await this.files.save(ownerId, bytes);
      const saved = await this.store.locked(ownerId, async (tx) => {
        const replay = await this.lookup(ownerId, input.requestId, tx);
        if (replay) return { row: replay, created: false };
        if (!(await this.hasQuota(ownerId, bytes.length, tx))) return { row: null, created: false };

        const id = randomUUID();
        const partial = parts.some((part) => part.status === 'no-text-layer');
        const row = {
          id,
          ownerId,
          ...file,
          requestId: input.requestId,
          kind: input.kind,
          title: input.filename,
          fingerprint: digest,
          acquiredAt: new Date(),
          state: (partial ? 'partial' : 'parsed') as 'partial' | 'parsed',
          reason: partial ? 'pdf-pages-without-text' : null,
          partCount: parts.length,
        };
        await tx.insert(materialVersions).values(row);
        await this.saveParts(ownerId, id, parts, tx);
        return { row: { ...row, sourceUrl: null }, created: true };
      });
      if (!saved.created) {
        await this.files.remove(ownerId, file.fileId);
        if (!saved.row) throw new ApiException(API_CODES.DATA_UNAVAILABLE, '材料存储空间不足。');
        const replay = await this.lookup(ownerId, input.requestId, this.database.sql);
        if (!replay) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
        return this.replay(ownerId, replay, digest, this.database.sql);
      }
      return materialSummary(saved.row!);
    } finally {
      this.uploads--;
    }
  }

  /** 发送前在事务外校验实际存在的原件字节。 */
  async checkOriginals(ownerId: string, ids: string[]): Promise<void> {
    if (ids.length > this.limits.maxAttachments) throw new ApiException(API_CODES.INVALID_REQUEST);
    for (const id of ids)
      await this.readFile(ownerId, await this.available(ownerId, id, this.database.sql));
  }

  /** 固定发送所选择的版本，并为正文分享的 HTTP 链接登记待获取版本。 */
  async attach(
    ownerId: string,
    messageId: string,
    contentVersion: number,
    materialIds: string[],
    links: string[],
    scope: TaskScope,
    tx: DatabaseTransaction,
    now: Date,
  ): Promise<void> {
    if (materialIds.length > this.limits.maxAttachments)
      throw new ApiException(API_CODES.INVALID_REQUEST, '附件数量超过材料配置限制。');
    for (const id of materialIds) {
      const row = await this.available(ownerId, id, tx);
      if (row.kind === 'web') throw new ApiException(API_CODES.INVALID_REQUEST);
      if (!row.sharedAt)
        await tx
          .update(materialVersions)
          .set({ sharedAt: now })
          .where(and(eq(materialVersions.ownerId, ownerId), eq(materialVersions.id, id)));
    }
    const ids = [...materialIds];
    for (const sourceUrl of links.slice(0, this.limits.maxAttachments - ids.length)) {
      const id = randomUUID();
      await tx.insert(materialVersions).values({
        id,
        ownerId,
        sourceUrl,
        title: new URL(sourceUrl).hostname,
        kind: 'web',
        sharedAt: now,
      });
      await this.database.tasks.insert(
        ownerId,
        {
          id,
          requestKey: `material-fetch:${id}`,
          fingerprint: fingerprint({ id, messageId, contentVersion }),
          kind: 'material_fetch',
          input: { kind: 'material_fetch', materialId: id, messageId, contentVersion },
          scope,
          availableAt: now,
          totalSteps: 1,
        },
        tx,
      );
      ids.push(id);
    }
    if (ids.length)
      await tx.insert(messageMaterials).values(
        ids.map((id, index) => ({
          ownerId,
          messageId,
          contentVersion,
          materialId: id,
          position: index + 1,
        })),
      );
  }

  /** 在独立线程获取网页，按当前分享权限与租约提交实际取得的范围。 */
  async fetch(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'material_fetch') throw new TypeError('材料任务类型无效。');
    const input = lease.input;
    const ownerId = lease.ownerId;
    const row = await this.store.locked(ownerId, async (tx) => {
      await this.tasks.guardDispatch(ownerId, tx, lease);
      return this.requireWebShare(ownerId, lease, input, tx);
    });
    let result: Awaited<ReturnType<typeof extractMaterial>> | undefined;
    let failure: string | null = null;
    try {
      result = await withMaterialCapacity(this.configuration.databaseUrl, () =>
        extractMaterial({ kind: 'web', url: row.sourceUrl! }, this.limits),
      );
      if (!result) {
        await this.tasks.fail(lease, 'material_capacity', true);
        return;
      }
    } catch (error) {
      failure = error instanceof MaterialWorkerError ? error.reason : 'extraction-failed';
    }
    const article = result?.kind === 'web' ? result.article : undefined;
    const content = article?.content;
    const reason = article?.reason ?? failure;
    const parts: StoredPart[] = (content?.paragraphs ?? []).map((text, index) => ({
      position: index + 1,
      page: null,
      status: 'text',
      text,
      region: null,
    }));
    const video = content?.status === 'video-page-only';
    let missingImages = result?.kind === 'web' && result.incompleteImages;
    let savedBytes = 0;
    if (result?.kind === 'web' && result.images.length && !reason) {
      const bytesRequested = result.images.reduce((total, image) => total + image.bytes.length, 0);
      if (await this.hasSpace(ownerId, bytesRequested, this.database.sql)) {
        for (const image of result.images) {
          const file = await this.files.save(ownerId, Buffer.from(image.bytes));
          savedBytes += file.byteLength;
          for (const region of image.regions)
            parts.push({
              position: parts.length + 1,
              page: null,
              status: 'image',
              text: null,
              region,
              asset: file,
            });
        }
      } else {
        missingImages = true;
      }
    }
    await this.tasks.checkpoint(lease, { completedSteps: 1, stage: 'material_snapshot' });
    await this.tasks.complete(lease, async (ownerId, tx) => {
      await this.requireWebShare(ownerId, lease, input, tx);
      if (savedBytes && !(await this.hasQuota(ownerId, savedBytes, tx))) {
        parts.splice(parts.findIndex((part) => part.asset));
        savedBytes = 0;
        missingImages = true;
      }
      await this.saveParts(ownerId, row.id, parts, tx);
      await tx
        .update(materialVersions)
        .set({
          title: content?.title || row.title,
          state:
            video || (!reason && missingImages) ? 'partial' : reason ? 'unavailable' : 'parsed',
          reason: video
            ? 'video-unread'
            : (reason ?? (missingImages ? 'web-images-unavailable' : null)),
          byteLength: savedBytes,
          finalUrl: article?.finalUrl ?? null,
          acquiredAt: article?.receivedAt ? new Date(article.receivedAt) : new Date(),
          hash: article?.hash ?? null,
          partCount: parts.length,
        })
        .where(and(eq(materialVersions.ownerId, ownerId), eq(materialVersions.id, row.id)));
    });
  }

  /** 判断当前轮次是否还有待获取的网页，聊天等待受总时限约束。 */
  async pendingWeb(
    ownerId: string,
    conversationId: string,
    firstSequence: number,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(
        messageMaterials,
        and(eq(messageMaterials.ownerId, ownerId), eq(messageMaterials.materialId, tasks.id)),
      )
      .innerJoin(
        messages,
        and(eq(messages.ownerId, ownerId), eq(messages.id, messageMaterials.messageId)),
      )
      .where(
        and(
          eq(tasks.ownerId, ownerId),
          eq(tasks.kind, 'material_fetch'),
          inArray(tasks.status, ['queued', 'waiting', 'running']),
          eq(messages.conversationId, conversationId),
          isNull(messages.deletedAt),
          gte(messages.sequence, firstSequence),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  private async requireWebShare(
    ownerId: string,
    lease: TaskLease,
    input: Extract<TaskLease['input'], { kind: 'material_fetch' }>,
    tx: DatabaseTransaction,
  ): Promise<MaterialRow> {
    const scope = lease.task.scope;
    const member = await requireCompanionMember(
      this.database,
      ownerId,
      scope.companionId!,
      scope.runtimeEpoch!,
      scope.conversationId!,
      tx,
    );
    const [share] = await tx
      .select({ sequence: messages.sequence })
      .from(messageMaterials)
      .innerJoin(
        messages,
        and(eq(messages.ownerId, ownerId), eq(messages.id, messageMaterials.messageId)),
      )
      .where(
        and(
          eq(messageMaterials.ownerId, ownerId),
          eq(messageMaterials.materialId, input.materialId),
          eq(messageMaterials.messageId, input.messageId),
          eq(messageMaterials.contentVersion, input.contentVersion),
          eq(messages.contentVersion, input.contentVersion),
          eq(messages.conversationId, scope.conversationId!),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1);
    if (!share?.sequence) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    await assertVisible(member, share.sequence, tx);
    const row = await this.available(ownerId, input.materialId, tx);
    if (row.kind !== 'web' || row.state !== 'pending' || !row.sourceUrl)
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    return row;
  }

  /** 用户明确纠正图片内容时，将原文关联至同会话最近一次图像观察。 */
  async recordCorrection(
    ownerId: string,
    messageId: string,
    scope: TaskScope,
    text: string,
    tx: DatabaseTransaction,
  ): Promise<void> {
    if (!isImageCorrection(text)) return;
    const [latest] = await tx
      .select({ materialId: materialReadings.materialId })
      .from(materialReadings)
      .innerJoin(
        messages,
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.id, materialReadings.messageId),
          isNull(messages.deletedAt),
        ),
      )
      .where(
        and(
          eq(materialReadings.ownerId, ownerId),
          eq(materialReadings.conversationId, scope.conversationId!),
          eq(materialReadings.companionId, scope.companionId!),
          eq(materialReadings.runtimeEpoch, scope.runtimeEpoch!),
          eq(materialReadings.batch, 0),
          isNotNull(materialReadings.modelRequestId),
        ),
      )
      .orderBy(desc(materialReadings.createdAt))
      .limit(1);
    if (latest)
      await tx
        .update(materialReadings)
        .set({ correctedByMessageId: messageId })
        .where(
          and(
            eq(materialReadings.ownerId, ownerId),
            eq(materialReadings.conversationId, scope.conversationId!),
            eq(materialReadings.materialId, latest.materialId),
            eq(materialReadings.companionId, scope.companionId!),
            eq(materialReadings.runtimeEpoch, scope.runtimeEpoch!),
            eq(materialReadings.batch, 0),
            isNotNull(materialReadings.modelRequestId),
          ),
        );
  }

  /** 读取本轮的一张明确共享的图片；已禁用的视觉能力不构造模型调用。 */
  async observe(
    lease: TaskLease,
    triggerMessageId: string,
    firstSequence: number,
    config: ModelConfigurationVersion,
    guard: ModelDispatchGuard,
  ): Promise<
    | {
        materialId: string;
        messageId: string;
        observation: NonNullable<MaterialContext['observation']>;
      }
    | undefined
  > {
    if (!config.config.tasks.perception.enabled) return undefined;
    const ownerId = lease.ownerId;
    const scope = lease.task.scope;
    const selected = await this.store
      .locked(ownerId, async (tx) => {
        await guard(ownerId, tx);
        const trigger = await this.database.messages.findById(ownerId, triggerMessageId, tx);
        if (!trigger || trigger.deletedAt) return undefined;
        const question = trigger.text.slice(0, 2000);
        if (isImageCorrection(question)) return undefined;
        const requestDetail = /图片|截图|照片|小字|局部|底部|顶部|第\s*\d+\s*个区域/u.test(
          question,
        );
        const hasImage = tx
          .select({ position: materialParts.position })
          .from(materialParts)
          .where(
            and(
              eq(materialParts.ownerId, ownerId),
              eq(materialParts.materialId, materialVersions.id),
              eq(materialParts.status, 'image'),
            ),
          );
        const [share] = await tx
          .select({
            row: materialVersions,
            sequence: messages.sequence,
            messageId: messages.id,
          })
          .from(messageMaterials)
          .innerJoin(
            messages,
            and(
              eq(messages.ownerId, ownerId),
              eq(messages.id, messageMaterials.messageId),
              eq(messages.contentVersion, messageMaterials.contentVersion),
            ),
          )
          .innerJoin(
            materialVersions,
            and(
              eq(materialVersions.ownerId, ownerId),
              eq(materialVersions.id, messageMaterials.materialId),
            ),
          )
          .where(
            and(
              eq(messageMaterials.ownerId, ownerId),
              eq(messages.conversationId, scope.conversationId!),
              eq(messages.state, 'published'),
              isNull(messages.deletedAt),
              gte(
                messages.sequence,
                requestDetail ? Math.max(1, firstSequence - 30) : firstSequence,
              ),
              exists(hasImage),
            ),
          )
          .orderBy(desc(messages.sequence), asc(messageMaterials.position))
          .limit(1);
        if (!share?.sequence) return undefined;
        const member = await requireCompanionMember(
          this.database,
          ownerId,
          scope.companionId!,
          scope.runtimeEpoch!,
          scope.conversationId!,
          tx,
        );
        await assertVisible(member, share.sequence, tx);
        const regionNumber = Number(/第\s*(\d+)\s*个区域/u.exec(question)?.[1] ?? 0);
        const position =
          regionNumber ||
          (/底部|末尾/u.test(question)
            ? share.row.partCount
            : /顶部|开头|小字|局部/u.test(question)
              ? 1
              : 0);
        let region = null;
        let asset: MaterialFileReference | null = null;
        if (position || share.row.kind === 'web') {
          const [part] = await tx
            .select({ region: materialParts.region, asset: materialParts.asset })
            .from(materialParts)
            .where(
              and(
                eq(materialParts.ownerId, ownerId),
                eq(materialParts.materialId, share.row.id),
                eq(materialParts.status, 'image'),
                position ? eq(materialParts.position, position) : undefined,
              ),
            )
            .orderBy(asc(materialParts.position))
            .limit(1);
          if (!part?.region) return undefined;
          if (position) region = part.region;
          asset = part.asset;
        }
        const [correction] = await tx
          .select({ text: messages.text })
          .from(materialReadings)
          .innerJoin(
            messages,
            and(
              eq(messages.ownerId, ownerId),
              eq(messages.id, materialReadings.correctedByMessageId),
              eq(messages.conversationId, scope.conversationId!),
              isNull(messages.deletedAt),
            ),
          )
          .where(
            and(
              eq(materialReadings.ownerId, ownerId),
              eq(materialReadings.materialId, share.row.id),
              eq(materialReadings.companionId, scope.companionId!),
              eq(materialReadings.runtimeEpoch, scope.runtimeEpoch!),
              eq(materialReadings.conversationId, scope.conversationId!),
            ),
          )
          .orderBy(desc(messages.sequence))
          .limit(1);
        return {
          ...share,
          asset,
          question,
          region,
          position,
          correction: correction?.text.slice(0, 1000),
        };
      })
      .catch((error: unknown) => {
        if (error instanceof ApiException && error.code === API_CODES.DATA_UNAVAILABLE)
          return undefined;
        throw error;
      });
    if (!selected) return undefined;
    let image: Buffer;
    try {
      const original = selected.asset
        ? await this.files.read(ownerId, selected.asset)
        : await this.readFile(ownerId, selected.row);
      image = await renderMaterialImage(original, this.limits, selected.region ?? undefined);
    } catch {
      return undefined;
    }
    const idHash = createHash('sha256')
      .update(`perception-v1:${lease.task.id}:${selected.row.id}:${selected.position}`)
      .digest('hex');
    const requestId = `${idHash.slice(0, 8)}-${idHash.slice(8, 12)}-4${idHash.slice(13, 16)}-8${idHash.slice(17, 20)}-${idHash.slice(20, 32)}`;
    try {
      const call = await this.models.executeVision(
        ownerId,
        {
          requestId,
          expectedConfigVersion: config.version,
          role: 'perception',
          operation: 'structured',
          lane: 'interactive',
          inputText: JSON.stringify({
            materialVersion: selected.row.id,
            region: selected.region,
            question: selected.question,
            userCorrection: selected.correction,
          }),
        },
        perceptionDefinition,
        image,
        scope,
        async (ownerId, tx) => {
          await guard(ownerId, tx);
          const source = await this.database.messages.findById(ownerId, selected.messageId, tx);
          if (!source || source.deletedAt) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
          const member = await requireCompanionMember(
            this.database,
            ownerId,
            scope.companionId!,
            scope.runtimeEpoch!,
            scope.conversationId!,
            tx,
          );
          await assertVisible(member, selected.sequence!, tx);
          await tx
            .insert(materialReadings)
            .values({
              ownerId,
              materialId: selected.row.id,
              messageId: selected.messageId,
              contentVersion: source.contentVersion,
              companionId: scope.companionId!,
              runtimeEpoch: scope.runtimeEpoch!,
              conversationId: scope.conversationId!,
              runId: lease.task.id,
              modelRequestId: requestId,
              region: selected.region,
              excerpts: [],
            })
            .onDuplicateKeyUpdate({ set: { modelRequestId: requestId } });
        },
      );
      if (call.status !== 'succeeded' || call.result?.kind !== 'structured') return undefined;
      const value = perceptionOutputSchema.parse(call.result.value);
      return {
        materialId: selected.row.id,
        messageId: selected.messageId,
        observation: { ...value, modelCallId: call.id, region: selected.region },
      };
    } catch (error) {
      if (
        error instanceof ApiException &&
        (
          [
            API_CODES.INVALID_REQUEST,
            API_CODES.MODEL_NOT_CONFIGURED,
            API_CODES.MODEL_CAPACITY_EXCEEDED,
            API_CODES.MODEL_BUDGET_EXCEEDED,
          ] as number[]
        ).includes(error.code)
      )
        return undefined;
      throw error;
    }
  }

  /** 定期回收失效或过期原件，每次只推进一页。 */
  async sweep(ownerId: string): Promise<void> {
    if (Date.now() - this.lastSweep < 30_000) return;
    this.lastSweep = Date.now();
    await this.cleanupPage(ownerId);
    const candidates = await this.files.staleCandidates(
      ownerId,
      this.sweepCursors.get(ownerId) ?? '',
      new Date(Date.now() - 86_400_000),
    );
    this.sweepCursors.set(ownerId, candidates.after);
    for (const item of candidates.entries) {
      if (item.temporary) {
        await this.files.removeTemporary(ownerId, item.fileId);
        continue;
      }
      const [original] = await this.database.sql
        .select({ id: materialVersions.id })
        .from(materialVersions)
        .where(and(eq(materialVersions.ownerId, ownerId), eq(materialVersions.fileId, item.fileId)))
        .limit(1);
      if (original) continue;
      const [asset] = await this.database.sql
        .select({ id: materialParts.materialId })
        .from(materialParts)
        .where(
          and(
            eq(materialParts.ownerId, ownerId),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${materialParts.asset}, '$.fileId')) = ${item.fileId}`,
          ),
        )
        .limit(1);
      if (!asset) await this.files.remove(ownerId, item.fileId);
    }
  }

  /** 完成生命周期阶段的一页清理，原件操作在提交围栏外执行。 */
  async cleanupPage(
    ownerId: string,
    guard?: ModelDispatchGuard,
    oldScope?: { companionId: string; previousEpoch: number },
  ): Promise<boolean> {
    const prepared = await this.store.locked(ownerId, async (tx, now) => {
      await guard?.(ownerId, tx);
      let readCount = 0;
      if (oldScope) {
        const old = and(
          eq(materialReadings.ownerId, ownerId),
          eq(materialReadings.companionId, oldScope.companionId),
          lte(materialReadings.runtimeEpoch, oldScope.previousEpoch),
        );
        readCount = (await tx.delete(materialReadings).where(old).limit(20))[0].affectedRows;
      }
      const removed = await tx
        .select({ share: messageMaterials })
        .from(messageMaterials)
        .innerJoin(
          messages,
          and(
            eq(messages.ownerId, ownerId),
            eq(messages.id, messageMaterials.messageId),
            eq(messages.contentVersion, messageMaterials.contentVersion),
          ),
        )
        .where(and(eq(messageMaterials.ownerId, ownerId), isNotNull(messages.deletedAt)))
        .limit(20);
      for (const { share } of removed) {
        const scope = and(
          eq(materialReadings.ownerId, ownerId),
          eq(materialReadings.messageId, share.messageId),
          eq(materialReadings.materialId, share.materialId),
        );
        const reads = tx
          .select({ id: materialReadings.modelCallId })
          .from(materialReadings)
          .where(scope);
        const requests = tx
          .select({ id: materialReadings.modelRequestId })
          .from(materialReadings)
          .where(scope);
        await tx
          .update(modelCalls)
          .set({
            invalidatedAt: now,
            result: null,
            status: sql`CASE WHEN ${modelCalls.status} = 'running' THEN 'cancelled' ELSE ${modelCalls.status} END`,
          })
          .where(
            and(
              eq(modelCalls.ownerId, ownerId),
              or(inArray(modelCalls.id, reads), inArray(modelCalls.requestId, requests)),
            ),
          );
        await tx
          .delete(messageMaterials)
          .where(
            and(
              eq(messageMaterials.ownerId, ownerId),
              eq(messageMaterials.messageId, share.messageId),
              eq(messageMaterials.contentVersion, share.contentVersion),
              eq(messageMaterials.materialId, share.materialId),
            ),
          );
      }
      const expired = await tx
        .select()
        .from(materialVersions)
        .where(
          and(
            eq(materialVersions.ownerId, ownerId),
            notExists(this.activeReferences(ownerId, tx)),
            or(
              isNotNull(materialVersions.sharedAt),
              lt(materialVersions.createdAt, new Date(now.getTime() - 86_400_000)),
            ),
          ),
        )
        .limit(20);
      const files = new Set<string>();
      for (const row of expired) {
        const assets = await tx
          .selectDistinct({ asset: materialParts.asset })
          .from(materialParts)
          .where(
            and(
              eq(materialParts.ownerId, ownerId),
              eq(materialParts.materialId, row.id),
              isNotNull(materialParts.asset),
            ),
          );
        for (const { asset } of assets) if (asset) files.add(asset.fileId);
        if (row.fileId) files.add(row.fileId);
      }
      // 过期临时上传先进入不可附加状态，防止文件删除期间被新的发送引用。
      if (expired.length)
        await tx
          .update(materialVersions)
          .set({ sharedAt: now, state: 'unavailable', reason: 'expired' })
          .where(
            and(
              eq(materialVersions.ownerId, ownerId),
              isNull(materialVersions.sharedAt),
              inArray(
                materialVersions.id,
                expired.map((row) => row.id),
              ),
            ),
          );
      return { expired, files, changed: Boolean(removed.length || expired.length || readCount) };
    });
    if (prepared.expired.length) {
      for (const id of prepared.files) await this.files.remove(ownerId, id);
      await this.store.locked(ownerId, async (tx) => {
        await guard?.(ownerId, tx);
        await tx.delete(materialVersions).where(
          and(
            eq(materialVersions.ownerId, ownerId),
            inArray(
              materialVersions.id,
              prepared.expired.map((row) => row.id),
            ),
            notExists(this.activeReferences(ownerId, tx)),
          ),
        );
      });
    }
    return prepared.changed;
  }

  private activeReferences(ownerId: string, tx: DatabaseTransaction) {
    return tx
      .select({ id: messageMaterials.materialId })
      .from(messageMaterials)
      .where(
        and(
          eq(messageMaterials.ownerId, ownerId),
          eq(messageMaterials.materialId, materialVersions.id),
        ),
      );
  }

  /** 读取一个临时上传或仍有合法分享的材料状态。 */
  async describe(ownerId: string, id: string): Promise<MaterialSummary> {
    const row = await this.available(ownerId, id, this.database.sql);
    if (row.fileId) {
      try {
        await this.readFile(ownerId, row);
      } catch {
        return materialSummary({ ...row, state: 'unavailable', reason: 'original-unavailable' });
      }
    }
    if (row.kind === 'web' && row.state === 'pending') {
      const job = await this.database.tasks.findById(ownerId, row.id);
      if (job && ['failed', 'blocked', 'cancelled'].includes(job.status))
        return materialSummary({ ...row, state: 'unavailable', reason: job.reason ?? job.status });
    }
    return materialSummary(row);
  }

  /** 分页返回有序片段，不返回原始 HTML。 */
  async parts(ownerId: string, id: string, query: MaterialPartsQuery): Promise<MaterialPartsPage> {
    return this.store.locked(ownerId, async (tx) => {
      const row = await this.available(ownerId, id, tx);
      const items = await tx
        .select({
          position: materialParts.position,
          page: materialParts.page,
          status: materialParts.status,
          text: materialParts.text,
          region: materialParts.region,
        })
        .from(materialParts)
        .where(
          and(
            eq(materialParts.ownerId, ownerId),
            eq(materialParts.materialId, row.id),
            gt(materialParts.position, query.after),
          ),
        )
        .orderBy(asc(materialParts.position))
        .limit(query.limit + 1);
      return {
        items: items.slice(0, query.limit),
        nextAfter: items.length > query.limit ? items[query.limit - 1]!.position : null,
      };
    });
  }

  /** 原件读取与删除互斥，缺失或损坏不能当作成功。 */
  async original(ownerId: string, id: string): Promise<{ row: MaterialSummary; bytes: Buffer }> {
    const row = await this.available(ownerId, id, this.database.sql);
    const bytes = await this.readFile(ownerId, row);
    await this.available(ownerId, id, this.database.sql);
    return { row: materialSummary(row), bytes };
  }

  /** 缩略图始终由服务端从合法原件生成，不向客户端暴露第三方图片地址。 */
  async preview(ownerId: string, id: string, position?: number): Promise<Buffer> {
    const selected = await this.store.locked(ownerId, async (tx) => {
      const row = await this.available(ownerId, id, tx);
      const [part] = await tx
        .select({ region: materialParts.region, asset: materialParts.asset })
        .from(materialParts)
        .where(
          and(
            eq(materialParts.ownerId, ownerId),
            eq(materialParts.materialId, id),
            eq(materialParts.status, 'image'),
            position ? eq(materialParts.position, position) : undefined,
          ),
        )
        .orderBy(asc(materialParts.position))
        .limit(1);
      if (!part) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      return { row, asset: part.asset, region: position ? (part.region ?? undefined) : undefined };
    });
    const bytes = selected.asset
      ? await this.files.read(ownerId, selected.asset)
      : await this.readFile(ownerId, selected.row);
    const thumbnail = await renderMaterialImage(bytes, this.limits, selected.region, 512);
    await this.available(ownerId, id, this.database.sql);
    return thumbnail;
  }

  async saveParts(
    ownerId: string,
    id: string,
    parts: StoredPart[],
    tx: DatabaseTransaction,
  ): Promise<void> {
    for (let index = 0; index < parts.length; index += 100)
      await tx
        .insert(materialParts)
        .values(
          parts.slice(index, index + 100).map((part) => ({ ...part, ownerId, materialId: id })),
        );
  }

  private async hasQuota(ownerId: string, extra: number, db: QueryDatabase): Promise<boolean> {
    const [storage] = await db
      .select({ bytes: sql<string>`COALESCE(SUM(${materialVersions.byteLength}), 0)` })
      .from(materialVersions)
      .where(eq(materialVersions.ownerId, ownerId));
    return Number(storage?.bytes ?? 0) + extra <= this.limits.maxStorageBytes;
  }

  private async hasSpace(ownerId: string, extra: number, db: QueryDatabase): Promise<boolean> {
    await mkdir(this.configuration.dataDir, { recursive: true, mode: 0o700 });
    const disk = await statfs(this.configuration.dataDir);
    return (
      disk.bavail * disk.bsize >= extra + this.limits.minFreeBytes &&
      (await this.hasQuota(ownerId, extra, db))
    );
  }

  private async parseUpload(input: MaterialUpload, bytes: Buffer): Promise<MaterialPart[]> {
    try {
      const result = await extractMaterial(
        { kind: 'upload', format: input.kind, bytes },
        this.limits,
      );
      if (result.kind !== 'upload') throw new Error('invalid-worker-result');
      return result.parts;
    } catch (error) {
      const reason = error instanceof MaterialWorkerError ? error.reason : 'extraction-failed';
      throw new ApiException(API_CODES.INVALID_REQUEST, `无法提取材料（${reason}）。`);
    }
  }

  private async lookup(
    ownerId: string,
    requestId: string,
    db: QueryDatabase,
  ): Promise<MaterialRow | undefined> {
    const [row] = await db
      .select()
      .from(materialVersions)
      .where(and(eq(materialVersions.ownerId, ownerId), eq(materialVersions.requestId, requestId)))
      .limit(1);
    return row;
  }

  private async replay(
    ownerId: string,
    row: MaterialRow,
    digest: string,
    db: QueryDatabase,
  ): Promise<MaterialSummary> {
    if (row.fingerprint !== digest) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
    const current = await this.available(ownerId, row.id, db);
    await this.readFile(ownerId, current);
    return materialSummary(current);
  }

  private async available(ownerId: string, id: string, db: QueryDatabase): Promise<MaterialRow> {
    const [row] = await db
      .select()
      .from(materialVersions)
      .where(and(eq(materialVersions.ownerId, ownerId), eq(materialVersions.id, id)))
      .limit(1);
    if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    if (!row.sharedAt) return row;
    const [share] = await db
      .select({ id: messageMaterials.messageId })
      .from(messageMaterials)
      .innerJoin(
        messages,
        and(
          eq(messages.ownerId, ownerId),
          eq(messages.id, messageMaterials.messageId),
          eq(messages.contentVersion, messageMaterials.contentVersion),
        ),
      )
      .innerJoin(
        conversations,
        and(eq(conversations.ownerId, ownerId), eq(conversations.id, messages.conversationId)),
      )
      .where(
        and(
          eq(messageMaterials.ownerId, ownerId),
          eq(messageMaterials.materialId, id),
          eq(messages.state, 'published'),
          isNull(messages.deletedAt),
          isNull(conversations.lifecycleOperationId),
        ),
      )
      .limit(1);
    if (!share) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    return row;
  }

  private async readFile(ownerId: string, row: MaterialRow): Promise<Buffer> {
    if (!row.fileId || !row.hash) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
    try {
      return await this.files.read(ownerId, {
        fileId: row.fileId,
        hash: row.hash,
        byteLength: row.byteLength,
      });
    } catch {
      throw new ApiException(API_CODES.DATA_UNAVAILABLE, '原件缺失或已损坏。');
    }
  }
}

/** 识别正文中实际分享的 HTTP(S) URL，去除展示性结尾标点。 */
export function sharedLinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"`，。！？、；）】]+/giu)) {
    try {
      const url = new URL(match[0].replace(/[.,!?;)\]]+$/u, ''));
      if (url.username || url.password) continue;
      url.hash = '';
      links.add(url.href);
    } catch {
      continue;
    }
  }
  return [...links];
}

/** 仅识别明确提到图片并直接更正的短语，保留普通聊天中的其他否定句。 */
function isImageCorrection(text: string): boolean {
  return /照片|图片|截图|图里/u.test(text) && /不是|更正|纠正|说错/u.test(text);
}

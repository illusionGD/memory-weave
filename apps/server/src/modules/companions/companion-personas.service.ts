import { API_CODES, personaDocumentSchema } from '@memory-weave/contracts';
import type {
  CompanionCreation,
  CompanionPersonaState,
  ModelConfigurationVersion,
  PersonaDocument,
  PersonaVersion,
  RevisePersonaLocks,
  InitializePersona,
} from '@memory-weave/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../database/database.service';
import {
  companions,
  personaFoundations,
  personaVersions,
  tasks,
  modelCalls,
  modelAttempts,
} from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { fingerprint } from '../shared/http';
import { ModelConfigurationService } from '../models/model-configuration.service';
import { ModelRuntimeService } from '../models/model-runtime.service';
import { TaskStore } from '../tasks/task-store';
import { TasksService } from '../tasks/tasks.service';
import type { TaskLease } from '../tasks/task-types';
import { CompanionsService } from './companions.service';
import { PersonaTemplatesService } from './persona-templates.service';
import { toPersonaVersion } from './persona-version';
import {
  initialPersonaDefinition,
  initialPersonaOutputSchema,
  PERSONA_DEFINITION_VERSION,
} from './persona-definition';

/** 原稿先落盘，模型结果经校验后与任务完成状态一起采用。 */
@Injectable()
export class CompanionPersonasService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(TasksService) private readonly jobs: TasksService,
    @Inject(CompanionsService) private readonly instances: CompanionsService,
    @Inject(PersonaTemplatesService) private readonly templates: PersonaTemplatesService,
    @Inject(ModelConfigurationService) private readonly configuration: ModelConfigurationService,
    @Inject(ModelRuntimeService) private readonly models: ModelRuntimeService,
  ) {}

  /** 创建命令只保存原稿和任务，不在 HTTP 请求中等待模型。 */
  async create(input: CompanionCreation): Promise<CompanionPersonaState> {
    const hash = fingerprint(input);
    const replayId = await this.store.locked(async (ownerId, tx) => {
      const [row] = await tx
        .select()
        .from(personaFoundations)
        .where(
          and(
            eq(personaFoundations.ownerId, ownerId),
            eq(personaFoundations.requestId, input.requestId),
          ),
        );
      if (row && row.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
      return row?.companionId;
    });
    if (replayId) return this.get(replayId);
    const template =
      input.source.kind === 'template'
        ? await this.templates.get(input.source.template.id, input.source.template.version)
        : null;
    const profileText =
      input.source.kind === 'text' ? input.source.profileText : template!.initialProfile;
    const explicitLocks =
      input.source.kind === 'text' ? input.source.lockedFeatures : template!.lockedFeatures;
    const configuration = await this.activateDefinition();
    const companionId = await this.store.locked(async (ownerId, tx) => {
      // 配置读取在调度锁之外；并发重复命令仍在这里重查。
      const [replay] = await tx
        .select()
        .from(personaFoundations)
        .where(
          and(
            eq(personaFoundations.ownerId, ownerId),
            eq(personaFoundations.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (replay.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return replay.companionId;
      }
      const companion = await this.instances.createInTransaction(ownerId, tx, {
        requestId: input.requestId,
        name: input.name ?? '正在认识的新伴侣',
        initialProfile: profileText,
      });
      const taskId = randomUUID();
      await tx.insert(tasks).values({
        id: taskId,
        ownerId,
        requestKey: `persona_initialization:${input.requestId.toLowerCase()}`,
        fingerprint: hash,
        kind: 'persona_initialization',
        input: {
          kind: 'persona_initialization',
          profileText,
          expectedPersonaVersionId: companion.currentPersonaVersionId,
          configVersion: configuration.version,
        },
        scope: {
          companionId: companion.id,
          runtimeEpoch: companion.runtimeEpoch,
          conversationId: null,
        },
        totalSteps: 1,
      });
      await tx.insert(personaFoundations).values({
        ownerId,
        companionId: companion.id,
        runtimeEpoch: companion.runtimeEpoch,
        requestId: input.requestId,
        fingerprint: hash,
        nameOverride: input.name ?? null,
        template: template ? { id: template.id, version: template.version } : null,
        explicitLocks,
        taskId,
      });
      return companion.id;
    });
    return this.get(companionId);
  }

  /** 旧实例不自动收费；管理者主动开始或重试才创建新的调用身份。 */
  async initialize(id: string, input: InitializePersona): Promise<CompanionPersonaState> {
    const requestKey = `persona_initialize:${id}:${input.requestId.toLowerCase()}`;
    const hash = fingerprint(input);
    const replay = await this.store.locked(async (ownerId, tx) => {
      const [row] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.requestKey, requestKey)));
      if (row && row.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
      return Boolean(row);
    });
    if (replay) return this.get(id);
    const config = await this.activateDefinition();
    await this.store.locked(async (ownerId, tx) => {
      const [existing] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerId, ownerId), eq(tasks.requestKey, requestKey)));
      if (existing) {
        if (existing.fingerprint !== hash) throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return;
      }
      const companion = await this.instances.readInTransaction(tx, ownerId, id);
      if (
        companion.runtimeEpoch !== input.runtimeEpoch ||
        companion.currentPersonaVersion.version !== input.expectedPersonaVersion
      )
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (companion.currentPersonaVersion.document)
        throw new ApiException(API_CODES.CONFLICT, '初始整理已经完成，不能重新生成初始人生。');
      const [foundation] = await tx
        .select()
        .from(personaFoundations)
        .where(
          and(
            eq(personaFoundations.ownerId, ownerId),
            eq(personaFoundations.companionId, id),
            eq(personaFoundations.runtimeEpoch, input.runtimeEpoch),
          ),
        );
      if (foundation) {
        const previous = await this.jobs.getInTransaction(ownerId, foundation.taskId, tx);
        if (!['failed', 'cancelled'].includes(previous.status))
          throw new ApiException(
            API_CODES.TASK_STATE_CONFLICT,
            '当前任务仍可继续或需要核对，请勿重复发起。',
          );
        if (previous.modelCallId) {
          const [call] = await tx
            .select({ status: modelCalls.status })
            .from(modelCalls)
            .where(and(eq(modelCalls.ownerId, ownerId), eq(modelCalls.id, previous.modelCallId)));
          const unknownAttempts = await tx
            .select({ id: modelAttempts.id })
            .from(modelAttempts)
            .where(
              and(
                eq(modelAttempts.ownerId, ownerId),
                eq(modelAttempts.callId, previous.modelCallId),
                eq(modelAttempts.status, 'unknown'),
              ),
            )
            .limit(1);
          if (call?.status === 'unknown' || unknownAttempts.length > 0)
            throw new ApiException(
              API_CODES.MODEL_USAGE_UNKNOWN,
              '上次外部调用结果尚不明确，请先核对模型调用记录。',
            );
        }
      }
      const taskId = randomUUID();
      await tx.insert(tasks).values({
        id: taskId,
        ownerId,
        requestKey,
        fingerprint: hash,
        kind: 'persona_initialization',
        input: {
          kind: 'persona_initialization',
          profileText: companion.initialSnapshot.profileText,
          expectedPersonaVersionId: companion.currentPersonaVersionId,
          configVersion: config.version,
        },
        scope: { companionId: id, runtimeEpoch: input.runtimeEpoch, conversationId: null },
        totalSteps: 1,
      });
      if (foundation)
        await tx
          .update(personaFoundations)
          .set({ taskId })
          .where(eq(personaFoundations.id, foundation.id));
      else
        await tx.insert(personaFoundations).values({
          ownerId,
          companionId: id,
          runtimeEpoch: input.runtimeEpoch,
          requestId: input.requestId,
          fingerprint: hash,
          nameOverride: companion.name,
          explicitLocks: [],
          taskId,
        });
    });
    return this.get(id);
  }

  /** 一致读取当前版本、初始基线和任务，不把刷新误当成重新生成。 */
  get(id: string): Promise<CompanionPersonaState> {
    return this.store.locked(async (ownerId, tx) => {
      const companion = await this.instances.readInTransaction(tx, ownerId, id);
      const [foundation] = await tx
        .select()
        .from(personaFoundations)
        .where(
          and(
            eq(personaFoundations.ownerId, ownerId),
            eq(personaFoundations.companionId, id),
            eq(personaFoundations.runtimeEpoch, companion.runtimeEpoch),
          ),
        );
      const [initial] = foundation?.initialPersonaVersionId
        ? await tx
            .select()
            .from(personaVersions)
            .where(
              and(
                eq(personaVersions.ownerId, ownerId),
                eq(personaVersions.companionId, id),
                eq(personaVersions.id, foundation.initialPersonaVersionId),
              ),
            )
        : [];
      return {
        companion,
        initialPersonaVersion: initial ? toPersonaVersion(initial) : null,
        task: foundation ? await this.jobs.getInTransaction(ownerId, foundation.taskId, tx) : null,
        template: foundation?.template ?? null,
      };
    });
  }

  /** 精确查询所属实例、代次与版本，不能仅凭版本标识跨实例读取。 */
  version(id: string, runtimeEpoch: number, version: number): Promise<PersonaVersion> {
    return this.database.withOwner(async (ownerId, db) => {
      const [row] = await db
        .select()
        .from(personaVersions)
        .where(
          and(
            eq(personaVersions.ownerId, ownerId),
            eq(personaVersions.companionId, id),
            eq(personaVersions.runtimeEpoch, runtimeEpoch),
            eq(personaVersions.version, version),
          ),
        );
      if (!row) throw new ApiException(API_CODES.RESOURCE_NOT_FOUND);
      return toPersonaVersion(row);
    });
  }

  /** 管理者显式修改约束时追加版本；不改原稿、初始人格或其他人格内容。 */
  reviseLocks(id: string, input: RevisePersonaLocks): Promise<PersonaVersion> {
    return this.store.locked(async (ownerId, tx) => {
      const hash = fingerprint(input);
      const [replay] = await tx
        .select()
        .from(personaVersions)
        .where(
          and(
            eq(personaVersions.ownerId, ownerId),
            eq(personaVersions.companionId, id),
            eq(personaVersions.commandId, input.requestId),
          ),
        );
      if (replay) {
        if (replay.commandFingerprint !== hash)
          throw new ApiException(API_CODES.IDEMPOTENCY_CONFLICT);
        return toPersonaVersion(replay);
      }
      const companion = await this.instances.readInTransaction(tx, ownerId, id);
      const parent = companion.currentPersonaVersion;
      if (
        companion.runtimeEpoch !== input.runtimeEpoch ||
        parent.version !== input.expectedPersonaVersion
      )
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      if (!parent.document) throw new ApiException(API_CODES.CONFLICT, '请先完成初始人格整理。');
      if (parent.version >= 2_147_483_647 || companion.version >= 2_147_483_647)
        throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const locks = [...new Set(input.lockedFeatures)].map((text) => ({
        text,
        source:
          parent.document!.locks.find((lock) => lock.text === text)?.source ??
          ('explicit' as const),
      }));
      const row = {
        id: randomUUID(),
        ownerId,
        companionId: id,
        runtimeEpoch: input.runtimeEpoch,
        version: parent.version + 1,
        profileText: parent.profileText,
        document: { ...parent.document, locks },
        origin: 'lock_revision' as const,
        parentVersionId: parent.id,
        modelCallId: null,
        mode: parent.mode,
        commandId: input.requestId,
        commandFingerprint: hash,
        createdAt: new Date(),
      };
      await tx.insert(personaVersions).values(row);
      await tx
        .update(companions)
        .set({ currentPersonaVersionId: row.id, version: companion.version + 1 })
        .where(and(eq(companions.ownerId, ownerId), eq(companions.id, id)));
      return toPersonaVersion(row);
    });
  }

  /** worker 执行受信任的初始整理；任何恢复都沿用任务对应的模型请求身份。 */
  async execute(lease: TaskLease): Promise<void> {
    if (lease.input.kind !== 'persona_initialization')
      throw new ApiException(API_CODES.TASK_STATE_CONFLICT);
    const input = lease.input;
    let call = await this.models.execute(
      {
        requestId: lease.task.id,
        expectedConfigVersion: input.configVersion,
        role: 'persona',
        operation: 'structured',
        inputText: input.profileText,
        lane: 'interactive',
      },
      initialPersonaDefinition,
      lease.task.scope,
      (ownerId, tx) => this.jobs.guardDispatch(ownerId, tx, lease),
    );
    while (call.status === 'running') {
      await delay(lease.config.pollMs);
      await this.jobs.heartbeat(lease);
      call = await this.models.get(call.id);
    }
    await this.jobs.checkpoint(lease, {
      completedSteps: call.status === 'succeeded' ? 1 : 0,
      stage: 'persona_result',
      modelCallId: call.id,
    });
    if (call.status === 'unknown') {
      await this.jobs.block(lease, 'model_result_unknown');
      return;
    }
    if (call.status !== 'succeeded' || call.result?.kind !== 'structured') {
      await this.jobs.fail(lease, call.status === 'cancelled' ? 'model_cancelled' : 'model_failed');
      return;
    }
    const output = initialPersonaOutputSchema.safeParse(call.result.value);
    if (
      !output.success ||
      [...output.data.core, ...output.data.inclinations, ...output.data.knowledge].some(
        (item) => !input.profileText.includes(item.evidence),
      ) ||
      output.data.lockedQuotes.some((quote) => !input.profileText.includes(quote))
    )
      throw new ApiException(API_CODES.MODEL_OUTPUT_INVALID);
    const result = output.data;
    await this.jobs.complete(lease, async (ownerId, tx) => {
      const id = lease.task.scope.companionId!;
      const [companion] = await tx
        .select()
        .from(companions)
        .where(and(eq(companions.ownerId, ownerId), eq(companions.id, id)))
        .for('update');
      const [foundation] = await tx
        .select()
        .from(personaFoundations)
        .where(
          and(
            eq(personaFoundations.ownerId, ownerId),
            eq(personaFoundations.companionId, id),
            eq(personaFoundations.runtimeEpoch, lease.task.scope.runtimeEpoch!),
          ),
        )
        .for('update');
      if (
        !companion ||
        !foundation ||
        foundation.taskId !== lease.task.id ||
        foundation.initialPersonaVersionId ||
        companion.currentPersonaVersionId !== input.expectedPersonaVersionId
      )
        throw new ApiException(API_CODES.VERSION_CONFLICT);
      const name = foundation.nameOverride ?? result.name;
      const locks: PersonaDocument['locks'] = [
        ...[...new Set(foundation.explicitLocks)].map((text) => ({
          text,
          source: 'explicit' as const,
        })),
        ...[...new Set(result.lockedQuotes)]
          .filter((quote) => !foundation.explicitLocks.includes(quote))
          .map((text) => ({ text, source: 'profile' as const })),
      ];
      const document = personaDocumentSchema.parse({
        schemaVersion: 1,
        sourceKind: 'initial_setting',
        name,
        core: result.core,
        inclinations: result.inclinations,
        knowledge: result.knowledge,
        locks,
      });
      const [parent] = await tx
        .select()
        .from(personaVersions)
        .where(
          and(
            eq(personaVersions.ownerId, ownerId),
            eq(personaVersions.companionId, id),
            eq(personaVersions.id, input.expectedPersonaVersionId),
          ),
        );
      if (!parent || parent.version >= 2_147_483_647 || companion.version >= 2_147_483_647)
        throw new ApiException(API_CODES.VERSION_LIMIT_REACHED);
      const personaId = randomUUID();
      await tx.insert(personaVersions).values({
        id: personaId,
        ownerId,
        companionId: id,
        runtimeEpoch: companion.runtimeEpoch,
        version: parent.version + 1,
        profileText: input.profileText,
        document,
        origin: 'initialization',
        parentVersionId: parent.id,
        modelCallId: call.id,
        mode: call.providerId === 'test' ? 'test' : 'model',
      });
      await tx
        .update(companions)
        .set({ name, currentPersonaVersionId: personaId, version: companion.version + 1 })
        .where(eq(companions.id, id));
      await tx
        .update(personaFoundations)
        .set({ initialPersonaVersionId: personaId })
        .where(eq(personaFoundations.id, foundation.id));
    });
  }

  /** 仅在显式创建时替换旧诊断占位定义；保留模型、价格、限额和历史配置。 */
  private async activateDefinition(): Promise<ModelConfigurationVersion> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.configuration.get();
      const persona = current.config.tasks.persona;
      if (
        persona.promptVersion === PERSONA_DEFINITION_VERSION &&
        persona.schemaVersion === PERSONA_DEFINITION_VERSION &&
        persona.preprocessingVersion === 'utf8-v1'
      )
        return current;
      if (
        persona.promptVersion !== 'probe-v1' ||
        persona.schemaVersion !== 'probe-v1' ||
        persona.preprocessingVersion !== 'utf8-v1'
      )
        throw new ApiException(
          API_CODES.MODEL_NOT_CONFIGURED,
          '人格整理定义与当前模型配置不匹配，请检查 persona 配置。',
        );
      try {
        return await this.configuration.update({
          requestId: randomUUID(),
          expectedVersion: current.version,
          config: {
            ...current.config,
            tasks: {
              ...current.config.tasks,
              persona: {
                ...persona,
                promptVersion: PERSONA_DEFINITION_VERSION,
                schemaVersion: PERSONA_DEFINITION_VERSION,
              },
            },
          },
          evaluationNote: 'F05 首次创建启用人格整理定义；保留现有模型、供应商、价格和限额。',
        });
      } catch (error) {
        if (!(error instanceof ApiException) || error.code !== API_CODES.VERSION_CONFLICT)
          throw error;
      }
    }
    throw new ApiException(API_CODES.VERSION_CONFLICT);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { API_CODES } from '@memory-weave/contracts';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { SERVER_CONFIG } from '../../config';
import type { ServerConfig } from '../../config';
import { DatabaseService } from '../../database/database.service';
import type { DatabaseTransaction } from '../../database/database.service';
import { autonomyUsage, modelAttempts } from '../../database/schema';
import { ApiException } from '../../http/api-exception';
import { taskDatabaseTime } from '../tasks/task-store';
import { autonomyConfigurationSchema } from './autonomy-config';
import type { AutonomyConfiguration } from './autonomy-config';

type Kind = typeof autonomyUsage.$inferSelect.kind;
const formats = new Map<string, Intl.DateTimeFormat>();

/** 用部署时区取得同一实际时间的本地日和小时。 */
function localTime(date: Date, zone: string): { day: string; hour: number } {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      calendar: 'gregory',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(zone, format);
  }
  const parts = new Map(format.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    day: `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`,
    hour: Number(parts.get('hour')),
  };
}

/** 机会、实际调用与用户级联系的额度在调度锁内原子计量。 */
@Injectable()
export class AutonomyBudget {
  readonly limits: Readonly<AutonomyConfiguration>;

  /** 初始化集中部署参数。 */
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SERVER_CONFIG) config: ServerConfig,
  ) {
    this.limits = autonomyConfigurationSchema.parse(config.autonomyConfiguration ?? {});
  }

  /** 统计当前本地日和现存旧时区窗口的合计，切换时区不能重新获得同日额度。 */
  async count(
    ownerId: string,
    kind: Kind,
    companionId: string | null,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<number> {
    const zone = this.limits.timeZone;
    const today = localTime(now, zone).day;
    const rows = await tx
      .select({ occurredAt: autonomyUsage.createdAt, zone: autonomyUsage.timeZone })
      .from(autonomyUsage)
      .where(
        and(
          eq(autonomyUsage.ownerId, ownerId),
          eq(autonomyUsage.kind, kind),
          companionId
            ? eq(autonomyUsage.companionId, companionId)
            : isNull(autonomyUsage.companionId),
          gte(autonomyUsage.createdAt, new Date(now.getTime() - 72 * 3600000)),
        ),
      );
    return rows.filter(
      ({ occurredAt, zone: oldZone }) =>
        localTime(occurredAt, zone).day === today ||
        (oldZone !== zone && localTime(occurredAt, oldZone).day === localTime(now, oldZone).day),
    ).length;
  }

  /** 读取计量最近一次事件时间，短间隔按实际经过时间。 */
  async lastOpportunity(
    ownerId: string,
    companionId: string,
    tx: DatabaseTransaction,
  ): Promise<Date | undefined> {
    const [row] = await tx
      .select({ at: autonomyUsage.createdAt })
      .from(autonomyUsage)
      .where(
        and(
          eq(autonomyUsage.ownerId, ownerId),
          eq(autonomyUsage.kind, 'exploration'),
          eq(autonomyUsage.companionId, companionId),
        ),
      )
      .orderBy(desc(autonomyUsage.createdAt))
      .limit(1);
    return row?.at;
  }

  /** 用稳定事件身份登记一次实际额度。 */
  async record(
    ownerId: string,
    kind: Kind,
    companionId: string | null,
    key: string,
    now: Date,
    tx: DatabaseTransaction,
  ): Promise<void> {
    await tx
      .insert(autonomyUsage)
      .values({ ownerId, kind, companionId, key, timeZone: this.limits.timeZone, createdAt: now });
  }

  /** 保留新模型尝试的额外限额，恢复已确认结果不会再次计入。 */
  async model(
    ownerId: string,
    companionId: string,
    requestId: string,
    tx: DatabaseTransaction,
  ): Promise<void> {
    const call = await this.database.modelCalls.findOne(ownerId, { where: { requestId } }, tx);
    if (call && call.status !== 'running') return;
    const [attempt] = call
      ? await tx
          .select({ number: modelAttempts.number })
          .from(modelAttempts)
          .where(
            and(
              eq(modelAttempts.ownerId, ownerId),
              eq(modelAttempts.callId, call.id),
              eq(modelAttempts.status, 'running'),
            ),
          )
          .orderBy(desc(modelAttempts.number))
          .limit(1)
      : [];
    const key = call && attempt ? `${call.id}:${attempt.number}` : null;
    if (key) {
      const [record] = await tx
        .select({ id: autonomyUsage.id })
        .from(autonomyUsage)
        .where(
          and(
            eq(autonomyUsage.ownerId, ownerId),
            eq(autonomyUsage.kind, 'model'),
            eq(autonomyUsage.key, key),
          ),
        )
        .limit(1);
      if (record) return;
    }
    const now = await taskDatabaseTime(this.database, ownerId, tx);
    if ((await this.count(ownerId, 'model', companionId, now, tx)) >= this.limits.modelCallsPerDay)
      throw new ApiException(API_CODES.AUTONOMY_DAILY_LIMIT);
    if (key) await this.record(ownerId, 'model', companionId, key, now, tx);
  }

  /** 当前是否属于默认不主动联系的当地静默时间。 */
  quiet(now: Date): boolean {
    const { quietStartHour, quietEndHour, timeZone } = this.limits;
    if (quietStartHour === quietEndHour) return false;
    const hour = localTime(now, timeZone).hour;
    return quietStartHour < quietEndHour
      ? hour >= quietStartHour && hour < quietEndHour
      : hour >= quietStartHour || hour < quietEndHour;
  }

  /** 求下一当地日到达的绝对时间，跨夏令时也按当地日恢复。 */
  nextDay(now: Date): Date {
    const zone = this.limits.timeZone;
    const today = localTime(now, zone).day;
    let left = now.getTime();
    let right = left + 27 * 3600000;
    while (right - left > 1000) {
      const midpoint = Math.floor((left + right) / 2);
      if (localTime(new Date(midpoint), zone).day === today) left = midpoint;
      else right = midpoint;
    }
    return new Date(right + 1000);
  }
}

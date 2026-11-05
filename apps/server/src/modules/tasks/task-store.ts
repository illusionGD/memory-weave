import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service';
import { DatabaseService } from '../../database/database.service';
import { taskSchedulerHeads } from '../../database/schema';

/** 只负责短调度事务；不同服务进程共享同一部署互斥，不持有外部调用。 */
@Injectable()
export class TaskStore {
  /** 初始化任务事务与调度锁服务。 */
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * 在调度锁内执行任务操作。
   *
   * 配置、领取和提交共用锁顺序；数据库时间避免不同 worker 的本地时钟差异。
   */
  locked<T>(
    operation: (ownerId: string, tx: DatabaseTransaction, now: Date) => Promise<T>,
  ): Promise<T> {
    return this.database.withOwner((ownerId, db) =>
      db.transaction(
        async (tx) => {
          return operation(ownerId, tx, await lockTaskScheduler(ownerId, tx));
        },
        { isolationLevel: 'read committed' },
      ),
    );
  }
}

/**
 * 锁定当前部署的任务调度记录。
 *
 * 与模型派发事务共用调度锁；模型锁先于调度锁，禁止反向调用模型事务。
 */
export async function lockTaskScheduler(ownerId: string, tx: DatabaseTransaction): Promise<Date> {
  await tx.sql
    .insert(taskSchedulerHeads)
    .values({ ownerId })
    .onDuplicateKeyUpdate({ set: { ownerId } });
  await tx.sql
    .select()
    .from(taskSchedulerHeads)
    .where(eq(taskSchedulerHeads.ownerId, ownerId))
    .for('update');
  return taskDatabaseTime(ownerId, tx);
}

/**
 * 查询数据库当前时间。
 *
 * 每次语句重新读取数据库当前时间，不能以事务起始时间批准迟到提交。
 */
export async function taskDatabaseTime(ownerId: string, tx: DatabaseTransaction): Promise<Date> {
  const clock = await tx.taskSchedulerHeads.findOne({
    fields: { milliseconds: sql<string>`UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000` },
  });
  return new Date(Number(clock!.milliseconds));
}

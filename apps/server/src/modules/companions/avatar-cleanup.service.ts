import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { companions } from '../../database/schema';
import { AvatarFiles } from './avatar-files';

/** 有界巡检替换/恢复默认及崩溃遗留的未引用文件，进程重启后自然重新扫描。 */
@Injectable()
export class AvatarCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private afterId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AvatarFiles) private readonly files: AvatarFiles,
  ) {}
  /** 等数据库服务完成启动后异步巡检，每轮最多 20 个实例、每实例 32 个文件。 */
  onApplicationBootstrap(): void {
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pending = this.sweep()
        .catch(() => {
          console.error(JSON.stringify({ event: 'avatars.cleanup.failed' }));
        })
        .finally(() => this.schedule());
    }, 5000);
    this.timer.unref();
  }
  private async sweep(): Promise<void> {
    await this.database.withOwner(async (ownerId, db) => {
      const rows = await db
        .select({ id: companions.id })
        .from(companions)
        .where(
          and(
            eq(companions.ownerId, ownerId),
            this.afterId ? gt(companions.id, this.afterId) : undefined,
          ),
        )
        .orderBy(asc(companions.id))
        .limit(20);
      for (const row of rows) {
        if (this.stopped) return;
        await db.transaction(
          async (tx) => {
            const [current] = await tx
              .select()
              .from(companions)
              .where(and(eq(companions.ownerId, ownerId), eq(companions.id, row.id)))
              .for('update');
            // 正在删除的目录交给持久清理阶段，重置则保留头像。
            if (current && !current.deletedAt)
              await this.files.prune(ownerId, row.id, current.avatar);
          },
          { isolationLevel: 'read committed' },
        );
        this.afterId = row.id;
      }
      if (rows.length < 20) this.afterId = null;
    });
  }
  /** 停止计时器并等待当前有界文件操作退出。 */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { asc, gt } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { companions } from '../../database/schema';
import { AvatarFiles } from './avatar-files';
import { DeploymentIdentity } from '../auth/deployment-identity';

/** 有界巡检替换/恢复默认及崩溃遗留的未引用文件，进程重启后自然重新扫描。 */
@Injectable()
export class AvatarCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private afterId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  /** 初始化头像文件巡检服务。 */
  constructor(
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Inject(DeploymentIdentity) private readonly deployment: DeploymentIdentity,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AvatarFiles) private readonly files: AvatarFiles,
  ) {}
  /**
   * 启动头像文件的定期清理任务。
   *
   * 等数据库服务完成启动后异步巡检，每轮最多 20 个实例、每实例 32 个文件。
   */
  onApplicationBootstrap(): void {
    this.schedule();
  }
  /** 安排下一轮头像文件巡检。 */
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pending = this.deployment
        .ownerId()
        .then((ownerId) => this.sweep(ownerId))
        .catch((err) => {
          this.logger.error({ event: 'avatars.cleanup.failed', err }, '头像文件巡检失败。');
        })
        .finally(() => this.schedule());
    }, 5000);
    this.timer.unref();
  }
  /** 清理当前批次中未被引用的头像文件。 */
  private async sweep(ownerId: string): Promise<void> {
    const rows = await this.database.companions.findMany(ownerId, {
      where: this.afterId ? gt(companions.id, this.afterId) : undefined,
      fields: { id: companions.id },
      orderBy: [asc(companions.id)],
      limit: 20,
    });
    for (const row of rows) {
      if (this.stopped) return;
      await this.database.transaction(
        async (tx) => {
          const current = await this.database.companions.findOne(
            ownerId,
            { where: { id: row.id }, lock: 'update' },
            tx,
          );
          // 正在删除的目录交给持久清理阶段，重置则保留头像。
          if (current && !current.deletedAt)
            await this.files.prune(ownerId, row.id, current.avatar);
        },
        { isolationLevel: 'read committed' },
      );
      this.afterId = row.id;
    }
    if (rows.length < 20) this.afterId = null;
  }
  /**
   * 停止头像巡检并等待当前清理完成。
   *
   * 停止计时器并等待当前有界文件操作退出。
   */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}

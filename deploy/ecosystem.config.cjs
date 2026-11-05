const path = require('node:path');
const root = path.resolve(__dirname, '..');

// 先构建并完成数据库迁移；模型 JSON 修改后重启此单实例。
module.exports = {
  apps: [
    {
      name: 'memory-weave',
      cwd: root,
      script: path.join(root, 'apps/server/dist/main.js'),
      exec_mode: 'fork',
      instances: 1,
      // Pino 自带时间和级别；PM2 保留每行原始 JSON，文件轮转由 pm2-logrotate 负责。
      time: false,
      merge_logs: true,
      node_args: [
        '--enable-source-maps',
        `--env-file=${path.join(root, '.env')}`,
        `--env-file-if-exists=${path.join(root, '.env.models')}`,
      ],
      env: {
        NODE_ENV: 'production',
        LOG_FORMAT: 'json',
        MODEL_CONFIG_FILE: path.join(root, 'config/models.production.json'),
        WEB_DIST_DIR: path.join(root, 'apps/web/dist'),
        ADMIN_DIST_DIR: path.join(root, 'apps/admin/dist'),
      },
    },
  ],
};

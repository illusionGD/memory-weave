const path = require('node:path');

/** 让 Nest CLI 监听后端和共享契约源码，开发产物保持 ESM。 */
module.exports = (options) => ({
  ...options,
  devtool: 'source-map',
  experiments: { outputModule: true },
  output: {
    ...options.output,
    path: path.resolve(__dirname, '.cache/nest'),
    module: true,
    library: { type: 'module' },
  },
  resolve: {
    ...options.resolve,
    alias: {
      '@memory-weave/contracts': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
    },
  },
  module: {
    ...options.module,
    // 文件目录按源码位置解析，不把迁移目录和模型配置当成打包资源。
    parser: { javascript: { url: false } },
  },
  externals: [
    /** 只打包本仓库源码；第三方包由 Node 原生加载。 */
    ({ request }, callback) => {
      if (
        !request ||
        request.startsWith('.') ||
        path.isAbsolute(request) ||
        request === '@memory-weave/contracts'
      ) {
        callback();
        return;
      }
      callback(null, `node-commonjs ${request}`);
    },
  ],
});

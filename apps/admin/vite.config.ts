import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
  const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
  const environment = loadEnv(mode, workspaceRoot, '');

  return {
    plugins: [vue()],
    base: '/admin/',
    envDir: workspaceRoot,
    // 仅显式公开的变量可以进入浏览器构建产物。
    envPrefix: 'PUBLIC_',
    define: {
      'import.meta.env.PUBLIC_CHAT_URL': JSON.stringify(
        environment.PUBLIC_CHAT_URL ||
          (command === 'serve' ? environment.APP_ORIGIN || 'http://localhost:5173' : '/'),
      ),
    },
    resolve: {
      // 开发时直读 workspace 源码，生产构建仍使用各包的 dist 入口。
      conditions:
        command === 'serve'
          ? ['memory-weave-source', ...defaultClientConditions]
          : [...defaultClientConditions],
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': {
          target: environment.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
          changeOrigin: false,
        },
      },
    },
    preview: {
      host: '127.0.0.1',
      port: 4175,
      strictPort: true,
    },
  };
});

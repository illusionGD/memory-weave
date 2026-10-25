import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
  const environment = loadEnv(mode, workspaceRoot, '');

  return {
    plugins: [vue()],
    // Only explicitly public variables may enter browser bundles.
    envPrefix: 'PUBLIC_',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
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
      port: 4173,
      strictPort: true,
    },
  };
});

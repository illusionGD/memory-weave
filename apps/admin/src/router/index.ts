import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import LoginView from '@/views/login/LoginView.vue';

/** 管理路由仅存在于管理构建，路径基于独立部署前缀。 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'status',
      /** 按需加载运行状态页面。 */
      component: () => import('@/views/system/SystemView.vue'),
      meta: { requiresAuth: true, title: '运行概览' },
    },
    {
      path: '/companions',
      name: 'companions',
      /** 按需加载伴侣列表页面。 */
      component: () => import('@/views/companions/CompanionsView.vue'),
      meta: { requiresAuth: true, title: '伴侣管理' },
    },
    {
      path: '/companions/new',
      name: 'companion-create',
      /** 按需加载伴侣创建页面。 */
      component: () => import('@/views/companions/CompanionCreateView.vue'),
      meta: { requiresAuth: true, title: '创建伴侣' },
    },
    {
      path: '/companions/:id',
      name: 'companion-detail',
      /** 按需加载伴侣详情页面。 */
      component: () => import('@/views/companions/CompanionDetailView.vue'),
      meta: { requiresAuth: true, title: '伴侣详情' },
    },
    {
      path: '/persona-templates',
      name: 'persona-templates',
      /** 按需加载人设模板页面。 */
      component: () => import('@/views/companions/PersonaTemplatesView.vue'),
      meta: { requiresAuth: true, title: '人设模板' },
    },
    {
      path: '/memories',
      name: 'memory-index',
      /** 按需加载记忆入口页面。 */
      component: () => import('@/views/memories/MemoryIndexView.vue'),
      meta: { requiresAuth: true, title: '记忆记录' },
    },
    {
      path: '/companions/:id/memories',
      name: 'memory-explorer',
      /** 按需加载记忆浏览页面。 */
      component: () => import('@/views/memories/MemoryExplorerView.vue'),
      meta: { requiresAuth: true, title: '记忆浏览' },
    },
    {
      path: '/companions/:id/memories/:conversationId',
      name: 'memories',
      /** 按需加载会话记忆页面。 */
      component: () => import('@/views/memories/MemoriesView.vue'),
      meta: { requiresAuth: true, title: '记忆详情' },
    },
    {
      path: '/lifecycle/:id?',
      name: 'lifecycle',
      /** 按需加载生命周期清理页面。 */
      component: () => import('@/views/lifecycle/LifecycleView.vue'),
      meta: { requiresAuth: true, title: '清理记录' },
    },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  // 检查失败后的登录入口展示重试，避免重定向立即重复发送同一次故障请求。
  if (to.name === 'login' && auth.sessionUnavailable) return true;
  const authenticated = await auth.restoreSession();
  if (to.meta.requiresAuth && !authenticated) return { name: 'login' };
  if (to.name === 'login' && authenticated) return { name: 'status' };
  return true;
});

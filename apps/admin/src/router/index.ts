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
      component: () => import('@/views/system/SystemView.vue'),
      meta: { requiresAuth: true, title: '运行概览' },
    },
    {
      path: '/companions',
      name: 'companions',
      component: () => import('@/views/companions/CompanionsView.vue'),
      meta: { requiresAuth: true, title: '伴侣管理' },
    },
    {
      path: '/companions/new',
      name: 'companion-create',
      component: () => import('@/views/companions/CompanionCreateView.vue'),
      meta: { requiresAuth: true, title: '创建伴侣' },
    },
    {
      path: '/companions/:id',
      name: 'companion-detail',
      component: () => import('@/views/companions/CompanionDetailView.vue'),
      meta: { requiresAuth: true, title: '伴侣详情' },
    },
    {
      path: '/persona-templates',
      name: 'persona-templates',
      component: () => import('@/views/companions/PersonaTemplatesView.vue'),
      meta: { requiresAuth: true, title: '人设模板' },
    },
    {
      path: '/memories',
      name: 'memory-index',
      component: () => import('@/views/memories/MemoryIndexView.vue'),
      meta: { requiresAuth: true, title: '记忆记录' },
    },
    {
      path: '/companions/:id/memories/:conversationId',
      name: 'memories',
      component: () => import('@/views/memories/MemoriesView.vue'),
      meta: { requiresAuth: true, title: '记忆详情' },
    },
    {
      path: '/lifecycle/:id?',
      name: 'lifecycle',
      component: () => import('@/views/lifecycle/LifecycleView.vue'),
      meta: { requiresAuth: true, title: '清理记录' },
    },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
router.beforeEach(async (to) => {
  const authenticated = await useAuthStore().restoreSession();
  if (to.meta.requiresAuth && !authenticated) return { name: 'login' };
  if (to.name === 'login' && authenticated) return { name: 'status' };
  return true;
});

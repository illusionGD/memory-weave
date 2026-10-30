import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import LoginView from '@/views/login/LoginView.vue';

/** 聊天构建只包含日常相处与个人资料，管理路由位于独立项目。 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/chats' },
    {
      path: '/chats',
      name: 'chats',
      component: () => import('@/views/chats/ChatsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/chats/:id',
      name: 'chat',
      component: () => import('@/views/chats/ChatView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions',
      name: 'companions',
      component: () => import('@/views/companions/CompanionsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions/new',
      name: 'companion-create',
      component: () => import('@/views/companions/CompanionCreateView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions/:id',
      name: 'companion-detail',
      component: () => import('@/views/companions/CompanionDetailView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions/:id/memories/:conversationId',
      name: 'memories',
      component: () => import('@/views/memories/MemoriesView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/settings/SettingsView.vue'),
      meta: { requiresAuth: true },
    },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/:pathMatch(.*)*', redirect: '/chats' },
  ],
});
router.beforeEach(async (to) => {
  const authenticated = await useAuthStore().restoreSession();
  if (to.meta.requiresAuth && !authenticated) return { name: 'login' };
  if (to.name === 'login' && authenticated) return { name: 'chats' };
  return true;
});

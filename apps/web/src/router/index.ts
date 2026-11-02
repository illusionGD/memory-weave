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
      /** 按需加载私聊列表页面。 */
      component: () => import('@/views/chats/ChatsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/chats/:id',
      name: 'chat',
      /** 按需加载私聊页面。 */
      component: () => import('@/views/chats/ChatView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions',
      name: 'companions',
      /** 按需加载伴侣列表页面。 */
      component: () => import('@/views/companions/CompanionsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions/new',
      name: 'companion-create',
      /** 按需加载伴侣创建页面。 */
      component: () => import('@/views/companions/CompanionCreateView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions/:id',
      name: 'companion-detail',
      /** 按需加载伴侣详情页面。 */
      component: () => import('@/views/companions/CompanionDetailView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/companions/:id/memories/:conversationId',
      name: 'memories',
      /** 按需加载会话记忆页面。 */
      component: () => import('@/views/memories/MemoriesView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/settings',
      name: 'settings',
      /** 按需加载用户设置页面。 */
      component: () => import('@/views/settings/SettingsView.vue'),
      meta: { requiresAuth: true },
    },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/:pathMatch(.*)*', redirect: '/chats' },
  ],
});
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  // 检查失败后的登录入口展示重试，避免重定向立即重复发送同一次故障请求。
  if (to.name === 'login' && auth.sessionUnavailable) return true;
  const authenticated = await auth.restoreSession();
  if (to.meta.requiresAuth && !authenticated) return { name: 'login' };
  if (to.name === 'login' && authenticated) return { name: 'chats' };
  return true;
});

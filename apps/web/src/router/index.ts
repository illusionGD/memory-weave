import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import LoginView from '@/views/login/LoginView.vue';

/** 页面只使用服务端确认的会话状态，路由守卫不代替后端认证。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'status',
      component: () => import('@/views/system/SystemView.vue'),
      meta: { requiresAuth: true },
    },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const authenticated = await auth.restoreSession();

  if (to.meta.requiresAuth && !authenticated) {
    return { name: 'login' };
  }

  if (to.name === 'login' && authenticated) {
    return { name: 'status' };
  }

  return true;
});

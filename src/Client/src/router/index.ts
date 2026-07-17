import { createRouter, createWebHistory } from 'vue-router'

import HealthView from '../views/HealthView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'health',
      component: HealthView,
    },
  ],
})

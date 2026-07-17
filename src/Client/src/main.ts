import { createApp } from 'vue'
import { createPinia } from 'pinia'

import './style.css'
import App from './App.vue'
import { router } from './router'
import { captureDashboardToken } from './services/auth'

// Must run before anything renders: a ?token= in the URL has to be persisted
// and stripped from the address bar before the first paint, so it never
// lingers in browser history or a screenshot of the dashboard.
captureDashboardToken()

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')

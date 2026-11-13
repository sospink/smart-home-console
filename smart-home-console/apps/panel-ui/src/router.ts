import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { rememberNativeSurface, type PanelSurface } from "./lib/terminal-runtime";

export const router = createRouter({
  history:
    window.location.hostname === "appassets.androidplatform.net" || window.location.protocol === "file:"
      ? createWebHashHistory()
      : createWebHistory(),
  routes: [
    { path: "/", redirect: "/primary" },
    { path: "/primary", component: () => import("./views/PrimaryView.vue"), meta: { role: "primary" } },
    { path: "/secondary", component: () => import("./views/SecondaryView.vue"), meta: { role: "secondary" } },
    { path: "/admin", component: () => import("./views/AdminView.vue"), meta: { role: "admin" } }
  ]
});

router.afterEach((to) => {
  if (to.meta.role === "primary" || to.meta.role === "secondary" || to.meta.role === "admin") {
    rememberNativeSurface(to.meta.role as PanelSurface);
  }
});

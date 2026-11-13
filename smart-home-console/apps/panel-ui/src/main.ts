import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import "./styles/tokens.css";
import "./styles/global.css";
import { ripple } from "./directives/ripple";
import { initializeTheme } from "./composables/theme";
import { initializeMotionPreference } from "./composables/motion";

initializeTheme();
initializeMotionPreference();
const app = createApp(App);
app.directive("ripple", ripple);
app.use(createPinia()).use(router).mount("#app");

const syncVisibility = () => document.documentElement.classList.toggle("motion-paused", document.hidden);
document.addEventListener("visibilitychange", syncVisibility);
syncVisibility();

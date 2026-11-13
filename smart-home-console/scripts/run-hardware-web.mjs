import { execFileSync, spawn } from "node:child_process";
import { edgeTarget, hardwareIdentity, keychainService } from "./hardware-web-runtime.mjs";

const target = edgeTarget();
const identity = await hardwareIdentity(target);
let token = "";
try {
  token = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-a", identity.controlDomainId, "-s", keychainService(target)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  ).trim();
} catch {
  // 首次 Web 真机调试允许无令牌启动；随后由仅监听回环地址的认证入口完成授权。
}

const child = spawn("pnpm", ["--filter", "@smart-lab/panel-ui", "exec", "vite", "--host", "127.0.0.1"], {
  stdio: "inherit",
  env: {
    ...process.env,
    EDGE_TARGET: target,
    EDGE_PROXY_TOKEN: token,
    HARDWARE_WEB_AUTH: "1",
    VITE_HARDWARE_WEB_AUTH: "1",
    VITE_TERMINAL_ROLE: "secondary",
    VITE_EDGE_CACHE_SCOPE: `hardware:${identity.controlDomainId}`
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

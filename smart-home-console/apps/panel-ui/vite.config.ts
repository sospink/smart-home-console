import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

type JsonObject = Record<string, unknown>;

function localHardwareAuthorization(edgeTarget: string, setToken: (token: string) => void) {
  const enabled = process.env.HARDWARE_WEB_AUTH === "1";
  const service = `cn.zhijing.smartlab.hardware-web.${createHash("sha256").update(edgeTarget).digest("hex").slice(0, 20)}`;
  const requestJson = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${edgeTarget}${path}`, { ...init, signal: AbortSignal.timeout(8_000) });
    const body = (await response.json().catch(() => ({}))) as JsonObject;
    return { response, body };
  };

  return {
    name: "smart-lab-hardware-web-auth",
    configureServer(server: { middlewares: { use(handler: (request: any, response: any, next: () => void) => void): void } }) {
      if (!enabled) return;
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/__smart_lab/hardware-auth" || request.method !== "POST") return next();
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          raw += chunk;
          if (raw.length > 1024) request.destroy();
        });
        request.on("end", async () => {
          response.setHeader("content-type", "application/json; charset=utf-8");
          let adminToken = "";
          try {
            const pin = String((JSON.parse(raw || "{}") as { pin?: unknown }).pin ?? "");
            if (!/^\d{6,12}$/.test(pin)) throw new Error("INVALID_PIN_FORMAT");
            const login = await requestJson("/api/v1/admin/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ pin })
            });
            if (!login.response.ok) throw new Error(String(login.body.error ?? `HTTP_${login.response.status}`));
            adminToken = String((login.body.data as JsonObject | undefined)?.token ?? "");
            if (!adminToken) throw new Error("ADMIN_SESSION_MISSING");
            const headers = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
            const pairingCode = await requestJson("/api/v1/admin/terminals/pairing-code", { headers });
            if (!pairingCode.response.ok) throw new Error(String(pairingCode.body.error ?? `HTTP_${pairingCode.response.status}`));
            const code = String((pairingCode.body.data as JsonObject | undefined)?.code ?? "");
            const deviceId = `browser-dev-${createHash("sha256").update(hostname()).digest("hex").slice(0, 16)}`;
            const paired = await requestJson("/api/v1/terminals/pair", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ pairingCode: code, deviceId, name: "本地 Web 真机调试", role: "secondary", version: "web-dev" })
            });
            if (!paired.response.ok) throw new Error(String(paired.body.error ?? `HTTP_${paired.response.status}`));
            const data = paired.body.data as JsonObject | undefined;
            const token = String(data?.token ?? "");
            const controlDomainId = String(data?.controlDomainId ?? "");
            if (!token || !controlDomainId) throw new Error("PAIRING_RESPONSE_INVALID");
            setToken(token);
            execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-a", controlDomainId, "-s", service, "-w", token], {
              stdio: "ignore"
            });
            response.statusCode = 200;
            response.end(JSON.stringify({ ok: true }));
          } catch (error) {
            const code = error instanceof Error ? error.message : "HARDWARE_AUTH_FAILED";
            response.statusCode = code === "INVALID_ADMIN_PIN" ? 401 : code === "TOO_MANY_AUTH_ATTEMPTS" ? 429 : 400;
            response.end(JSON.stringify({ error: code }));
          } finally {
            if (adminToken) {
              void requestJson("/api/v1/admin/logout", {
                method: "POST",
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
                body: "{}"
              }).catch(() => undefined);
            }
          }
        });
      });
    }
  };
}

export default defineConfig(() => {
  const uiPort = Number(process.env.UI_PORT ?? 8083);
  const edgePort = Number(process.env.EDGE_PORT ?? 18787);
  const edgeTarget = process.env.EDGE_TARGET?.trim().replace(/\/+$/, "") || `http://localhost:${edgePort}`;
  let edgeProxyToken = process.env.EDGE_PROXY_TOKEN?.trim() ?? "";

  const authorizeHardwareProxy = (proxyRequest: {
    getHeader?(name: string): string | number | string[] | undefined;
    setHeader(name: string, value: string): void;
  }) => {
    if (!edgeProxyToken) return;
    // 登录后浏览器会发送真实管理员 Bearer，必须原样透传。
    // 只有前端开发态的固定 Mock 令牌（或空头）才由代理替换为钥匙串中的正式副屏令牌。
    const current = String(proxyRequest.getHeader?.("authorization") ?? "");
    if (!current || current === "Bearer mock-primary-terminal-token" || current === "Bearer mock-secondary-terminal-token") {
      proxyRequest.setHeader("authorization", `Bearer ${edgeProxyToken}`);
    }
  };

  return {
    // APK 通过 WebViewAssetLoader 从 /assets/panel-ui/index.html 提供页面。
    // 使用相对基址，确保构建后的 JS/CSS 继续落在 panel-ui/assets 下，而不是误取 assets 根目录。
    base: "./",
    plugins: [vue(), localHardwareAuthorization(edgeTarget, (token) => (edgeProxyToken = token))],
    server: {
      port: uiPort,
      strictPort: true,
      proxy: {
        "/api": {
          target: edgeTarget,
          ws: true,
          configure(proxy) {
            // 真机浏览器调试时，正式副屏令牌只保留在 Vite 代理进程内；
            // 页面仍使用同源 /api，令牌不会进入 bundle、URL、localStorage 或 DevTools 请求代码。
            proxy.on("proxyReq", authorizeHardwareProxy);
            proxy.on("proxyReqWs", authorizeHardwareProxy);
          }
        }
      }
    },
    build: {
      target: "es2020",
      manifest: true
    }
  };
});

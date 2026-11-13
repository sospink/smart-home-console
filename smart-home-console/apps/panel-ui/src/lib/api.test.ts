import assert from "node:assert/strict";
import test from "node:test";
import {
  edgeApi,
  fetchWithTimeout,
  notifyNativeTerminalAuthenticationInvalid,
  requestNativeDatabaseBackupDownload,
  requestDeadlines,
  resolveEdgeBase,
  responseExpiresCurrentAdminSession,
  runWithTimeout,
  setAdminToken,
  terminalToken
} from "./api";

test("browser mode keeps same-origin API when no runtime edge is configured", () => {
  assert.equal(resolveEdgeBase({ hostname: "localhost", search: "" } as Location), "");
});

test("不同操作使用覆盖真实服务时延的分级截止时间", () => {
  assert.ok(requestDeadlines.connect < requestDeadlines.command);
  assert.ok(requestDeadlines.command < requestDeadlines.scene);
  assert.ok(requestDeadlines.scene < requestDeadlines.artifact);
});

test("网络黑洞会被主动中止并归一为可识别的请求超时", async () => {
  let aborted = false;
  const neverResponds = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;
  await assert.rejects(fetchWithTimeout("http://edge.invalid", {}, 10, neverResponds), /API_REQUEST_TIMEOUT/);
  assert.equal(aborted, true);
});

test("调用方主动取消不会被误报为截止时间超时", async () => {
  const caller = new AbortController();
  const neverResponds = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
  const pending = fetchWithTimeout("http://edge.invalid", { signal: caller.signal }, 1000, neverResponds);
  caller.abort("leave-page");
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

test("收到响应头但正文不结束时仍受完整请求截止时间保护", async () => {
  let bodyAborted = false;
  await assert.rejects(
    runWithTimeout(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            bodyAborted = true;
            reject(new DOMException("body stalled", "AbortError"));
          });
        }),
      10
    ),
    /API_REQUEST_TIMEOUT/
  );
  assert.equal(bodyAborted, true);
});

test("纯浏览器模式接受并规范化显式 EdgeCore 调试地址", () => {
  assert.equal(
    resolveEdgeBase({ hostname: "appassets.androidplatform.net", search: "?edge=http%3A%2F%2F192.168.10.8%3A8787%2F" } as Location),
    "http://192.168.10.8:8787"
  );
});

test("原生容器忽略页面 edge 参数并只信任桥接地址", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { pathname: "/secondary", hostname: "appassets.androidplatform.net", search: "?edge=http://attacker.invalid:8787" },
      SmartLabNative: {
        getRole: () => "secondary",
        getEdgeBaseUrl: () => "http://192.168.10.8:8787/",
        getTerminalToken: () => "paired-token",
        getAppVersion: () => "0.1.0"
      }
    }
  });
  try {
    assert.equal(resolveEdgeBase(), "http://192.168.10.8:8787");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("副屏令牌被撤销时只通知原生层处理终端认证失效", () => {
  let notifications = 0;
  const bridge = {
    getRole: () => "secondary",
    getEdgeBaseUrl: () => "http://192.168.10.8:8787",
    getTerminalToken: () => "revoked-token",
    getAppVersion: () => "0.1.0",
    onTerminalAuthenticationInvalid: () => {
      notifications += 1;
    }
  };
  assert.equal(notifyNativeTerminalAuthenticationInvalid(401, "TERMINAL_AUTH_REQUIRED", bridge), true);
  assert.equal(notifyNativeTerminalAuthenticationInvalid(401, "ADMIN_AUTH_REQUIRED", bridge), false);
  assert.equal(notifyNativeTerminalAuthenticationInvalid(500, "TERMINAL_AUTH_REQUIRED", bridge), false);
  assert.equal(notifications, 1);
});

test("原生运行时单项异常被隔离且调试包不会降级使用 Mock 令牌", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = {
    getRole: () => {
      throw new Error("role unavailable");
    },
    getEdgeBaseUrl: () => "http://192.168.10.8:8787/",
    getTerminalToken: () => {
      throw new Error("keystore unavailable");
    },
    getAppVersion: () => "0.1.0",
    downloadDatabaseBackup: () => {
      throw new Error("media store unavailable");
    },
    onTerminalAuthenticationInvalid: () => {
      throw new Error("activity unavailable");
    }
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/secondary", hostname: "appassets.androidplatform.net", search: "" }, SmartLabNative: bridge }
  });
  try {
    assert.equal(resolveEdgeBase(), "http://192.168.10.8:8787");
    assert.equal(terminalToken(), "");
    assert.equal(requestNativeDatabaseBackupDownload("smart-lab.db"), false);
    assert.equal(notifyNativeTerminalAuthenticationInvalid(401, "TERMINAL_AUTH_REQUIRED", bridge), false);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("登录前旧请求的迟到 401 不得吊销刚创建的管理会话", () => {
  assert.equal(responseExpiresCurrentAdminSession(401, "ADMIN_AUTH_REQUIRED", "terminal-token", "new-admin-token"), false);
  assert.equal(responseExpiresCurrentAdminSession(401, "ADMIN_AUTH_REQUIRED", "old-admin-token", "new-admin-token"), false);
  assert.equal(responseExpiresCurrentAdminSession(401, "ADMIN_AUTH_REQUIRED", "new-admin-token", "new-admin-token"), true);
  assert.equal(responseExpiresCurrentAdminSession(401, "TERMINAL_AUTH_REQUIRED", "new-admin-token", "new-admin-token"), false);
});

test("主副屏控制固定使用终端令牌，不会被残留管理会话劫持", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const authorizations: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { pathname: "/primary", hostname: "appassets.androidplatform.net", search: "" },
      SmartLabNative: {
        getRole: () => "primary",
        getEdgeBaseUrl: () => "http://127.0.0.1:8787",
        getTerminalToken: () => "primary-terminal-token",
        getAppVersion: () => "0.1.2"
      }
    }
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ data: { status: "confirmed" }, sequence: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  setAdminToken("stale-admin-token");
  try {
    await edgeApi.command("living-main-light", {
      requestId: "terminal-auth-regression",
      property: "power",
      value: false,
      source: "primary"
    });
    assert.deepEqual(authorizations, ["Bearer primary-terminal-token"]);
  } finally {
    setAdminToken("");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
    else Reflect.deleteProperty(globalThis, "fetch");
  }
});

test("管理台设备控制仍固定使用本次管理员会话", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  let authorization = "";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { pathname: "/admin", hostname: "appassets.androidplatform.net", search: "" },
      SmartLabNative: {
        getRole: () => "primary",
        getEdgeBaseUrl: () => "http://127.0.0.1:8787",
        getTerminalToken: () => "primary-terminal-token",
        getAppVersion: () => "0.1.2"
      }
    }
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ data: { status: "confirmed" }, sequence: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  setAdminToken("current-admin-token");
  try {
    await edgeApi.command("living-main-light", {
      requestId: "admin-auth-regression",
      property: "power",
      value: false,
      source: "admin"
    });
    assert.equal(authorization, "Bearer current-admin-token");
  } finally {
    setAdminToken("");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
    else Reflect.deleteProperty(globalThis, "fetch");
  }
});

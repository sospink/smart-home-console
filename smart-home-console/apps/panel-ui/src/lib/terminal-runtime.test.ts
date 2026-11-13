import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeTerminalRole,
  panelSurface,
  rememberNativeSurface,
  runtimeCommandSource,
  runtimeTerminalRole,
  type SmartLabNativeBridge
} from "./terminal-runtime";

function withWindow<T>(value: unknown, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("原生副屏查看主屏界面时仍保持副屏身份和命令来源", () => {
  withWindow(
    {
      location: { pathname: "/primary", hash: "#/primary" },
      SmartLabNative: { getRole: () => "secondary" }
    },
    () => {
      assert.equal(panelSurface(), "primary");
      assert.equal(runtimeTerminalRole(), "secondary");
      assert.equal(runtimeCommandSource("primary"), "secondary");
    }
  );
});

test("管理界面操作来源保持 admin，离开后恢复物理副屏来源", () => {
  const location = { pathname: "/admin", hash: "#/admin" };
  withWindow({ location, SmartLabNative: { getRole: () => "secondary" } }, () => {
    assert.equal(runtimeTerminalRole(), "secondary");
    assert.equal(runtimeCommandSource("secondary"), "admin");
    location.pathname = "/primary";
    location.hash = "#/primary";
    assert.equal(runtimeCommandSource("primary"), "secondary");
  });
});

test("非法或异常原生角色安全回退到当前工作界面", () => {
  const invalidBridge: SmartLabNativeBridge = { getRole: () => "administrator" };
  const throwingBridge: SmartLabNativeBridge = {
    getRole: () => {
      throw new Error("bridge unavailable");
    }
  };
  assert.equal(nativeTerminalRole(invalidBridge), undefined);
  assert.equal(nativeTerminalRole(throwingBridge), undefined);
  withWindow({ location: { pathname: "/secondary", hash: "#/secondary" }, SmartLabNative: invalidBridge }, () => {
    assert.equal(runtimeTerminalRole(), "secondary");
    assert.equal(runtimeCommandSource(), "secondary");
  });
});

test("原生界面记忆只接受三种白名单 surface", () => {
  const remembered: string[] = [];
  withWindow(
    {
      location: { pathname: "/primary", hash: "#/primary" },
      SmartLabNative: {
        rememberSurface: (surface: string) => {
          remembered.push(surface);
          return true;
        }
      }
    },
    () => {
      assert.equal(rememberNativeSurface("primary"), true);
      assert.equal(rememberNativeSurface("secondary"), true);
      assert.equal(rememberNativeSurface("admin"), true);
      assert.equal(rememberNativeSurface("engineering" as never), false);
    }
  );
  assert.deepEqual(remembered, ["primary", "secondary", "admin"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionIntent, connectionIssue, EventLiveness, eventStreamIsStale, preferConnectionIssue, reconnectDelay } from "./connection";

test("主动停止后旧连接关闭不得触发重连", () => {
  const intent = new ConnectionIntent();
  const first = intent.start();
  assert.equal(intent.shouldReconnect(first), true);

  intent.stop();
  assert.equal(intent.shouldReconnect(first), false);
  assert.equal(intent.nextAttempt(), undefined);
});

test("新连接代次会拒绝旧 socket 晚到的回调", () => {
  const intent = new ConnectionIntent();
  const first = intent.start();
  const second = intent.nextAttempt();

  assert.ok(second);
  assert.equal(intent.accepts(first), false);
  assert.equal(intent.accepts(second!), true);
});

test("重复 start 不会平白创建新的连接代次", () => {
  const intent = new ConnectionIntent();
  const first = intent.start();
  assert.equal(intent.start(), first);
});

test("停止后可立即建立新代次且旧异步结果持续无效", () => {
  const intent = new ConnectionIntent();
  const old = intent.start();
  intent.stop();
  const current = intent.start();

  assert.notEqual(current, old);
  assert.equal(intent.accepts(old), false);
  assert.equal(intent.accepts(current), true);
});

test("持续断线按指数退避并限制最长等待", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((attempt) => reconnectDelay(attempt, 1600, 30_000, () => 0.5)),
    [1600, 3200, 6400, 12800, 25600, 30000, 30000]
  );
});

test("重连延迟加入有限抖动避免多屏同步请求", () => {
  assert.equal(
    reconnectDelay(3, 1600, 30_000, () => 0),
    5120
  );
  assert.equal(
    reconnectDelay(3, 1600, 30_000, () => 1),
    7680
  );
  assert.equal(
    reconnectDelay(8, 1600, 30_000, () => 1),
    30000
  );
});

test("连接错误转换为可操作说明而不是暴露底层异常", () => {
  assert.equal(connectionIssue(new TypeError("Failed to fetch"), "snapshot").title, "本地控制服务不可达");
  assert.equal(connectionIssue(new Error("HTTP_401"), "snapshot").title, "终端认证失效");
  assert.equal(connectionIssue(new Error("TERMINAL_TOKEN_INVALID"), "snapshot").title, "终端认证失效");
  assert.equal(connectionIssue(new Error("TICKET_FAILED"), "ticket").title, "安全连接建立失败");
  assert.equal(connectionIssue("offline", "network").title, "当前网络不可用");
  assert.equal(connectionIssue("AUTHORITATIVE_SNAPSHOT_TIMEOUT", "events").title, "权威状态获取超时");
  assert.equal(connectionIssue("EVENT_STREAM_STALE", "events").title, "实时状态已停止更新");
});

test("同一不可达根因不会被下游票据失败覆盖", () => {
  const unreachable = connectionIssue(new TypeError("Failed to fetch"), "snapshot");
  const ticket = connectionIssue(new TypeError("Failed to fetch"), "ticket");
  assert.equal(preferConnectionIssue(unreachable, ticket), unreachable);
  const authentication = connectionIssue(new Error("TERMINAL_AUTH_REQUIRED"), "ticket");
  assert.equal(preferConnectionIssue(unreachable, authentication), authentication);
});

test("事件活性看门狗在持续收包时续期且静默超时只触发一次", () => {
  let callback: (() => void) | undefined;
  let cleared = 0;
  let timeouts = 0;
  const clock = {
    setTimeout(next: () => void) {
      callback = next;
      return 1;
    },
    clearTimeout() {
      cleared += 1;
      callback = undefined;
    }
  } as unknown as Pick<typeof window, "setTimeout" | "clearTimeout">;
  const liveness = new EventLiveness(16_000, () => (timeouts += 1), clock);
  liveness.received();
  liveness.received();
  assert.equal(cleared, 1);
  callback?.();
  assert.equal(timeouts, 1);
  liveness.stop();
  assert.equal(timeouts, 1);
});

test("WebView 恢复前台时可同步判断后台期间事件流是否过期", () => {
  assert.equal(eventStreamIsStale(1_000, 16_999), false);
  assert.equal(eventStreamIsStale(1_000, 17_000), true);
  assert.equal(eventStreamIsStale(undefined, 99_000), false);
});

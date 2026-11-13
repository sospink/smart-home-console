/**
 * 把“希望保持连接”与某一次异步连接尝试分开。
 * stop 后旧快照、旧票据和旧 socket 回调都会因代次不匹配而失效。
 */
export class ConnectionIntent {
  private generation = 0;
  private desired = false;

  start() {
    if (this.desired) return this.generation;
    this.desired = true;
    this.generation += 1;
    return this.generation;
  }

  nextAttempt() {
    if (!this.desired) return undefined;
    this.generation += 1;
    return this.generation;
  }

  stop() {
    this.desired = false;
    this.generation += 1;
  }

  accepts(generation: number) {
    return this.desired && generation === this.generation;
  }

  shouldReconnect(generation: number) {
    return this.accepts(generation);
  }
}

export function reconnectDelay(attempt: number, base = 1600, maximum = 30_000, random = Math.random) {
  const exponential = Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
  // 两台实训屏通常同时发现 EdgeCore 断线。±20% 抖动可避免恢复瞬间同时请求快照、票据和事件流。
  const jittered = exponential * (0.8 + random() * 0.4);
  return Math.round(Math.min(maximum, jittered));
}

export type ConnectionPhase = "network" | "snapshot" | "ticket" | "events";

export interface ConnectionIssue {
  phase: ConnectionPhase;
  title: string;
  detail: string;
  code: string;
}

export function preferConnectionIssue(current: ConnectionIssue | undefined, next: ConnectionIssue) {
  // 快照已经证明 EdgeCore 不可达时，随后的票据 fetch 失败是同一根因的下游症状，不应误导现场重新配对。
  if (current?.phase === "snapshot" && next.phase === "ticket" && next.title !== "终端认证失效") return current;
  return next;
}

export class EventLiveness {
  private timer: number | undefined;

  constructor(
    private readonly timeoutMs = 16_000,
    private readonly onTimeout: () => void,
    private readonly clock: Pick<typeof window, "setTimeout" | "clearTimeout"> = window
  ) {}

  received() {
    this.stop();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.onTimeout();
    }, this.timeoutMs);
  }

  stop() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function eventStreamIsStale(lastReceivedAt: number | undefined, now = Date.now(), timeoutMs = 16_000) {
  return lastReceivedAt !== undefined && now - lastReceivedAt >= timeoutMs;
}

export function connectionIssue(error: unknown, phase: ConnectionPhase): ConnectionIssue {
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "CONNECTION_FAILED";
  if (phase === "network") {
    return { phase, code, title: "当前网络不可用", detail: "请检查实训屏的 Wi-Fi 或网线连接，联网后将自动重连" };
  }
  if (/HTTP_?(401|403)|(^|[_:\s])(AUTH|TOKEN|TERMINAL)([_:\s]|$)/i.test(code)) {
    return { phase, code, title: "终端认证失效", detail: "终端凭据未通过 EdgeCore 校验，请在管理端重新配对" };
  }
  if (phase === "ticket") {
    return { phase, code, title: "安全连接建立失败", detail: "无法取得实时事件票据，系统将自动重试" };
  }
  if (phase === "events") {
    if (/AUTHORITATIVE_SNAPSHOT_TIMEOUT/i.test(code)) {
      return { phase, code, title: "权威状态获取超时", detail: "事件流未提供启动快照，控制保持锁定并正在自动更换连接" };
    }
    if (/CONNECT_TIMEOUT/i.test(code)) {
      return { phase, code, title: "实时连接建立超时", detail: "EdgeCore 未及时完成事件流握手，正在自动重试" };
    }
    if (/STALE|TIMEOUT/i.test(code)) {
      return { phase, code, title: "实时状态已停止更新", detail: "连接看似在线但心跳已超时，正在自动建立新连接" };
    }
    return { phase, code, title: "实时状态流中断", detail: "控制已暂时锁定，当前页面保留最后已知状态" };
  }
  if (/Failed to fetch|Load failed|NetworkError|fetch|HTTP_5\d\d/i.test(code)) {
    return { phase, code, title: "本地控制服务不可达", detail: "未能访问 EdgeCore，请检查服务和局域网连接" };
  }
  if (code === "API_REQUEST_TIMEOUT") {
    return { phase, code, title: "本地控制服务响应超时", detail: "EdgeCore 未在限定时间内响应，系统将自动重试" };
  }
  return { phase, code, title: "本地控制服务连接失败", detail: "系统将继续自动重试，也可点击立即重连" };
}

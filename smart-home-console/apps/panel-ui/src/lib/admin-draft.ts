import type { AdminConfiguration } from "@smart-lab/contracts";

export const ADMIN_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADMIN_DRAFT_STORAGE_KEY = "smart-lab.admin-configuration-draft.v1";

export interface AdminConfigurationDraft {
  schema: 1;
  savedAt: string;
  activeTab: string;
  baseline: AdminConfiguration;
  local: AdminConfiguration;
}

export const adminDraftRecoveryCopy = {
  title: "发现上次中断留下的配置草稿",
  authority: "草稿尚未写入 EdgeCore，也不会自动覆盖当前权威配置。",
  conflict: "恢复后必须先查看差异并合并，不能直接覆盖其他管理员的新修改。",
  boundary: "草稿不包含 PIN、Bearer 或明文网关凭据；超过 24 小时会自动失效。"
} as const;

export function promptAdminDraftRecovery(draft: AdminConfigurationDraft, serverVersion: number, savedAt: string) {
  return new Promise<"restore" | "discard">((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "admin-draft-recovery-dialog";
    dialog.setAttribute("aria-label", adminDraftRecoveryCopy.title);
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
      const value = document.createElement(tag);
      if (text) value.textContent = text;
      return value;
    };
    dialog.append(
      element("h2", adminDraftRecoveryCopy.title),
      element("p", `草稿保存于 ${savedAt}，基于服务端版本 ${draft.baseline.version}。${adminDraftRecoveryCopy.authority}`)
    );
    if (draft.baseline.version !== serverVersion) {
      const warning = element("p", `当前服务端已是版本 ${serverVersion}。${adminDraftRecoveryCopy.conflict}`);
      warning.className = "warning";
      dialog.append(warning);
    }
    const footer = element("footer");
    const discard = element("button", "丢弃草稿，使用服务端版本");
    discard.dataset.choice = "discard";
    const restore = element("button", "恢复草稿并检查");
    restore.dataset.choice = "restore";
    footer.append(discard, restore);
    dialog.append(element("small", adminDraftRecoveryCopy.boundary), footer);
    const style = document.createElement("style");
    style.textContent = `
      .admin-draft-recovery-dialog{width:min(760px,calc(100% - 48px));max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:0;border-radius:20px;background:var(--card,#fff);color:var(--text-primary,#202428);box-shadow:0 24px 72px #14181c33}
      .admin-draft-recovery-dialog::backdrop{background:#14181c6b}
      .admin-draft-recovery-dialog h2{margin:0 0 20px;font-size:20px}.admin-draft-recovery-dialog p,.admin-draft-recovery-dialog small{line-height:1.7}
      .admin-draft-recovery-dialog .warning{padding:12px 14px;border-radius:12px;background:#ffae451f;color:var(--warning,#b96b16)}
      .admin-draft-recovery-dialog small{display:block;color:var(--text-secondary,#6d747b)}.admin-draft-recovery-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}
      .admin-draft-recovery-dialog button{min-height:44px;padding:0 18px;border:0;border-radius:12px;font:inherit;cursor:pointer;background:#ffae451f;color:var(--warning,#b96b16)}
      .admin-draft-recovery-dialog button[data-choice=restore]{background:var(--primary,#32a7ff);color:#fff}.admin-draft-recovery-dialog button:focus-visible{outline:2px solid var(--primary,#32a7ff);outline-offset:2px}
    `;
    const finish = (choice: "restore" | "discard") => {
      dialog.close();
      dialog.remove();
      style.remove();
      resolve(choice);
    };
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const choices = [discard, restore];
      const active = document.activeElement;
      if (!choices.includes(active as HTMLButtonElement)) {
        event.preventDefault();
        restore.focus();
        return;
      }
      if (event.shiftKey && active === choices[0]) {
        event.preventDefault();
        choices[1].focus();
      } else if (!event.shiftKey && active === choices[1]) {
        event.preventDefault();
        choices[0].focus();
      }
    });
    dialog.addEventListener("click", (event) => {
      const choice = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-choice]")?.dataset.choice;
      if (choice === "restore" || choice === "discard") finish(choice);
    });
    document.head.append(style);
    document.body.append(dialog);
    dialog.showModal();
    restore.focus();
  });
}

interface DraftNativeBridge {
  getAdminConfigurationDraft?(): string;
  saveAdminConfigurationDraft?(payload: string): boolean;
  clearAdminConfigurationDraft?(): void;
}

interface DraftWindow extends Window {
  SmartLabNative?: DraftNativeBridge;
}

function browserDraftStorage() {
  if (typeof window === "undefined") return undefined;
  const development = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV;
  return development || ["localhost", "127.0.0.1"].includes(window.location.hostname) ? window.sessionStorage : undefined;
}

function configurationDraftCopy(configuration: AdminConfiguration): AdminConfiguration {
  const clone = JSON.parse(JSON.stringify(configuration)) as AdminConfiguration;
  clone.exportedAt = undefined;
  return clone;
}

function withCurrentAuthority(value: AdminConfiguration, latest: AdminConfiguration) {
  const restored = JSON.parse(JSON.stringify(value)) as AdminConfiguration;
  restored.terminals.forEach((terminal) => {
    const current = latest.terminals.find((item) => item.id === terminal.id);
    if (!current) return;
    terminal.online = current.online;
    terminal.version = current.version;
    terminal.address = current.address;
    terminal.lastSeenAt = current.lastSeenAt;
    terminal.paired = current.paired;
  });
  return restored;
}

export function prepareRecoveredAdminDraft(draft: AdminConfigurationDraft, latest: AdminConfiguration, allowedTabs: string[]) {
  const serverChanged = draft.baseline.version !== latest.version;
  return {
    local: withCurrentAuthority(draft.local, latest),
    baseline: withCurrentAuthority(draft.baseline, latest),
    savedSnapshot: serverChanged ? withCurrentAuthority(draft.baseline, latest) : latest,
    activeTab: allowedTabs.includes(draft.activeTab) ? draft.activeTab : "overview",
    serverChanged,
    feedbackType: serverChanged ? ("warning" as const) : ("success" as const),
    feedbackMessage: serverChanged
      ? "已恢复中断前草稿；服务端版本已变化，请先查看差异并合并"
      : "已恢复中断前草稿；尚未写入 EdgeCore，请检查后保存"
  };
}

export async function recoverAdminConfigurationDraft(
  latest: AdminConfiguration,
  allowedTabs: string[],
  formatSavedAt: (value: string) => string
) {
  const draft = loadAdminConfigurationDraft();
  if (!draft) return undefined;
  const choice = await promptAdminDraftRecovery(draft, latest.version, formatSavedAt(draft.savedAt));
  if (choice === "discard") {
    clearAdminConfigurationDraft();
    return { choice, message: "已丢弃上次中断留下的本机草稿，继续使用服务端最新配置" } as const;
  }
  return { choice, ...prepareRecoveredAdminDraft(draft, latest, allowedTabs) } as const;
}

export function createAdminConfigurationDraft(
  baseline: AdminConfiguration,
  local: AdminConfiguration,
  activeTab: string,
  now = new Date()
): AdminConfigurationDraft {
  return {
    schema: 1,
    savedAt: now.toISOString(),
    activeTab,
    baseline: configurationDraftCopy(baseline),
    local: configurationDraftCopy(local)
  };
}

export function persistAdminConfigurationDraft(baselineSnapshot: string, local: AdminConfiguration, activeTab: string) {
  try {
    const baseline = JSON.parse(baselineSnapshot) as AdminConfiguration;
    return saveAdminConfigurationDraft(createAdminConfigurationDraft(baseline, local, activeTab));
  } catch {
    return false;
  }
}

export function startAdminDraftPersistence(
  current: () => { authenticated: boolean; baseline: string; local?: AdminConfiguration; activeTab: string },
  notify: (type: "success" | "warning", message: string) => void
) {
  const controller = createAdminDraftPersistenceController(
    current,
    (baseline, local, activeTab) => persistAdminConfigurationDraft(baseline, local, activeTab),
    clearAdminConfigurationDraft,
    notify
  );
  const timer = window.setInterval(controller.flush, 1_000);
  return { flush: controller.flush, stop: () => window.clearInterval(timer) };
}

export function createAdminDraftPersistenceController(
  current: () => { authenticated: boolean; baseline: string; local?: AdminConfiguration; activeTab: string },
  persist: (baseline: string, local: AdminConfiguration, activeTab: string) => boolean,
  clear: () => void,
  notify: (type: "success" | "warning", message: string) => void
) {
  let lastPersistedState = "";
  let writeFailed = false;
  const flush = () => {
    const state = current();
    const localSnapshot = state.local ? JSON.stringify(state.local) : "";
    if (!state.authenticated || !state.baseline || !state.local || localSnapshot === state.baseline) {
      if (state.authenticated && localSnapshot === state.baseline) clear();
      lastPersistedState = "";
      writeFailed = false;
      return;
    }
    const persistenceState = JSON.stringify([state.baseline, localSnapshot, state.activeTab]);
    if (persistenceState === lastPersistedState) return;
    if (persist(state.baseline, state.local, state.activeTab)) {
      lastPersistedState = persistenceState;
      if (writeFailed) notify("success", "本机安全草稿已恢复写入");
      writeFailed = false;
      return;
    }
    if (!writeFailed) notify("warning", "未保存修改仍在当前页面，但本机安全草稿写入失败；系统会自动重试，请尽快保存到 EdgeCore");
    writeFailed = true;
  };
  return { flush };
}

export function parseAdminConfigurationDraft(payload: string, now = Date.now()): AdminConfigurationDraft | undefined {
  try {
    const value = JSON.parse(payload) as Partial<AdminConfigurationDraft>;
    const savedAt = Date.parse(value.savedAt ?? "");
    if (
      value.schema !== 1 ||
      !Number.isFinite(savedAt) ||
      savedAt > now + 60_000 ||
      now - savedAt > ADMIN_DRAFT_MAX_AGE_MS ||
      !value.baseline ||
      !value.local ||
      !Number.isSafeInteger(value.baseline.version) ||
      !Number.isSafeInteger(value.local.version) ||
      typeof value.activeTab !== "string" ||
      !Array.isArray(value.baseline.rooms) ||
      !Array.isArray(value.local.rooms)
    )
      return undefined;
    return value as AdminConfigurationDraft;
  } catch {
    return undefined;
  }
}

export function saveAdminConfigurationDraft(draft: AdminConfigurationDraft) {
  if (typeof window === "undefined") return false;
  const bridge = (window as DraftWindow).SmartLabNative;
  try {
    const payload = JSON.stringify(draft);
    // 一旦处于原生容器，桥缺失/异常都必须安全失败，不能降级为 Web 明文存储。
    if (bridge) return bridge.saveAdminConfigurationDraft?.(payload) === true;
    const storage = browserDraftStorage();
    if (!storage) return false;
    storage.setItem(ADMIN_DRAFT_STORAGE_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

export function loadAdminConfigurationDraft() {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as DraftWindow).SmartLabNative;
  let payload: string;
  try {
    payload = bridge ? (bridge.getAdminConfigurationDraft?.() ?? "") : (browserDraftStorage()?.getItem(ADMIN_DRAFT_STORAGE_KEY) ?? "");
  } catch {
    return undefined;
  }
  if (typeof payload !== "string") {
    clearAdminConfigurationDraft();
    return undefined;
  }
  const draft = payload ? parseAdminConfigurationDraft(payload) : undefined;
  if (payload && !draft) clearAdminConfigurationDraft();
  return draft;
}

export function clearAdminConfigurationDraft() {
  if (typeof window === "undefined") return;
  const bridge = (window as DraftWindow).SmartLabNative;
  if (bridge) {
    try {
      bridge.clearAdminConfigurationDraft?.();
    } catch {
      // 清理失败不能打断退出、保存或 PIN 轮换；下次读取仍会重新校验草稿。
    }
    return;
  }
  try {
    browserDraftStorage()?.removeItem(ADMIN_DRAFT_STORAGE_KEY);
  } catch {
    // 存储被禁用时保持管理工作流可用。
  }
}

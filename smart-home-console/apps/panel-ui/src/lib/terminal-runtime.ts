export type PanelSurface = "primary" | "secondary" | "admin";
export type TerminalRole = "primary" | "secondary";
export type CommandSource = PanelSurface | "automation";

const panelSurfaces: PanelSurface[] = ["primary", "secondary", "admin"];
const viteEnvironment = import.meta.env;
const developmentTerminalRole =
  viteEnvironment?.DEV && (viteEnvironment.VITE_TERMINAL_ROLE === "primary" || viteEnvironment.VITE_TERMINAL_ROLE === "secondary")
    ? (viteEnvironment.VITE_TERMINAL_ROLE as TerminalRole)
    : undefined;

export interface SmartLabNativeBridge {
  getRole?(): string;
  getEdgeBaseUrl?(): string;
  getTerminalToken?(): string;
  getAppVersion?(): string;
  rememberSurface?(surface: string): boolean;
  requestTerminalReconfiguration?(): boolean;
  onTerminalAuthenticationInvalid?(): void;
  downloadDatabaseBackup?(filename: string, adminToken: string): boolean;
  getAdminConfigurationDraft?(): string;
  saveAdminConfigurationDraft?(payload: string): boolean;
  clearAdminConfigurationDraft?(): void;
  configureHomeAssistant?(payload: string, adminToken: string): boolean;
}

export function nativeBridge(): SmartLabNativeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { SmartLabNative?: SmartLabNativeBridge }).SmartLabNative;
}

export function nativeTerminalRole(bridge: SmartLabNativeBridge | undefined = nativeBridge()): TerminalRole | undefined {
  try {
    const value = bridge?.getRole?.();
    return value === "primary" || value === "secondary" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function nativeAppVersion(bridge: SmartLabNativeBridge | undefined = nativeBridge()) {
  try {
    return bridge?.getAppVersion?.()?.trim() ?? "";
  } catch {
    return "";
  }
}

export function panelSurface(
  value = typeof window === "undefined" ? "/primary" : `${window.location.pathname}${window.location.hash}`
): PanelSurface {
  if (value.includes("secondary")) return "secondary";
  if (value.includes("admin")) return "admin";
  return "primary";
}

/**
 * 物理终端身份和当前查看界面严格分离：原生副屏即使查看主屏页面，仍只能以 secondary 身份接入 EdgeCore。
 * 纯浏览器没有原生身份时才按入口回退；管理页默认运行在主屏身份的浏览器调试域。
 */
export function runtimeTerminalRole(): TerminalRole {
  return nativeTerminalRole() ?? developmentTerminalRole ?? (panelSurface() === "secondary" ? "secondary" : "primary");
}

export function runtimeCommandSource(requested?: CommandSource): CommandSource {
  if (panelSurface() === "admin") return "admin";
  return nativeTerminalRole() ?? developmentTerminalRole ?? requested ?? panelSurface();
}

export function rememberNativeSurface(surface: PanelSurface) {
  if (!panelSurfaces.includes(surface)) return false;
  try {
    return nativeBridge()?.rememberSurface?.(surface) === true;
  } catch {
    return false;
  }
}

export function requestNativeTerminalReconfiguration() {
  try {
    return nativeBridge()?.requestTerminalReconfiguration?.() === true;
  } catch {
    return false;
  }
}

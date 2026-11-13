import type { Device, DeviceCapability } from "@smart-lab/contracts";

type HaState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated: string;
};

export type HomeAssistantConfig = {
  baseUrl: string;
  token: string;
  gatewayEntityId: string;
  lightEntityId: string;
  pollIntervalMs: number;
  confirmationTimeoutMs: number;
};

export type HaSnapshot = {
  gatewayOnline: boolean;
  gateway: Record<string, string | number | boolean | null>;
  lightOnline: boolean;
  light: Record<string, string | number | boolean | null>;
  lightCapabilities: DeviceCapability[];
  updatedAt: string;
};

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

export function homeAssistantConfigFromEnvironment(): HomeAssistantConfig | undefined {
  const token = process.env.HA_TOKEN?.trim();
  if (!token) return undefined;
  return {
    baseUrl: normalizeBaseUrl(process.env.HA_URL?.trim() || "http://192.168.0.110:8123"),
    token,
    gatewayEntityId: process.env.HA_GATEWAY_ENTITY?.trim() || "sensor.lumi_cn_599968967_mcn001_ip_address_p_2_2",
    lightEntityId: process.env.HA_LIGHT_ENTITY?.trim() || "light.xiaomi_cn_2142280092_btlm2_s_2_light",
    pollIntervalMs: Number(process.env.HA_POLL_INTERVAL_MS || 2_000),
    confirmationTimeoutMs: Number(process.env.HA_CONFIRMATION_TIMEOUT_MS || 10_000)
  };
}

export class HomeAssistantClient {
  constructor(readonly config: HomeAssistantConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`HA_HTTP_${response.status}`);
    return (await response.json()) as T;
  }

  private state(entityId: string) {
    return this.request<HaState>(`/api/states/${encodeURIComponent(entityId)}`);
  }

  async snapshot(): Promise<HaSnapshot> {
    const [gateway, light] = await Promise.all([this.state(this.config.gatewayEntityId), this.state(this.config.lightEntityId)]);
    const gatewayOnline = gateway.state !== "unavailable" && gateway.state !== "unknown";
    const lightOnline = light.state !== "unavailable" && light.state !== "unknown";
    const brightness = typeof light.attributes.brightness === "number" ? Math.round((light.attributes.brightness / 255) * 100) : 0;
    const colorTemperature = typeof light.attributes.color_temp_kelvin === "number" ? Math.round(light.attributes.color_temp_kelvin) : 0;
    const minimumColorTemperature = numberAttribute(light.attributes, "min_color_temp_kelvin");
    const maximumColorTemperature = numberAttribute(light.attributes, "max_color_temp_kelvin");
    const supportedColorModes = stringArrayAttribute(light.attributes, "supported_color_modes");
    const effects = stringArrayAttribute(light.attributes, "effect_list");
    const lightCapabilities: DeviceCapability[] = [
      { property: "power", label: "电源", type: "boolean", writable: true },
      { property: "brightness", label: "亮度", type: "number", min: 1, max: 100, step: 1, unit: "%", writable: true }
    ];
    if (supportedColorModes.includes("color_temp") && minimumColorTemperature != null && maximumColorTemperature != null) {
      lightCapabilities.push({
        property: "colorTemperature",
        label: "色温",
        type: "number",
        min: minimumColorTemperature,
        max: maximumColorTemperature,
        step: 100,
        unit: "K",
        writable: true
      });
    }
    if (effects.length) {
      lightCapabilities.push({
        property: "effect",
        label: "灯效",
        type: "enum",
        writable: true,
        options: effects.map((effect) => ({ label: friendlyEffectLabel(effect), value: effect }))
      });
    }
    return {
      gatewayOnline,
      gateway: {
        ipAddress: gateway.state,
        firmware: "1.0.8_0013",
        connection: "cloud",
        latencyMs: 0
      },
      lightOnline,
      light: {
        power: light.state === "on",
        brightness,
        ...(lightCapabilities.some((item) => item.property === "colorTemperature") ? { colorTemperature } : {}),
        ...(typeof light.attributes.effect === "string" ? { effect: light.attributes.effect } : {})
      },
      lightCapabilities,
      updatedAt: light.last_updated || new Date().toISOString()
    };
  }

  async command(property: string, value: string | number | boolean): Promise<HaSnapshot> {
    const data: Record<string, unknown> = { entity_id: this.config.lightEntityId };
    let service = "turn_on";
    if (property === "power" && typeof value === "boolean") service = value ? "turn_on" : "turn_off";
    else if (property === "brightness" && typeof value === "number") data.brightness_pct = value;
    else if (property === "colorTemperature" && typeof value === "number") data.color_temp_kelvin = value;
    else if (property === "effect" && typeof value === "string") data.effect = value;
    else if (["power", "brightness", "colorTemperature", "effect"].includes(property)) throw new Error("HA_VALUE_INVALID");
    else throw new Error(`HA_PROPERTY_UNSUPPORTED:${property}`);
    await this.request(`/api/services/light/${service}`, { method: "POST", body: JSON.stringify(data) });

    const deadline = Date.now() + this.config.confirmationTimeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this.snapshot();
      const actual = snapshot.light[property];
      const matches =
        typeof value === "number" && typeof actual === "number"
          ? Math.abs(actual - value) <= (property === "colorTemperature" ? 100 : 1)
          : actual === value;
      if (snapshot.lightOnline && matches) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    throw new Error("HA_STATE_CONFIRMATION_TIMEOUT");
  }
}

export function applyHaSnapshot(devices: Device[], snapshot: HaSnapshot) {
  const gateway = devices.find((item) => item.id === "gateway-main");
  const light = devices.find((item) => item.id === "living-main-light");
  if (gateway) {
    gateway.health = snapshot.gatewayOnline ? "online" : "offline";
    gateway.state = { ...gateway.state, ...snapshot.gateway };
    gateway.updatedAt = snapshot.updatedAt;
    gateway.integration = {
      ...gateway.integration,
      adapter: "home-assistant",
      externalId: "sensor.lumi_cn_599968967_mcn001_ip_address_p_2_2",
      internalModel: "lumi.gateway.mcn001",
      verificationStatus: "hardware-verified",
      note: "HA 官方 Xiaomi Home 云端接入；不是 DMWG03LM 本地控制。"
    };
  }
  if (light) {
    light.name = "筒灯";
    light.room = "卧室";
    light.health = snapshot.lightOnline && snapshot.gatewayOnline ? "online" : "offline";
    light.state = { ...light.state, ...snapshot.light };
    light.capabilities = snapshot.lightCapabilities;
    light.updatedAt = snapshot.updatedAt;
    light.integration = {
      ...light.integration,
      adapter: "home-assistant",
      externalId: "light.xiaomi_cn_2142280092_btlm2_s_2_light",
      marketModel: "xiaomi.light.btlm2",
      internalModel: "xiaomi.light.btlm2",
      verificationStatus: "hardware-verified",
      note: "已验证 HA 云端开关、亮度、色温和状态回传。"
    };
  }
  for (const device of devices) {
    if (device.id !== "gateway-main" && device.id !== "living-main-light") device.health = "offline";
  }
}

function numberAttribute(attributes: Record<string, unknown>, property: string) {
  const value = attributes[property];
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function stringArrayAttribute(attributes: Record<string, unknown>, property: string) {
  const value = attributes[property];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function friendlyEffectLabel(effect: string) {
  return effect.startsWith("空场景") ? "常规" : effect.replace(/模式$/, "");
}

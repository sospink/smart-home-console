import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { HomeAssistantClient } from "./home-assistant.js";

test("HA command is confirmed only after the entity state reaches the requested value", async (t) => {
  let brightness = 255;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/services/light/")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { brightness_pct: number };
        setTimeout(() => (brightness = Math.round((body.brightness_pct / 100) * 255)), 80);
        res.end("[]");
      });
      return;
    }
    if (req.url?.includes("gateway")) {
      res.end(
        JSON.stringify({ entity_id: "sensor.gateway", state: "192.168.1.2", attributes: {}, last_updated: new Date().toISOString() })
      );
      return;
    }
    res.end(
      JSON.stringify({
        entity_id: "light.test",
        state: "on",
        attributes: { brightness, color_temp_kelvin: 4000 },
        last_updated: new Date().toISOString()
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new HomeAssistantClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "secret",
    gatewayEntityId: "sensor.gateway",
    lightEntityId: "light.test",
    pollIntervalMs: 20,
    confirmationTimeoutMs: 2_000
  });
  const result = await client.command("brightness", 62);
  assert.equal(result.light.brightness, 62);
});

test("HA command fails closed when the entity never confirms the target", async (t) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/services/")) return res.end("[]");
    if (req.url?.includes("gateway")) {
      return res.end(
        JSON.stringify({ entity_id: "sensor.gateway", state: "192.168.1.2", attributes: {}, last_updated: new Date().toISOString() })
      );
    }
    return res.end(
      JSON.stringify({ entity_id: "light.test", state: "off", attributes: { brightness: 0 }, last_updated: new Date().toISOString() })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new HomeAssistantClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "secret",
    gatewayEntityId: "sensor.gateway",
    lightEntityId: "light.test",
    pollIntervalMs: 20,
    confirmationTimeoutMs: 150
  });
  await assert.rejects(client.command("power", true), /HA_STATE_CONFIRMATION_TIMEOUT/);
});

test("HA light capabilities use authoritative color-temperature range and effect options", async (t) => {
  let effect = "空场景（灯不在任何情况模式时，上报该属性值）";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/services/light/")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        effect = (JSON.parse(Buffer.concat(chunks).toString()) as { effect: string }).effect;
        res.end("[]");
      });
      return;
    }
    if (req.url?.includes("gateway")) {
      return res.end(
        JSON.stringify({ entity_id: "sensor.gateway", state: "192.168.1.2", attributes: {}, last_updated: new Date().toISOString() })
      );
    }
    return res.end(
      JSON.stringify({
        entity_id: "light.test",
        state: "on",
        attributes: {
          brightness: 128,
          color_temp_kelvin: 2700,
          min_color_temp_kelvin: 2700,
          max_color_temp_kelvin: 5700,
          supported_color_modes: ["color_temp"],
          effect_list: ["空场景（灯不在任何情况模式时，上报该属性值）", "夜灯模式"],
          effect
        },
        last_updated: new Date().toISOString()
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new HomeAssistantClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: "secret",
    gatewayEntityId: "sensor.gateway",
    lightEntityId: "light.test",
    pollIntervalMs: 20,
    confirmationTimeoutMs: 500
  });
  const snapshot = await client.snapshot();
  const colorTemperature = snapshot.lightCapabilities.find((item) => item.property === "colorTemperature");
  const effects = snapshot.lightCapabilities.find((item) => item.property === "effect");
  assert.deepEqual({ min: colorTemperature?.min, max: colorTemperature?.max }, { min: 2700, max: 5700 });
  assert.deepEqual(
    effects?.options?.map((item) => item.label),
    ["常规", "夜灯"]
  );
  const result = await client.command("effect", "夜灯模式");
  assert.equal(result.light.effect, "夜灯模式");
});

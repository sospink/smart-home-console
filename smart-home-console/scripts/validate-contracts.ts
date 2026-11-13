import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

async function main() {
  const root = resolve(__dirname, "..");
  const openapi = parse(await readFile(resolve(root, "openapi/openapi.yaml"), "utf8"));
  if (openapi.openapi !== "3.1.0") throw new Error("OpenAPI 版本必须为 3.1.0");
  if (
    !openapi.paths?.["/snapshot"] ||
    !openapi.paths?.["/devices/{deviceId}/commands"] ||
    !openapi.paths?.["/admin/login"] ||
    !openapi.paths?.["/admin/resources/{resource}"]
  ) {
    throw new Error("OpenAPI 缺少关键路径");
  }
  const ajv = new Ajv2020({ strict: true });
  for (const name of ["command-request.schema.json"]) {
    const schema = JSON.parse(await readFile(resolve(root, `packages/contracts/schemas/${name}`), "utf8"));
    ajv.compile(schema);
  }
  console.log("OpenAPI 3.1 与 JSON Schema 校验通过");
}

void main();

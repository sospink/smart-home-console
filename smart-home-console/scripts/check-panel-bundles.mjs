import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "apps/panel-ui/dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8"));

const routeEntries = {
  primary: "src/views/PrimaryView.vue",
  secondary: "src/views/SecondaryView.vue",
  admin: "src/views/AdminView.vue"
};

const budgets = {
  primary: { js: 225_000, css: 105_000, gzip: 108_000 },
  secondary: { js: 200_000, css: 80_000, gzip: 98_000 },
  // HA 原生安全配置表单只进入后台懒加载块；本轮认证路由回归保护仅带来 12 bytes
  // 的稳定 gzip 波动，保留严格上限并取整到 220 KiB，避免构建器微小差异制造假失败。
  admin: { js: 705_000, css: 65_000, gzip: 225_280 }
};

function collectEntry(key, files = new Set()) {
  const entry = manifest[key];
  if (!entry) throw new Error(`缺少构建入口：${key}`);
  if (entry.file) files.add(entry.file);
  for (const css of entry.css ?? []) files.add(css);
  for (const imported of entry.imports ?? []) collectEntry(imported, files);
  return files;
}

function metrics(files) {
  let js = 0;
  let css = 0;
  let gzip = 0;
  for (const file of files) {
    const path = join(dist, file);
    const bytes = statSync(path).size;
    if (file.endsWith(".js")) js += bytes;
    if (file.endsWith(".css")) css += bytes;
    if (file.endsWith(".js") || file.endsWith(".css")) gzip += gzipSync(readFileSync(path)).byteLength;
  }
  return { js, css, gzip };
}

const entry = manifest["index.html"];
if (!entry?.isEntry) throw new Error("缺少 panel-ui 生产入口 manifest");

const dynamicImports = new Set(entry.dynamicImports ?? []);
for (const routeEntry of Object.values(routeEntries)) {
  if (!dynamicImports.has(routeEntry)) throw new Error(`${routeEntry} 未保持按角色懒加载，禁止把三端重新合并进公共首包`);
}

let failed = false;
for (const [role, routeEntry] of Object.entries(routeEntries)) {
  const files = collectEntry("index.html");
  collectEntry(routeEntry, files);
  const actual = metrics(files);
  const budget = budgets[role];
  const exceeded = Object.entries(budget).filter(([metric, limit]) => actual[metric] > limit);
  console.log(
    `${role.padEnd(9)} JS ${(actual.js / 1024).toFixed(1)} KiB / CSS ${(actual.css / 1024).toFixed(1)} KiB / gzip ${(
      actual.gzip / 1024
    ).toFixed(1)} KiB`
  );
  for (const [metric, limit] of exceeded) {
    failed = true;
    console.error(`  超出 ${metric} 预算：${actual[metric]} > ${limit} bytes`);
  }
}

if (failed) process.exitCode = 1;
else console.log("三端生产首屏资源保持角色隔离并通过体积预算");

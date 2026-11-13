import { createHash, createPrivateKey, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const [version, privateKeyPath, outputPath = `output/panel-ui-${version}.signed.json`] = args;
if (!version || !privateKeyPath || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,47}$/.test(version)) {
  console.error("用法：node scripts/build-ui-update.mjs <version> <ed25519-private-key.pem> [output.json]");
  process.exit(1);
}

const root = resolve("apps/panel-ui/dist");
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const name = relative(root, path).split(sep).join("/");
      const body = await readFile(path);
      files.push({ path: name, body });
    }
  }
}
await walk(root);
files.sort((a, b) => a.path.localeCompare(b.path));
if (!files.some((file) => file.path === "index.html")) throw new Error("dist/index.html 不存在，请先运行 panel-ui 构建");
const totalSize = files.reduce((sum, file) => sum + file.body.length, 0);
if (files.length > 256 || totalSize > 40 * 1024 * 1024) throw new Error("更新包超过客户端安全上限");

const manifest = {
  version,
  minAppVersion: process.env.SMART_LAB_MIN_APP_VERSION || "0.1.0",
  createdAt: new Date().toISOString(),
  files: files.map(({ path, body }) => ({
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length
  }))
};
const manifestJson = JSON.stringify(manifest);
const privateKey = createPrivateKey(await readFile(resolve(privateKeyPath), "utf8"));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("必须使用 Ed25519 私钥");
const payload = {
  manifestJson,
  signature: sign(null, Buffer.from(manifestJson), privateKey).toString("base64"),
  files: Object.fromEntries(files.map(({ path, body }) => [path, body.toString("base64")]))
};
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), JSON.stringify(payload));
console.log(`已生成 ${outputPath}：${files.length} 个文件，${totalSize} bytes，版本 ${version}`);

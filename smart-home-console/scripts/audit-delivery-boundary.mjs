import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const apkArgument = process.argv.slice(2).find((argument) => argument !== "--");
const apk = apkArgument ? resolve(apkArgument) : null;
const scanRoots = [
  "AGENTS.md",
  "README.md",
  "docs",
  "apps/panel-ui/src",
  "apps/panel-ui/public",
  "packages/contracts",
  "openapi",
  "android/README.md",
  "android/app/src/main/java",
  "android/data/src/main",
  "android/edgecore/src/main",
  "android/gateway-api/src/main",
  "android/gateway-home-assistant/src/main"
];
const textExtensions = new Set([".css", ".html", ".js", ".json", ".kt", ".kts", ".mjs", ".ts", ".vue", ".yaml", ".yml"]);
const ignoredDirectories = new Set([".git", ".gradle", ".idea", ".vite", "build", "coverage", "dist", "node_modules", "output", "tmp"]);
const forbidden = [
  { label: "训练能力残留", pattern: /training/i },
  { label: "模拟器能力残留", pattern: /simulator/i },
  { label: "旧夜间压暗遮罩", pattern: /brightness-plan/i },
  { label: "教师实训模块", pattern: /教师实训/ },
  { label: "学生成绩模块", pattern: /学生成绩/ },
  { label: "故障注入模块", pattern: /故障注入/ }
];

function filesUnder(directory) {
  if (!statSync(directory).isDirectory()) return [directory];
  const files = [];
  for (const name of readdirSync(directory)) {
    if (ignoredDirectories.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else if (textExtensions.has(extname(path).toLowerCase())) files.push(path);
  }
  return files;
}

function violationsIn(directory, label) {
  const violations = [];
  for (const file of filesUnder(directory)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of forbidden) {
        if (rule.pattern.test(line) && !isAllowedOccurrence(file, line, rule.label)) {
          violations.push(`${label}:${relative(directory, file)}:${index + 1}: ${rule.label}`);
        }
      }
    }
  }
  return violations;
}

function isAllowedOccurrence(file, line, ruleLabel) {
  const path = relative(root, file);
  const isBoundaryDocument = path === "AGENTS.md" || path === "README.md" || path === "android/README.md" || path.startsWith("docs/");
  if (isBoundaryDocument && /(不属于|没有|不包含|不得|不暴露|只为|旧|防回归|移除|禁止|不注册|不提供|不进入)/.test(line)) {
    return true;
  }
  if (ruleLabel !== "训练能力残留") return false;
  if (path === "android/app/src/main/java/cn/zhijing/smartlab/EdgeForegroundService.kt") {
    return line.includes("migrateLegacyTrainingScene");
  }
  return (
    path === "android/data/src/main/java/cn/zhijing/smartlab/data/EdgeDao.kt" ||
    path === "android/data/src/main/java/cn/zhijing/smartlab/data/Entities.kt" ||
    path === "android/data/src/main/java/cn/zhijing/smartlab/data/SmartLabDatabase.kt"
  );
}

const violations = scanRoots.flatMap((directory) => violationsIn(resolve(root, directory), directory));
let extracted;
try {
  if (apk) {
    extracted = mkdtempSync(join(tmpdir(), "smart-lab-apk-audit-"));
    execFileSync("unzip", ["-qq", apk, "assets/panel-ui/*", "-d", extracted]);
    violations.push(...violationsIn(join(extracted, "assets/panel-ui"), `APK(${basename(apk)})`));
  }
} finally {
  if (extracted) rmSync(extracted, { recursive: true, force: true });
}

if (violations.length) {
  console.error(["正式交付边界审计失败：", ...violations.map((item) => `- ${item}`)].join("\n"));
  process.exit(1);
}

console.log(`正式交付边界审计通过${apk ? `（含 ${basename(apk)} 内嵌 UI）` : ""}`);

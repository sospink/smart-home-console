import { execFileSync } from "node:child_process";

const allowed = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0"]);
const inventory = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  })
);
const rejected = Object.keys(inventory).filter((license) => !allowed.has(license));

if (rejected.length > 0) {
  console.error(`发现未审核生产依赖许可：${rejected.join("、")}`);
  process.exit(1);
}

const packageCount = new Set(
  Object.values(inventory).flatMap((entries) => entries.map((entry) => `${entry.name}@${entry.versions.join(",")}`))
).size;
console.log(`生产依赖许可校验通过：${packageCount} 个包，${Object.keys(inventory).join(" / ")}`);

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Discover tests instead of maintaining a second list in package.json. This
// includes the pretest:server checks and the separately runnable test suites.
const root = fileURLToPath(new URL("../", import.meta.url));
const files = ["server", "shared", "client/src", "scripts"]
  .flatMap((directory) => fs.readdirSync(path.join(root, directory), { recursive: true })
    .filter((file) => /\.test\.(ts|tsx)$/.test(file))
    .map((file) => path.join(directory, file)))
  .sort();

if (files.length === 0) throw new Error("No test files found");
console.log(`Discovered ${files.length} test files`);
const child = spawn(process.execPath, [
  "--import", "tsx", "--test", "--test-concurrency=4", ...files,
], { cwd: root, stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

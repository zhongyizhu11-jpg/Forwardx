import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPanelSslReloader, panelSslCertificateExpiresAt, type PanelSslSettings } from "./panelSsl";

/**
 * 面板证书原来只在启动时读一次：自动续签写了新文件，面板照样拿着旧证书，直到它过期、
 * 所有人一起连不上。这里验证：文件变了会热加载；新文件坏了继续用旧的；快过期会提醒。
 */
const hasOpenssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

function makeCertificate(directory: string, name: string, days: number) {
  const certPath = path.join(directory, `${name}.crt`);
  const keyPath = path.join(directory, `${name}.key`);
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", String(days),
    "-subj", `/CN=${name}.example`, "-keyout", keyPath, "-out", certPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

test("证书文件更新后热加载，新文件坏了继续用旧的，快过期时提醒", { skip: !hasOpenssl && "openssl 不可用" }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-panel-ssl-"));
  try {
    const soon = makeCertificate(directory, "soon", 5);
    const later = makeCertificate(directory, "later", 400);
    const certPath = path.join(directory, "panel.crt");
    const keyPath = path.join(directory, "panel.key");
    fs.writeFileSync(certPath, soon.cert);
    fs.writeFileSync(keyPath, soon.key);

    const settings: PanelSslSettings = { enabled: true, mode: "path", certPath, keyPath, certPem: "", keyPem: "" };
    const applied: Array<{ cert: unknown }> = [];
    const warnings: string[] = [];
    let now = Date.now();
    const reloader = createPanelSslReloader(
      { setSecureContext: (options) => { applied.push({ cert: options.cert }); } },
      settings,
      { cert: soon.cert, key: soon.key },
      { now: () => now, logger: { info: () => {}, warn: (message: string) => { warnings.push(String(message)); } } },
    );

    assert.equal(await reloader.check(), "unchanged");
    assert.equal(applied.length, 0);
    assert.equal(warnings.filter((message) => /天后.*过期/.test(message)).length, 1, "只剩 5 天的证书要在日志里提醒");
    assert.equal(await reloader.check(), "unchanged");
    assert.equal(warnings.filter((message) => /过期/.test(message)).length, 1, "同一天不重复刷屏");

    // 续签：新证书写到同一路径（mtime/大小变了）。
    fs.writeFileSync(certPath, later.cert);
    fs.writeFileSync(keyPath, later.key);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(certPath, future, future);
    assert.equal(await reloader.check(), "reloaded");
    assert.equal(applied.length, 1);
    assert.equal(
      panelSslCertificateExpiresAt(applied[0].cert),
      panelSslCertificateExpiresAt(later.cert),
      "换上去的必须是新证书",
    );

    // 续签写到一半：证书换成了别的、私钥还是旧的 —— 对不上，不能换上去。
    fs.writeFileSync(certPath, soon.cert);
    const later2 = new Date(Date.now() + 120_000);
    fs.utimesSync(certPath, later2, later2);
    assert.equal(await reloader.check(), "failed");
    assert.equal(applied.length, 1, "坏的新文件不能替换正在用的证书");
    assert.ok(warnings.some((message) => /继续使用当前证书/.test(message)));

    // 文件没变，过了一小时也会重读一次（证书和私钥又对上了）。
    fs.writeFileSync(keyPath, soon.key);
    const later3 = new Date(Date.now() + 180_000);
    fs.utimesSync(keyPath, later3, later3);
    assert.equal(await reloader.check(), "reloaded");
    now += 61 * 60 * 1000;
    assert.equal(await reloader.check(), "reloaded");
    assert.equal(applied.length, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

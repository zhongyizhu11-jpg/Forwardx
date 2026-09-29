import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 换隧道后旧入口临时桥接的真机端到端：真的 Agent、真的 FXP、真的 iptables，跑在 network namespace 里。
 *
 *   hostA（隧道 A 入口）、hostB（隧道 B 入口）、hostX（两条隧道的出口 + TCP/UDP 回显目标）、
 *   client 四个 netns 接在同一个网桥上；面板跑在根 netns，三台机器的 Agent 各自在自己的
 *   netns 里带着私有的 /var/lib/forwardx-agent 等目录（mount namespace）真跑起来。
 *
 *   1. 在隧道 B 上建规则 P → hostX 回显，client 连 hostB:P 通；
 *   2. 通过真的 rules.update 把规则换到隧道 A；
 *   3. client 连 hostA:P 必须通（规则本身），连 hostB:P 也必须通（旧入口桥接）。
 *
 * 只在显式开启时跑（FORWARDX_NETNS_E2E=1），并且要 root + iptables + ip netns + unshare + go。
 * 产物（面板日志、Agent 日志、iptables 快照）留在 FORWARDX_NETNS_E2E_OUT 指定的目录里方便排查。
 */

const ENABLED = process.env.FORWARDX_NETNS_E2E === "1";
const ROOT = path.resolve(import.meta.dirname, "..");
const SUBNET = "10.77.0";
const RULE_PORT = 40981;
const ECHO_PORT = 9000;
/**
 * 入口机上预先摆好的防火墙布局（模拟生产机器上已有的东西），FORWARDX_NETNS_E2E_FORWARD_CHAIN：
 *   firewalld（默认）：FORWARD 链末尾已经有 REJECT（firewalld 的默认布局）—— 生产上桥接不通就是它；
 *   docker：FORWARD 默认策略 DROP + DOCKER-USER 链（装了 Docker 的机器）；
 *   none：什么都不摆。
 */
const FORWARD_CHAIN_LAYOUT = String(process.env.FORWARDX_NETNS_E2E_FORWARD_CHAIN ?? "firewalld").trim();

function forwardChainLayoutCommands(layout: string): string {
  switch (layout) {
    case "firewalld":
      return [
        "iptables -N FORWARD_IN_ZONES", "iptables -N FORWARD_OUT_ZONES",
        "iptables -A FORWARD -j FORWARD_IN_ZONES", "iptables -A FORWARD -j FORWARD_OUT_ZONES",
        "iptables -A FORWARD -m conntrack --ctstate INVALID -j DROP",
        "iptables -A FORWARD -j REJECT --reject-with icmp-host-prohibited",
      ].join(" && ");
    case "docker":
      return [
        "iptables -N DOCKER-USER", "iptables -A DOCKER-USER -j RETURN", "iptables -A FORWARD -j DOCKER-USER",
        "iptables -P FORWARD DROP",
      ].join(" && ");
    default:
      return "";
  }
}

function commandOk(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0;
}

function capabilityMissing(): string | null {
  if (process.platform !== "linux") return "只支持 Linux";
  if (typeof process.getuid === "function" && process.getuid() !== 0) return "需要 root";
  for (const [command, args] of [["iptables", ["-t", "nat", "-S"]], ["ip", ["netns", "list"]], ["unshare", ["--help"]], ["go", ["version"]]] as const) {
    if (!commandOk(command, [...args])) return `缺少 ${command}`;
  }
  return null;
}

function sh(command: string, options: { timeoutMs?: number; allowFailure?: boolean } = {}) {
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: options.timeoutMs || 30_000 });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`命令失败: ${command}\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function inNetns(ns: string, command: string, options: { timeoutMs?: number; allowFailure?: boolean } = {}) {
  return sh(`ip netns exec ${ns} sh -c ${JSON.stringify(command)}`, { allowFailure: true, ...options });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(`等 ${label} 超时（${timeoutMs}ms），最后一次: ${String(last)}`);
}

/** 面板子进程：真的 sqlite、真的 Agent 路由（含加密中间件）、真的 tRPC 路由，外加一个 /ctl 控制口。 */
const PANEL_SCRIPT = String.raw`
  import http from "node:http";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  import express from "express";
  import cookieParser from "cookie-parser";

  const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
  const runtime = await import(url("server/dbRuntime.ts"));
  const schema = await import(url("server/dbSchema.ts"));
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
  await schema.ensureDatabaseSchema();
  const exec = (sql, params = []) => runtime.executeRaw(sql, params);
  const query = (sql, params = []) => runtime.queryRaw(sql, params);

  const { agentRouter } = await import(url("server/agentRoutes.ts"));
  const { rulesRouter } = await import(url("server/routers/rules.ts"));
  const { tunnelsRouter } = await import(url("server/routers/tunnels.ts"));
  const { sweepExpiredRuleEntryBridges } = await import(url("server/ruleEntryBridges.ts"));
  const context = { req: { headers: {} }, res: { clearCookie() {} }, user: { id: 1, username: "admin", role: "admin", accountEnabled: true }, authSession: null, authFailureReason: null };
  const routers = { rules: rulesRouter, tunnels: tunnelsRouter };

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
  app.use(cookieParser());
  app.use(agentRouter);
  app.post("/ctl/sql", async (req, res) => {
    try { res.json({ rows: await (req.body.mode === "query" ? query(req.body.sql, req.body.params || []) : exec(req.body.sql, req.body.params || [])) }); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/ctl/call", async (req, res) => {
    try {
      const caller = routers[req.body.router].createCaller(context);
      res.json({ result: await caller[req.body.proc](req.body.input) });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/ctl/sweep", async (_req, res) => {
    try { res.json({ hosts: await sweepExpiredRuleEntryBridges() }); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  console.log("PANEL_READY port=" + server.address().port);
`;

const ECHO_SCRIPT = String.raw`
  const net = require("node:net");
  const dgram = require("node:dgram");
  const [host, port] = [process.argv[1], Number(process.argv[2])];
  net.createServer((socket) => socket.pipe(socket)).listen(port, host, () => console.log("tcp-echo " + host + ":" + port));
  const udp = dgram.createSocket("udp4");
  udp.on("message", (message, peer) => udp.send(message, peer.port, peer.address));
  udp.bind(port, host, () => console.log("udp-echo " + host + ":" + port));
`;

/** client 侧的探测：TCP 连上发一行等回显；UDP 发一包等回包。输出 OK / FAIL。 */
const PROBE_SCRIPT = String.raw`
  const net = require("node:net");
  const dgram = require("node:dgram");
  const [proto, host, port] = [process.argv[1], process.argv[2], Number(process.argv[3])];
  const payload = "ping-" + Date.now() + "\n";
  const done = (text) => { console.log(text); process.exit(0); };
  const timer = setTimeout(() => done("FAIL timeout"), 4000);
  if (proto === "tcp") {
    const socket = net.createConnection({ host, port }, () => socket.write(payload));
    let got = "";
    socket.on("data", (chunk) => { got += chunk.toString(); if (got === payload) { clearTimeout(timer); socket.destroy(); done("OK"); } });
    socket.on("error", (error) => { clearTimeout(timer); done("FAIL " + error.code); });
  } else {
    const socket = dgram.createSocket("udp4");
    socket.on("message", (message) => { if (message.toString() === payload) { clearTimeout(timer); socket.close(); done("OK"); } });
    socket.on("error", (error) => { clearTimeout(timer); done("FAIL " + error.code); });
    socket.send(payload, port, host);
  }
`;

/** 一直用同一个源端口往入口发 UDP 的客户端（hy2 / tuic / WireGuard 这类客户端都是这样）：每 500ms 一包，记下哪些收到了回包。 */
const STICKY_UDP_SCRIPT = String.raw`
  const dgram = require("node:dgram");
  const fs = require("node:fs");
  const [host, port, localPort, logFile] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
  const socket = dgram.createSocket("udp4");
  let seq = 0;
  socket.on("message", (message) => fs.appendFileSync(logFile, new Date().toISOString() + " reply " + message.toString().trim() + "\n"));
  socket.bind(localPort, () => {
    setInterval(() => { seq += 1; const text = "seq " + seq; fs.appendFileSync(logFile, new Date().toISOString() + " send " + text + "\n"); socket.send(text, port, host); }, 500);
  });
`;

type HostSpec = { key: "A" | "B" | "X" | "C"; ns: string; ip: string; token?: string };

class Lab {
  readonly suffix = Math.random().toString(36).slice(2, 7);
  readonly bridge = `fxe2e${this.suffix}`;
  readonly hosts: Record<"A" | "B" | "X" | "C", HostSpec>;
  readonly dir: string;
  readonly bin: string;
  readonly children: ChildProcess[] = [];
  panel: ChildProcess | null = null;
  panelPort = 0;
  hostIds: Record<string, number> = {};

  constructor() {
    this.dir = process.env.FORWARDX_NETNS_E2E_OUT
      ? path.resolve(process.env.FORWARDX_NETNS_E2E_OUT)
      : fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-netns-e2e-"));
    fs.mkdirSync(this.dir, { recursive: true });
    this.bin = path.join(this.dir, "bin");
    this.hosts = {
      A: { key: "A", ns: `fxA${this.suffix}`, ip: `${SUBNET}.11`, token: `tok-a-${this.suffix}` },
      B: { key: "B", ns: `fxB${this.suffix}`, ip: `${SUBNET}.12`, token: `tok-b-${this.suffix}` },
      X: { key: "X", ns: `fxX${this.suffix}`, ip: `${SUBNET}.13`, token: `tok-x-${this.suffix}` },
      C: { key: "C", ns: `fxC${this.suffix}`, ip: `${SUBNET}.14` },
    };
  }

  log(line: string) {
    const text = `${new Date().toISOString()} ${line}`;
    console.log(text);
    fs.appendFileSync(path.join(this.dir, "e2e.log"), `${text}\n`);
  }

  buildBinaries() {
    fs.mkdirSync(this.bin, { recursive: true });
    for (const [module, name] of [["agent", "forwardx-agent"], ["forwardx-fxp", "forwardx-fxp"]] as const) {
      const result = spawnSync("go", ["build", "-o", path.join(this.bin, name), "."], { cwd: path.join(ROOT, module), encoding: "utf8", timeout: 600_000 });
      assert.equal(result.status, 0, `go build ${module} 失败:\n${result.stdout}\n${result.stderr}`);
    }
  }

  setupNetwork() {
    sh(`ip link add ${this.bridge} type bridge && ip addr add ${SUBNET}.1/24 dev ${this.bridge} && ip link set ${this.bridge} up`);
    for (const host of Object.values(this.hosts)) {
      const veth = `v${host.key}${this.suffix}`;
      const peer = `e${host.key}${this.suffix}`;
      sh(`ip netns add ${host.ns} && ip link add ${veth} type veth peer name ${peer} && ip link set ${veth} master ${this.bridge} up && ip link set ${peer} netns ${host.ns}`);
      inNetns(host.ns, `ip link set lo up && ip addr add ${host.ip}/24 dev ${peer} && ip link set ${peer} up && ip route add default via ${SUBNET}.1 && sysctl -w net.ipv4.ip_forward=1 >/dev/null`, { allowFailure: false });
      const layout = forwardChainLayoutCommands(FORWARD_CHAIN_LAYOUT);
      if (layout && (host.key === "A" || host.key === "B")) inNetns(host.ns, layout, { allowFailure: false });
    }
  }

  async startPanel() {
    const logDirectory = path.join(this.dir, "panel-logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", PANEL_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(this.dir, "panel.db"), FORWARDX_LOG_DIR: logDirectory, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.panel = child;
    const stdoutPath = path.join(this.dir, "panel.stdout.log");
    let buffered = "";
    child.stdout!.on("data", (chunk) => { buffered += chunk.toString(); fs.appendFileSync(stdoutPath, chunk); });
    child.stderr!.on("data", (chunk) => fs.appendFileSync(stdoutPath, chunk));
    this.panelPort = await waitFor("面板启动", 120_000, async () => {
      if (child.exitCode !== null) throw new Error(`面板退出 code=${child.exitCode}\n${fs.readFileSync(stdoutPath, "utf8").slice(-4000)}`);
      const match = buffered.match(/PANEL_READY port=(\d+)/);
      return match ? Number(match[1]) : null;
    });
  }

  async ctl(route: string, body: unknown) {
    // 探测一轮要十几秒，node 的 fetch 会复用一条早被服务端按 keep-alive 超时关掉的连接（ECONNRESET）：
    // 每次都新开连接，并且失败重试一次。
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.panelPort}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", connection: "close" },
          body: JSON.stringify(body),
        });
        const json = await response.json() as any;
        if (response.status !== 200) throw new Error(`${route} 失败: ${JSON.stringify(json)}`);
        return json;
      } catch (error) {
        if (attempt >= 2 || (error instanceof Error && error.message.includes("失败:"))) throw error;
        await sleep(500);
      }
    }
  }

  sql(sql: string, params: unknown[] = []) {
    return this.ctl("/ctl/sql", { sql, params });
  }

  async query(sql: string, params: unknown[] = []): Promise<any[]> {
    return (await this.ctl("/ctl/sql", { sql, params, mode: "query" })).rows;
  }

  async call(router: "rules" | "tunnels", proc: string, input: unknown) {
    return (await this.ctl("/ctl/call", { router, proc, input })).result;
  }

  startEcho() {
    const child = spawn("ip", ["netns", "exec", this.hosts.X.ns, process.execPath, "-e", ECHO_SCRIPT, this.hosts.X.ip, String(ECHO_PORT)], { stdio: ["ignore", "pipe", "pipe"] });
    const out = path.join(this.dir, "echo.log");
    child.stdout!.on("data", (chunk) => fs.appendFileSync(out, chunk));
    child.stderr!.on("data", (chunk) => fs.appendFileSync(out, chunk));
    this.children.push(child);
  }

  startStickyUdpClient(ip: string, port: number, localPort: number, name: string) {
    const logFile = path.join(this.dir, `${name}.log`);
    const child = spawn("ip", ["netns", "exec", this.hosts.C.ns, process.execPath, "-e", STICKY_UDP_SCRIPT, ip, String(port), String(localPort), logFile], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
    this.children.push(child);
    return { logFile, child };
  }

  /** 粘性 UDP 客户端自某个时刻起收到了几个回包、发了几个包。 */
  stickyUdpStats(logFile: string, sinceIso: string) {
    if (!fs.existsSync(logFile)) return { sent: 0, replied: 0 };
    let sent = 0;
    let replied = 0;
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
      const [at, kind] = line.split(" ");
      if (!at || at < sinceIso) continue;
      if (kind === "send") sent += 1;
      if (kind === "reply") replied += 1;
    }
    return { sent, replied };
  }

  hostDir(host: HostSpec) {
    return path.join(this.dir, `host${host.key}`);
  }

  startAgent(host: HostSpec) {
    const dir = this.hostDir(host);
    for (const sub of ["varlib", "run", "etc/agent", "log"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, "etc/agent/config.json"), JSON.stringify({ panelUrl: `http://${SUBNET}.1:${this.panelPort}`, token: host.token, interval: 3 }));
    // 每台「机器」都有自己的状态目录：Agent 的路径写死在 /var/lib/forwardx-agent 等处，
    // 三个 Agent 同一个文件系统会互相踩，所以各自进一个 mount namespace 把这些目录 bind 成私有的。
    const script = [
      "mkdir -p /var/lib/forwardx-agent /run/forwardx-agent /etc/forwardx /var/log/forwardx-agent",
      `mount --bind ${dir}/varlib /var/lib/forwardx-agent`,
      `mount --bind ${dir}/run /run/forwardx-agent`,
      `mount --bind ${dir}/etc /etc/forwardx`,
      `mount --bind ${dir}/log /var/log/forwardx-agent`,
      `exec ${this.bin}/forwardx-agent -config /etc/forwardx/agent/config.json`,
    ].join(" && ");
    const child = spawn("ip", ["netns", "exec", host.ns, "unshare", "-m", "--propagation", "private", "sh", "-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${this.bin}:${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}` },
    });
    const out = path.join(dir, "agent.stdout.log");
    child.stdout!.on("data", (chunk) => fs.appendFileSync(out, chunk));
    child.stderr!.on("data", (chunk) => fs.appendFileSync(out, chunk));
    this.children.push(child);
  }

  agentLog(host: HostSpec) {
    const file = path.join(this.hostDir(host), "agent.stdout.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  panelLog(): Array<{ level: string; message: string; createdAt: string }> {
    const file = path.join(this.dir, "panel-logs", "panel.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }

  probe(proto: "tcp" | "udp", ip: string, port: number) {
    const result = spawnSync("ip", ["netns", "exec", this.hosts.C.ns, process.execPath, "-e", PROBE_SCRIPT, proto, ip, String(port)], { encoding: "utf8", timeout: 10_000 });
    return `${result.stdout || ""}${result.stderr || ""}`.trim() || `FAIL exit=${result.status} signal=${result.signal}`;
  }

  snapshot(host: HostSpec, label: string) {
    const text = [
      `# ${label} @ ${new Date().toISOString()}`,
      "## iptables -t nat -S", inNetns(host.ns, "iptables -t nat -S"),
      "## iptables -S FORWARD", inNetns(host.ns, "iptables -S FORWARD"),
      "## iptables -t mangle -S", inNetns(host.ns, "iptables -t mangle -S"),
      "## ss -lntup", inNetns(host.ns, "ss -lntup"),
      "## conntrack", inNetns(host.ns, `cat /proc/net/nf_conntrack 2>/dev/null | grep -F ${RULE_PORT} || true`),
      "## state files", inNetns(host.ns, `ls -la ${this.hostDir(host)}/varlib ${this.hostDir(host)}/run; for f in ${this.hostDir(host)}/varlib/port_* ${this.hostDir(host)}/varlib/target_*; do [ -f "$f" ] && { echo "$f:"; cat "$f"; echo; }; done; true`),
    ].join("\n");
    fs.appendFileSync(path.join(this.hostDir(host), "snapshots.log"), `${text}\n\n`);
    return text;
  }

  teardown() {
    for (const child of [...this.children, this.panel]) {
      if (child && child.exitCode === null) child.kill("SIGTERM");
    }
    for (const host of Object.values(this.hosts)) {
      const pids = sh(`ip netns pids ${host.ns} 2>/dev/null || true`, { allowFailure: true }).split(/\s+/).filter(Boolean);
      if (pids.length > 0) sh(`kill -9 ${pids.join(" ")} 2>/dev/null || true`, { allowFailure: true });
      sh(`ip netns del ${host.ns} 2>/dev/null || true`, { allowFailure: true });
    }
    sh(`ip link del ${this.bridge} 2>/dev/null || true`, { allowFailure: true });
    for (const child of [...this.children, this.panel]) {
      if (child && child.exitCode === null) child.kill("SIGKILL");
    }
    if (!process.env.FORWARDX_NETNS_E2E_OUT && process.env.FORWARDX_NETNS_E2E_KEEP !== "1") {
      fs.rmSync(this.dir, { recursive: true, force: true });
    }
  }
}

const missing = ENABLED ? capabilityMissing() : "未设置 FORWARDX_NETNS_E2E=1";

test("换隧道后旧入口桥接：真 Agent + 真 FXP + 真 iptables（netns）", { skip: missing ? `跳过：${missing}` : false, timeout: 15 * 60_000 }, async () => {
  const lab = new Lab();
  lab.log(`产物目录 ${lab.dir}`);
  try {
    lab.buildBinaries();
    lab.setupNetwork();
    await lab.startPanel();
    lab.log(`面板端口 ${lab.panelPort}`);

    await lab.sql("INSERT INTO users (id, username, password, role, canAddRules, manualCanAddRules, accountEnabled, allowProxySubscription, manualAllowProxySubscription, trafficUsed) VALUES (1, 'admin', 'hash', 'admin', 1, 1, 1, 1, 1, 0)");
    for (const host of [lab.hosts.A, lab.hosts.B, lab.hosts.X]) {
      await lab.sql('INSERT INTO agent_tokens (token, description, "isUsed", "sortOrder", "userId") VALUES (?, ?, 0, 0, 1)', [host.token, `host${host.key}`]);
    }
    await lab.sql(`INSERT OR REPLACE INTO system_settings (key, value, "updatedAt") VALUES ('ruleSwitchBridgeHours', '1', strftime('%s','now'))`);

    lab.startEcho();
    for (const host of [lab.hosts.A, lab.hosts.B, lab.hosts.X]) lab.startAgent(host);

    // 三台机器通过注册接口自己建主机行；netns 里没有公网，把入口地址改成 netns 里的地址。
    await waitFor("三台主机注册", 90_000, async () => {
      const rows = await lab.query('SELECT id, "agentToken" FROM hosts');
      return rows.length === 3 ? rows : null;
    });
    for (const host of [lab.hosts.A, lab.hosts.B, lab.hosts.X]) {
      const [row] = await lab.query('SELECT id FROM hosts WHERE "agentToken" = ?', [host.token]);
      lab.hostIds[host.key] = Number(row.id);
      await lab.sql('UPDATE hosts SET name = ?, ip = ?, ipv4 = ?, ipv6 = NULL WHERE id = ?', [`host${host.key}`, host.ip, host.ip, row.id]);
    }
    lab.log(`主机 id ${JSON.stringify(lab.hostIds)}`);

    const tunnelA = await lab.call("tunnels", "create", { name: "A", entryHostId: lab.hostIds.A, exitHostId: lab.hostIds.X, mode: "forwardx", listenPort: 46795 });
    const tunnelB = await lab.call("tunnels", "create", { name: "B", entryHostId: lab.hostIds.B, exitHostId: lab.hostIds.X, mode: "forwardx", listenPort: 46796 });
    const tunnelAId = Number(tunnelA?.id || (await lab.query("SELECT id FROM tunnels WHERE name = 'A'"))[0].id);
    const tunnelBId = Number(tunnelB?.id || (await lab.query("SELECT id FROM tunnels WHERE name = 'B'"))[0].id);
    lab.log(`隧道 A=${tunnelAId} B=${tunnelBId}`);

    const created = await lab.call("rules", "create", {
      hostId: lab.hostIds.B, name: "echo", forwardType: "gost", protocol: "both", gostMode: "direct", tunnelId: tunnelBId,
      sourcePort: RULE_PORT, targetIp: lab.hosts.X.ip, targetPort: ECHO_PORT,
    });
    const ruleId = Number(created?.id || (await lab.query("SELECT id FROM forward_rules WHERE name = 'echo'"))[0].id);
    lab.log(`规则 id ${ruleId}`);

    const before = await waitFor("规则在 hostB 上通", 120_000, async () => {
      const tcp = lab.probe("tcp", lab.hosts.B.ip, RULE_PORT);
      const udp = lab.probe("udp", lab.hosts.B.ip, RULE_PORT);
      lab.log(`hostB:${RULE_PORT} 换之前 tcp=${tcp} udp=${udp}`);
      return tcp === "OK" && udp === "OK" ? { tcp, udp } : null;
    });
    assert.deepEqual(before, { tcp: "OK", udp: "OK" });
    lab.snapshot(lab.hosts.B, "before switch");

    // ---- 换隧道：B → A，再 A → B（规则回到还留着桥接的机器），再 B → A ----
    // 生产环境里用户就是这么来回切的（桥接编号 …05、…06），第二次起旧入口上既有桥接的 DNAT 又要起规则本身。
    const switchTo = (tunnelId: number, fromHostId: number) => lab.call("rules", "update", {
      id: ruleId, hostId: fromHostId, name: "echo", forwardType: "gost", protocol: "both", gostMode: "direct", gostRelayHost: null, gostRelayPort: null,
      tunnelId, forwardGroupId: null, sourcePort: RULE_PORT, isEnabled: true, targetIp: lab.hosts.X.ip, targetPort: ECHO_PORT,
      telegramErrorNotifyEnabled: false, failoverEnabled: false, routeGroup: null,
    });
    const bridgeRows = () => lab.query('SELECT id, "ruleId", "hostId", "sourcePort", protocol, "isRunning", "runtimeTarget", "expiresAt" FROM forward_rule_entry_bridges ORDER BY id');
    const steps: Array<{ label: string; tunnelId: number; from: HostSpec; to: HostSpec }> = [
      { label: "1: B → A", tunnelId: tunnelAId, from: lab.hosts.B, to: lab.hosts.A },
      { label: "2: A → B（规则回到还留着桥接的 hostB）", tunnelId: tunnelBId, from: lab.hosts.A, to: lab.hosts.B },
      { label: "3: B → A", tunnelId: tunnelAId, from: lab.hosts.B, to: lab.hosts.A },
      // 再来一个来回：两台机器各自都经历过「有桥接 → 规则回来 → 又留桥接 → 规则又回来」。
      { label: "4: A → B", tunnelId: tunnelBId, from: lab.hosts.A, to: lab.hosts.B },
      { label: "5: B → A", tunnelId: tunnelAId, from: lab.hosts.B, to: lab.hosts.A },
    ];
    const failures: string[] = [];
    // 换之前就有客户端在用同一个 UDP 源端口连着旧入口（hy2 / tuic 这类）：换隧道后它不刷新订阅，还往旧入口发。
    const sticky = lab.startStickyUdpClient(lab.hosts.B.ip, RULE_PORT, 51000, "sticky-udp-hostB");
    await waitFor("粘性 UDP 客户端换之前有回包", 30_000, async () => lab.stickyUdpStats(sticky.logFile, "").replied > 2 ? true : null);
    for (const step of steps) {
      lab.log(`==== 切换 ${step.label}`);
      lab.snapshot(step.from, `${step.label} before`);
      lab.snapshot(step.to, `${step.label} before`);
      const update = await switchTo(step.tunnelId, lab.hostIds[step.from.key]);
      lab.log(`rules.update => ${JSON.stringify(update)}`);
      const bridges = await bridgeRows();
      lab.log(`桥接行 ${JSON.stringify(bridges)}`);
      const bridgeOnFrom = bridges.filter((row) => Number(row.hostId) === lab.hostIds[step.from.key]);
      assert.equal(bridgeOnFrom.length, 1, `${step.label}: 旧入口 host${step.from.key} 应留下一条桥接`);
      assert.equal(bridges.some((row) => Number(row.hostId) === lab.hostIds[step.to.key]), false, `${step.label}: 规则回到的机器上不该再有桥接`);

      // 新入口：规则本身必须通。
      let newEntry: { tcp: string; udp: string } | null = null;
      let oldEntry: { tcp: string; udp: string } | null = null;
      const deadline = Date.now() + 90_000;
      let round = 0;
      while (Date.now() < deadline) {
        round += 1;
        const to = { tcp: lab.probe("tcp", step.to.ip, RULE_PORT), udp: lab.probe("udp", step.to.ip, RULE_PORT) };
        const from = { tcp: lab.probe("tcp", step.from.ip, RULE_PORT), udp: lab.probe("udp", step.from.ip, RULE_PORT) };
        const rows = await bridgeRows();
        lab.log(`${step.label} round=${round} 新入口 host${step.to.key}=${JSON.stringify(to)} 旧入口 host${step.from.key}(桥接)=${JSON.stringify(from)} bridges=${JSON.stringify(rows.map((row) => ({ id: row.id, host: row.hostId, running: row.isRunning, target: row.runtimeTarget })))}`);
        lab.snapshot(step.from, `${step.label} round ${round} old-entry ${JSON.stringify(from)}`);
        lab.snapshot(step.to, `${step.label} round ${round} new-entry ${JSON.stringify(to)}`);
        if (to.tcp === "OK" && to.udp === "OK") newEntry = to;
        if (from.tcp === "OK" && from.udp === "OK") oldEntry = from;
        if (newEntry && oldEntry) break;
        await sleep(3000);
      }
      if (!newEntry) failures.push(`${step.label}: 新入口 host${step.to.key}:${RULE_PORT} 不通`);
      if (!oldEntry) failures.push(`${step.label}: 旧入口桥接 host${step.from.key}:${RULE_PORT} 不通`);
      lab.log(`${step.label} 结果 新入口=${JSON.stringify(newEntry)} 旧入口桥接=${JSON.stringify(oldEntry)}`);
      // 粘性 UDP 客户端：最近 10 秒发的包，到底有没有回。
      await sleep(10_000);
      const since = new Date(Date.now() - 10_000).toISOString();
      const stats = lab.stickyUdpStats(sticky.logFile, since);
      lab.log(`${step.label} 粘性 UDP 客户端(→hostB:${RULE_PORT} 源端口 51000) 最近 10s sent=${stats.sent} replied=${stats.replied}`);
      lab.snapshot(lab.hosts.B, `${step.label} sticky-udp sent=${stats.sent} replied=${stats.replied}`);
      if (stats.sent > 0 && stats.replied === 0) failures.push(`${step.label}: 换之前就连着旧入口 hostB 的 UDP 客户端（固定源端口）换后一个回包都收不到 sent=${stats.sent}`);
    }
    const panelLines = lab.panelLog().map((row) => `${row.createdAt} ${row.level} ${row.message}`).filter((line) => /EntryBridge|AgentReconcile|AgentRecovery|\[Rule\] status|AgentStatus|Tunnel\] status/.test(line));
    fs.writeFileSync(path.join(lab.dir, "panel-filtered.log"), panelLines.join("\n"));
    assert.deepEqual(failures, [], `换隧道后有入口不通：\n${failures.join("\n")}\n\n面板日志：\n${panelLines.slice(-60).join("\n")}\n\nhostA 快照：\n${lab.snapshot(lab.hosts.A, "final")}\n\nhostB 快照：\n${lab.snapshot(lab.hosts.B, "final")}`);
  } finally {
    lab.log("收尾");
    lab.teardown();
  }
});

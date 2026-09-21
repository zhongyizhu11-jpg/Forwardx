import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * 提醒扫描：六条路一条都不能少，而打库次数不许跟着面板规模涨。
 *
 * 面板里有六路提醒 —— 用户到期、用户流量、主机流量、主机续费、落地节点流量、
 * 落地端口流量 —— 邮件和 Telegram 各走一遍。每一条发之前都要先确认「今天发过没有」，
 * 靠的是往 system_settings 里写一行当天的日标记。
 *
 * 原来这个确认是**一个对象问一次库**：单行主键查，便宜，但是一千个用户加一千台
 * 机器加一千个节点，一轮扫下来两个渠道合计上万次往返，而这一轮每六小时跑一次、
 * 天天跑。实测（用户/主机/节点/端口数都等于 N）：
 *
 *     规模     邮件      Telegram
 *       4     31 次      30 次
 *      16    103 次     102 次
 *
 * 也就是每多一个对象就多 6 次往返，两个渠道一共 12 次。这些键全是同一天的同一类
 * 标记，一次 IN 就能问完 —— 改完之后两个渠道都变成常数（8 次和 7 次），与规模无关。
 *
 * 这一组盯两件事，缺一不可：
 *
 *   · **成本**：两个规模下第二轮的打库次数必须一样。只要还有「每个对象一次」的
 *     残留，这条就会红。
 *   · **清单**：六条路的去重键一个不少、一个不多，而且提醒真的发得出去。光盯成本
 *     的话，把某一路删掉是「优化」得最彻底的做法 —— 那正是这条要拦住的。
 */

type Probe = {
  markers: string[];
  mails: Array<{ to: string; subject: string }>;
  telegrams: Array<{ chatId: string; head: string }>;
  secondMails: number;
  secondTelegrams: number;
  secondQueries: number;
  stoppedAt: number;
  today: string;
  errors: string[];
};

function runProbe(scale: number): Probe {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-reminder-cost-"));
  const databasePath = path.join(directory, "reminder.db");
  const script = String.raw`
    import net from "node:net";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const Database = (await import("better-sqlite3")).default;
    const originalPrepare = Database.prototype.prepare;
    let recording = false;
    let queries = 0;
    Database.prototype.prepare = function (sql) {
      if (recording) queries += 1;
      return originalPrepare.call(this, sql);
    };

    // Telegram 那一路真会去连 api.telegram.org。测试不该依赖外网，也不该把
    // 「网络不通」报成「提醒没发出去」，所以在这里截住。
    const telegrams = [];
    globalThis.fetch = async (target, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      telegrams.push({ chatId: String(body.chat_id), head: String(body.text || "").split("\n")[0] });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };

    // 一个只会说「收到」的 SMTP：验证邮件真的发得出去，而不是靠「没报错」推断。
    const mails = [];
    const smtp = net.createServer((socket) => {
      let buffer = "";
      let inData = false;
      let recipient = "";
      let subject = "";
      socket.write("220 localhost ESMTP\r\n");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              mails.push({ to: recipient, subject });
              subject = "";
              socket.write("250 OK\r\n");
            } else if (/^Subject:/i.test(line)) {
              subject = line.slice(line.indexOf(":") + 1).trim();
            }
            continue;
          }
          const command = line.toUpperCase();
          if (command.startsWith("EHLO") || command.startsWith("HELO")) {
            socket.write("250-localhost\r\n250 8BITMIME\r\n");
          } else if (command.startsWith("RCPT")) {
            recipient = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">"));
            socket.write("250 OK\r\n");
          } else if (command.startsWith("DATA")) {
            inData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (command.startsWith("QUIT")) {
            socket.write("221 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });
    });
    await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    const smtpPort = smtp.address().port;

    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")); };

    const url = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(url("server/dbRuntime.ts"));
    const schema = await import(url("server/dbSchema.ts"));
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();
    const exec = (sql, params = []) => runtime.executeRaw(sql, params);

    const N = Number(process.env.SCALE);
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    // 差 47 小时到期 → daysLeft 恒为 2，落在提醒天数里，而且几个钟头内不会翻页。
    const stoppedAt = Math.floor((nowMs + 47 * 3600 * 1000) / 1000);
    const today = new Date().toISOString().slice(0, 10);
    const GB = 1024 ** 3;

    const settings = {
      emailEnabled: "true", emailHost: "127.0.0.1", emailFrom: "panel@example.com",
      emailPort: String(smtpPort), emailSecurity: "none",
      emailExpiryReminder: "true", emailTrafficReminder: "true", emailTrafficReminderThreshold: "20",
      expiryReminderDays: "1,2,3,7",
      telegramBotEnabled: "true", telegramBotToken: "1:token",
      telegramExpiryReminder: "true", telegramTrafficReminder: "true", telegramTrafficReminderThreshold: "20",
    };
    for (const [key, value] of Object.entries(settings)) {
      await exec("INSERT INTO system_settings (key, value, updatedAt) VALUES (?, ?, ?)", [key, value, now]);
    }

    await exec("INSERT INTO users (id, username, password, role) VALUES (1, 'admin', 'h', 'admin')");
    for (let i = 0; i < N; i++) {
      const id = 2 + i;
      await exec(
        'INSERT INTO users (id, username, password, role, email, "telegramId", "expiresAt", "trafficLimit", "trafficUsed") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, "u" + id, "h", "user", "u" + id + "@example.com", "tg" + id, stoppedAt, 100 * GB, 95 * GB],
      );
    }
    for (let i = 1; i <= N; i++) {
      const owner = 2 + ((i - 1) % N);
      await exec(
        'INSERT INTO hosts (id, name, ip, ipv4, "hostType", "agentToken", "userId", "isOnline", "lastHeartbeat", "trafficLimit", "trafficAlertThresholdPercent", "telegramTrafficAlertEnabled", "telegramRenewalReminderEnabled", "renewalReminderDays", "stoppedAt", "expiryHandling") VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 20, 1, 1, 3, ?, ?)',
        [i, "机" + i, "10.9.0." + i, "10.9.0." + i, "slave", "tk" + i, owner, now, 100 * GB, stoppedAt, "keep"],
      );
      await exec(
        'INSERT INTO host_traffic_counters (id, "hostId", "bytesIn", "bytesOut", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        [i, i, 48 * GB, 48 * GB, now, now],
      );
      await exec(
        'INSERT INTO proxy_nodes (id, "userId", name, protocol, address, port, "trafficLimit", "trafficUsed", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [i, owner, "节点" + i, "vless", "10.9.1." + i, 443, 100 * GB, 99 * GB, now, now],
      );
      await exec(
        'INSERT INTO proxy_inbounds (id, "userId", "hostId", name, protocol, port, "trafficLimit", "trafficUsed", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [i, owner, i, "端口" + i, "vless", 20000 + i, 100 * GB, 99 * GB, now, now],
      );
    }

    const sched = await import(url("server/scheduler.ts"));
    await sched.runEmailReminders();
    await sched.runTelegramReminders();
    const firstMails = mails.length;
    const firstTelegrams = telegrams.length;

    // 第二轮：同一天，什么都不该再发，而这一轮的打库次数才是长期成本。
    recording = true;
    await sched.runEmailReminders();
    await sched.runTelegramReminders();
    recording = false;

    const markerRows = originalPrepare
      .call(new Database(process.env.FORWARDX_TEST_DB, { readonly: true }),
        "SELECT key FROM system_settings WHERE key LIKE 'emailReminder:%' OR key LIKE 'telegramReminder:%'")
      .all();

    smtp.close();
    console.error = originalError;
    console.log("REMINDERPROBE " + JSON.stringify({
      markers: markerRows.map((row) => String(row.key)).sort(),
      mails: mails.slice(0, firstMails),
      telegrams: telegrams.slice(0, firstTelegrams),
      secondMails: mails.length - firstMails,
      secondTelegrams: telegrams.length - firstTelegrams,
      secondQueries: queries,
      stoppedAt,
      today,
      errors,
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath, SCALE: String(scale) },
    timeout: 180000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split("\n").find((row) => row.startsWith("REMINDERPROBE "));
  assert.ok(line, `没拿到探测结果：\n${result.stdout}`);
  return JSON.parse(line.slice("REMINDERPROBE ".length)) as Probe;
}

const one = runProbe(1);
const many = runProbe(16);

test("六条提醒都发得出去，去重键一条不少一条不多", () => {
  assert.deepEqual(one.errors, [], "扫描过程中不该有任何错误");

  const expected = [
    `emailReminder:expiry:2:2:${one.today}`,
    `emailReminder:hostRenewal:1:${one.stoppedAt}:2:2:${one.today}`,
    `emailReminder:hostTraffic:1:2:${one.today}`,
    `emailReminder:proxyInboundTraffic:1:warn:2:${one.today}`,
    `emailReminder:proxyNodeTraffic:1:warn:2:${one.today}`,
    `emailReminder:traffic:2:${one.today}`,
  ];
  assert.deepEqual(
    one.markers,
    [...expected, ...expected.map((key) => key.replace("emailReminder:", "telegramReminder:"))].sort(),
    "六条路 × 两个渠道 = 12 个日标记。少了哪一个，就是那一路的人从此收不到提醒；"
      + "键变了则是当天再收一遍已经发过的。",
  );

  assert.equal(one.mails.length, 6, `应当发出 6 封邮件，实际 ${JSON.stringify(one.mails)}`);
  assert.equal(one.telegrams.length, 6, `应当发出 6 条 Telegram，实际 ${JSON.stringify(one.telegrams)}`);
  assert.ok(one.mails.every((mail) => mail.to === "u2@example.com"), "收件人必须是这些资源的主人");
  assert.ok(one.telegrams.every((item) => item.chatId === "tg2"), "Telegram 也发给同一个人");
});

test("同一天再扫一轮，一条都不重发", () => {
  for (const probe of [one, many]) {
    assert.equal(probe.secondMails, 0, "当天发过的提醒不该再发一遍 —— 那是骚扰，不是提醒");
    assert.equal(probe.secondTelegrams, 0, "Telegram 同理");
  }
});

test("稳态打库次数是个常数，不跟着面板规模涨", () => {
  /*
    这条是棘轮。规模从 1 涨到 16，第二轮的打库次数必须**一模一样** —— 只要还有
    一处「每个对象问一次库」，16 倍规模就会把它顶出来。

    留余量在这里毫无意义：常数就是常数。写成「不超过多少倍」的话，「每个对象多
    一次查询」这种退化会被余量整个吸收掉，棘轮就不响了。
  */
  assert.equal(
    many.secondQueries,
    one.secondQueries,
    `规模 1 时第二轮打了 ${one.secondQueries} 次库，规模 16 时打了 ${many.secondQueries} 次 —— `
      + "提醒扫描里又出现了按对象数放大的查询。这一轮每六小时跑一次，"
      + "一千个用户就是每天几万次白跑的往返。",
  );
});

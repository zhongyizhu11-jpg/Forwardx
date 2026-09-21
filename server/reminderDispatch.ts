/**
 * 提醒的「先算清单、再一起发」。
 *
 * 面板里有六路提醒（用户到期、用户流量、主机流量、主机续费、落地节点、落地端口），
 * 两个渠道（邮件、Telegram）各走一遍。原来每一路都是边算边发，每要发一条就先
 * `getSetting(当天的日标记)` 问一次「今天发过没有」—— 单行主键查，但是一个对象一次。
 *
 * 一千个用户加一千台机器加一千个节点，一轮扫下来就是上万次往返，而这一轮每六小时
 * 跑一次、天天跑。这些键全是同一天的同一类标记，一次 IN 就能问完。
 *
 * 所以把每一路拆成两段：先纯计算出「今天该发哪些、各自的去重键是什么」，再把整批
 * 键一次问清，最后只发没发过的。消息正文留在各自的 send 闭包里 —— 邮件和 Telegram
 * 的正文本来就不一样，硬凑成一个模板只会让两边互相迁就。
 *
 * 发送失败仍然向上抛：和原来一样，SMTP 挂了就整轮停下，而不是对着一千个地址挨个
 * 超时重试一遍。
 */

import * as db from "./db";

export type PendingReminder = {
  /** 当天的去重键，`<渠道>:<类别>:<...>:<YYYY-MM-DD>`。 */
  key: string;
  send: () => Promise<void>;
};

/**
 * 发掉清单里今天还没发过的那些，返回真发出去的条数。
 *
 * 同一轮里两条算出同一个键是可能的（比如同一个人的同一类提醒被算了两遍），
 * 发过的键就地记下，免得一轮里重复发。
 */
export async function dispatchReminders(pending: PendingReminder[]): Promise<number> {
  if (pending.length === 0) return 0;
  const sent = await db.getSentSettingKeys(pending.map((item) => item.key));
  let delivered = 0;
  for (const item of pending) {
    if (sent.has(item.key)) continue;
    await item.send();
    await db.setSetting(item.key, "sent");
    sent.add(item.key);
    delivered += 1;
  }
  return delivered;
}

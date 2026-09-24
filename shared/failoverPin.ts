import { timestampMillis } from "./timestamp";

/**
 * 人工钉住：怎么从一行数据里读出「现在钉着哪条」。全站唯一一份。
 *
 * 原来有三份各自的读法 —— 心跳下发一份、保存时归一化一份、编辑框加载一份 —— 三份
 * 都是先 `Number(failoverPinnedIndex)` 再判断是不是整数。而这一列没钉的时候是
 * null，**`Number(null)` 是 0，0 是一个合法的出站序号（主线路）**。于是：
 *
 *   · 没钉过的规则，心跳下发给 Agent 的是「钉在主线路、一直钉着」；
 *   · 新建主备规则时前端传 null（意思是「自动」），库里存成 0；
 *   · 编辑框打开任何一条主备规则，都显示「强制走 主线路 · 一直钉着」。
 *
 * 钉住压过时段表和自动择优，所以这三处加起来的结果是：时段表和自动择优从上线起
 * 就没有在任何一台机器上生效过，而面板上时段表明明白白写着「工作日 18:00 → 备用 1」。
 * Agent 那边专门为这件事把字段做成了指针（见 agent/main.go 的 PinnedIndex 注释），
 * 面板这边又把它亲手填成了 0。
 *
 * 所以这里的第一条规矩：**null / undefined / 空串就是没钉，判断要在 Number() 之前。**
 *
 * 第二条：**过期了就是没钉**，不是「一直钉着」。上一版保存时把一个已经过去的期限
 * 当成「没填期限」，于是一个早就自动交回的钉子，在下一次编辑这条规则（哪怕只是改个
 * 名字）时复活成永久的。
 */

export type FailoverPin = {
  /** 钉在第几条出站：0 是主线路，1.. 是第几条备用线路 */
  index: number;
  /** 钉到什么时候（毫秒）；null 表示一直钉着 */
  untilMs: number | null;
};

function isBlank(value: unknown) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

export function readFailoverPin(
  source: { failoverPinnedIndex?: unknown; failoverPinnedUntil?: unknown } | null | undefined,
  options: {
    nowMs?: number;
    /** 出站总条数（主线路 + 备用线路）。给了就把越界的当成没钉 */
    lineCount?: number;
  } = {},
): FailoverPin | null {
  const rawIndex = source?.failoverPinnedIndex;
  if (isBlank(rawIndex)) return null;
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  // 指向不存在的出站一律当成没钉：宁可交回自动，也不能让一条规则因为一个坏值走不通。
  if (options.lineCount !== undefined && index >= options.lineCount) return null;

  const rawUntil = source?.failoverPinnedUntil;
  // 没有期限 = 一直钉着。0 是 Agent 协议里「一直钉着」的写法，一并认。
  if (isBlank(rawUntil) || rawUntil === 0) return { index, untilMs: null };
  const untilMs = timestampMillis(rawUntil);
  // 期限写坏了（认不出来的字符串之类）：宁可交回自动，也不当成「一直钉着」 ——
  // 后者会让时段表和自动择优静默失效，前者最多是少钉一会儿。
  if (!(untilMs > 0)) return null;
  if (untilMs <= (options.nowMs ?? Date.now())) return null;
  return { index, untilMs };
}

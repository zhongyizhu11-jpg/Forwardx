/**
 * 当前环境下复制是否走的是「老办法」，也就是随时可能被浏览器拒绝的那条路。
 *
 * navigator.clipboard 只在安全上下文（HTTPS 或 localhost）下存在，而面板经常
 * 是 http://IP:端口 直接访问的。这时只能退到 document.execCommand("copy")：
 * 实测 Chromium 下它在 http 上照样成功，但各家实现差别很大，iOS 尤其挑剔。
 *
 * 所以这个函数的含义是「没把握」，不是「一定失败」—— 调用方据此准备好退路
 * （把内容摆出来让人自己选），而不是提前认输。
 */
export function clipboardNeedsManualCopy(): boolean {
  if (typeof window === "undefined") return false;
  return !window.isSecureContext;
}

/**
 * 把一段文字塞进选区再交给 execCommand。
 *
 * 用 contenteditable 的 div 而不是 textarea：Range.selectNodeContents 选的是
 * 子节点，而 textarea 的内容在 value 里、没有子节点 —— 这么选出来的选区是空的。
 * （上一版就栽在这儿：Chromium 照样返回 true，其实复制了个空；iOS 直接 false。）
 *
 * contenteditable 是 iOS 的硬要求：不可编辑的元素上 execCommand("copy") 不认。
 */
function selectAndCopy(host: HTMLElement, text: string): boolean {
  const holder = document.createElement("div");
  try {
    // 必须是真实文本节点，Range 才选得中。
    holder.textContent = text;
    holder.contentEditable = "true";
    holder.setAttribute("aria-hidden", "true");

    /**
     * 藏起来但必须真的参与渲染：display:none / visibility:hidden 的元素选不中。
     * 这里靠 1px + 透明字色，不用 opacity:0，也不设负 z-index —— 那两样在 iOS
     * 上都可能让选中失败。font-size 给 16px 是另一条 iOS 规矩：小于 16px 的可
     * 编辑元素获得焦点时 Safari 会把整页放大，用户会看到页面猛地一跳。
     */
    holder.style.position = "fixed";
    holder.style.left = "0";
    holder.style.top = "0";
    holder.style.width = "1px";
    holder.style.height = "1px";
    holder.style.padding = "0";
    holder.style.border = "none";
    holder.style.outline = "none";
    holder.style.overflow = "hidden";
    holder.style.background = "transparent";
    holder.style.color = "transparent";
    holder.style.fontSize = "16px";
    // 链接里没有空格，但别让浏览器把内容折叠掉。
    holder.style.whiteSpace = "pre";

    host.appendChild(holder);
    return selectNodeAndCopy(holder);
  } catch (error) {
    console.warn("[Clipboard] execCommand fallback failed:", error);
    return false;
  } finally {
    holder.remove();
  }
}

/** 选中某个元素里的文字并复制。选区留着不清 —— 复制失败时正好可以直接长按。 */
function selectNodeAndCopy(element: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand("copy");
}

/**
 * 复制屏幕上某个元素里的文字。
 *
 * 这是最稳的一条路：选的是用户眼前那段真文字，等同于他自己长按选中再复制，
 * 不依赖任何隐藏元素的技巧。调用方手上有那个元素时优先用它。
 */
export async function copyTextFromElement(element: HTMLElement | null, text: string): Promise<boolean> {
  if (!element) return copyTextToClipboard(text);

  if (typeof navigator !== "undefined" && typeof window !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn("[Clipboard] navigator.clipboard failed, falling back to selection:", error);
    }
  }

  try {
    return selectNodeAndCopy(element);
  } catch (error) {
    console.warn("[Clipboard] selection copy failed:", error);
    return false;
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (typeof navigator !== "undefined" && typeof window !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn("[Clipboard] navigator.clipboard failed, falling back:", error);
    }
  }

  if (typeof document === "undefined") return false;

  // 弹窗里有焦点陷阱，临时元素挂在弹窗内才不会被它抢回焦点。
  const host = (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) || document.body;
  if (!host) return false;
  return selectAndCopy(host, text);
}

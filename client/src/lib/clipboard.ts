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
 * iOS 上所有浏览器都是 WebKit，包括 Chrome 和 Edge —— 所以按引擎判断，
 * 不按浏览器名。iPadOS 会把自己报成 MacIntel，靠触点数量补一刀。
 */
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
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

  const host = (document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null) || document.body;
  if (!host) return false;

  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;

    /**
     * 这个临时元素必须是「看不见但真的被渲染」的。
     *
     * 原来用 opacity:0 + pointer-events:none + z-index:-1 把它藏起来 —— 桌面端
     * 没事，iOS 上选中会失败，execCommand 跟着返回 false。所以改成 1px 的透明
     * 方块，不动 z-index。font-size 给 16px 是另一条 iOS 的规矩：小于 16px 的
     * 输入框获得焦点时 Safari 会把整页放大，用户会看到页面猛地一跳。
     */
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "0";
    textarea.style.top = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.padding = "0";
    textarea.style.border = "none";
    textarea.style.outline = "none";
    textarea.style.boxShadow = "none";
    textarea.style.background = "transparent";
    textarea.style.color = "transparent";
    textarea.style.fontSize = "16px";

    host.appendChild(textarea);

    if (isIOS()) {
      /**
       * iOS 不认 readonly textarea 上的 select()：选区是空的，execCommand 直接
       * 返回 false。这是 iOS 上「复制按钮没反应」最常见的原因，跟是不是 https
       * 无关。要让它选中，元素得可编辑，而且要用 Range 选内容而不是 select()。
       */
      textarea.contentEditable = "true";
      textarea.readOnly = false;
      const range = document.createRange();
      range.selectNodeContents(textarea);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      textarea.setSelectionRange(0, text.length);
    } else {
      textarea.setAttribute("readonly", "");
      textarea.select();
      textarea.setSelectionRange(0, text.length);
    }

    return document.execCommand("copy");
  } catch (error) {
    console.warn("[Clipboard] execCommand fallback failed:", error);
    return false;
  } finally {
    textarea.remove();
  }
}

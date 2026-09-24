import { useEffect, useState } from "react";
import { mobileAuth } from "@/lib/mobileAuth";

const MOBILE_BREAKPOINT = 768;

/*
  首次渲染就用真实宽度。原来初始值固定 false，手机上每个用到它的页面挂载时都先按
  桌面版渲染一遍、effect 里再改成手机版重来一遍。规则页要是记住的是列表视图，
  白算的那一遍就是整张 1700px 宽的表格外加一份藏起来的卡片。
*/
function initialIsMobile() {
  if (mobileAuth.isNative) return true;
  return typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState<boolean>(initialIsMobile);

  useEffect(() => {
    if (mobileAuth.isNative) {
      setIsMobile(true);
      return;
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

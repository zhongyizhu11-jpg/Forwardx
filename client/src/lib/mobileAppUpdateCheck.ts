import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { checkMobileAppUpdate, type MobileAppUpdateResult } from "@/lib/mobileNotifications";
import { mobileAuth } from "@/lib/mobileAuth";

/**
 * 「检查 APP 更新」这件事，两处入口共用一份逻辑。
 *
 * 侧边栏的账户菜单和个人资料页各有一个「检查 APP 更新」按钮，两边原来各写了
 * 一份 handleMobileUpdateCheck：同样的在途判断、同样的状态、同样的两句
 * 「已是最新版本 / 暂无更新」、同样的失败提示 —— 逐字一样。改其中一句，
 * 另一处就悄悄留在旧文案上。
 *
 * **发现新版本之后怎么呈现，两边是故意不同的，不要一起收进来：**
 *
 *   · 侧边栏是个弹层，塞不下版本对比，所以弹一个带「前往下载」的对话框；
 *   · 个人资料页是整页，检查完在卡片里常驻显示「当前版本 / 最新版本」，
 *     再给一个「前往下载」按钮，不打断用户。
 *
 * 所以这里只管「查」和「没更新/出错怎么说」，查到了交给调用方自己呈现。
 */
export function useMobileAppUpdateCheck(onUpdateFound: (result: MobileAppUpdateResult) => void) {
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<MobileAppUpdateResult | null>(null);
  // 回调每次渲染都是新的，用 ref 接住，免得 check 的身份跟着变。
  const onUpdateFoundRef = useRef(onUpdateFound);
  onUpdateFoundRef.current = onUpdateFound;

  // 在途判断走 ref 而不是 state：state 读的是这一帧的闭包，连点两下有可能
  // 都读到 false；而把判断塞进 setState 的更新函数里又是在更新函数里做副作用，
  // StrictMode 下会跑两遍。
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (!mobileAuth.isNative || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const result = await checkMobileAppUpdate({ silent: false });
      setUpdateInfo(result);
      if (result?.hasUpdate) {
        onUpdateFoundRef.current(result);
      } else if (result) {
        toast.success(result.hasPackage ? "当前 APP 已是最新版本" : `当前版本暂无 ${result.packageLabel} 更新`);
      }
    } catch (error: any) {
      toast.error(error?.message || "APP 更新检查失败");
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, []);

  return { checking, updateInfo, check };
}

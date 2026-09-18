import { useEffect } from "react";
import { Redirect, useLocation } from "wouter";

/**
 * 老的 /email-settings 地址：跳到系统设置的「邮箱设置」tab。
 *
 * 邮箱设置的界面本来就是 EmailSettings.tsx 导出的 EmailSettingsContent，系统设置
 * 那一页把它当成一个 tab 渲染。这个独立地址侧边栏里没有入口，全站也没有一处链接
 * 过去，落在那儿切不到兄弟 tab。留着只为老书签不吃 404。
 */
export default function RedirectPage() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/settings?tab=email", { replace: true });
  }, [navigate]);
  return <Redirect to="/settings?tab=email" replace />;
}

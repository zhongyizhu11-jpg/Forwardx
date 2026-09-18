import { useEffect } from "react";
import { Redirect, useLocation } from "wouter";

/**
 * 老的 /forward-groups 地址：跳到链路管理的「转发组」tab。
 *
 * 转发组的界面本来就是 ForwardGroups.tsx 导出的 ForwardGroupsContent，链路管理
 * 那一页把它当成一个 tab 渲染 —— 隧道、端口转发、转发链、转发组、入口组、出口组
 * 本来就是同一件事的六种形态，摆在一起才比得出来该用哪种。
 *
 * 这个独立地址侧边栏里没有入口，全站也没有一处链接过去，落在那儿只能看到光秃秃
 * 一块、切不到兄弟 tab。留着只为存过书签的人不吃 404，并且把他带到有上下文的地方。
 */
export default function RedirectPage() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/tunnels?tab=groups", { replace: true });
  }, [navigate]);
  return <Redirect to="/tunnels?tab=groups" replace />;
}

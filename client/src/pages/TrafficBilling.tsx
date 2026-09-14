import { useEffect } from "react";
import { Redirect, useLocation } from "wouter";

/**
 * 老的 /traffic-billing 地址：跳到套餐管理的「流量计费」tab。
 *
 * 按量计费和套餐计费是同一件事的两种卖法，合到一页去了。这一页留着只为两件事：
 * 存过书签的人不吃 404，以及历史文案里提到过的那条路还走得通。
 */
export default function TrafficBilling() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate("/plans?tab=billing", { replace: true });
  }, [navigate]);
  return <Redirect to="/plans?tab=billing" replace />;
}

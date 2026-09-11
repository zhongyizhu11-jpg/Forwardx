import { Redirect } from "wouter";

/**
 * 「落地节点」这一页已经并进「订阅管理」，成了那一页里的「新建节点」区块 ——
 * 自建节点、粘进来的落地节点、订阅内容、订阅令牌本来就是一件事的四个环节，
 * 分成两页要来回跳。
 *
 * 这里留一个重定向而不是直接删掉路由：老书签和侧边栏缓存还会指到 /proxy-inbounds，
 * 删掉的话它们会撞上 404，而用户看不出该去哪。
 */
export default function ProxyInbounds() {
  return <Redirect to="/client-subscriptions" />;
}

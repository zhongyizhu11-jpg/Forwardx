import type { ReactNode } from "react";
import { Activity, Copy, Pencil, RefreshCcw, Stethoscope, Trash2 } from "lucide-react";

import { HealthBadge, StatusDot } from "@/components/network/StatusDot";
import { PathBranch, PathMetric, NetworkPath, PathPreview } from "@/components/ConnectionPath";
import {
  EntityBody,
  EntityCard,
  EntityDivider,
  EntityFooter,
  EntityHeader,
  EntityTag,
} from "@/components/entity/EntityCard";
import { EntityActions } from "@/components/entity/EntityActions";
import { Metric, MetricGroup, ResourceMeter } from "@/components/entity/Metric";
import { Switch } from "@/components/ui/switch";

/**
 * ForwardX 视觉语言画廊 —— Storybook-lite。
 *
 * 上一版的预览页展示的是**通用组件**（按钮、输入框、表格），但界面出问题的
 * 地方从来不是按钮，是**业务实体在各种状态下长什么样**：一台离线的主机、一条
 * 降级的链路、一组正在切换的线路。这些状态在真实面板里难得凑齐，所以每次改动
 * 都只能靠「我记得它应该是这样」。
 *
 * 这一页把它们一次性摆出来，作为视觉回归的基准。
 */

const noop = () => {};
const act = (key: string, label: string, icon: ReactNode, extra = {}) => ({
  key,
  label,
  icon,
  onSelect: noop,
  ...extra,
});

const standardActions = {
  primary: [act("probe", "诊断", <Stethoscope className="h-4 w-4" />)],
  menu: [
    act("retest", "重新检测", <RefreshCcw className="h-4 w-4" />),
    act("edit", "编辑", <Pencil className="h-4 w-4" />),
    act("dup", "复制", <Copy className="h-4 w-4" />),
    act("del", "删除", <Trash2 className="h-4 w-4" />, { destructive: true }),
  ],
};

function Case({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="text-secondary-type font-medium text-foreground">{title}</h3>
        {note ? <span className="text-meta text-muted-foreground">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** 主机：在线 / 离线。离线不是整卡变灰。 */
function HostCases() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Case title="Host · Online">
        <EntityCard>
          <EntityHeader
            health="healthy"
            title="DW TW"
            subtitle="Taiwan · 78.105.182.83"
            badges={<EntityTag>v2.2.196</EntityTag>}
            trailing={<Switch defaultChecked aria-label="启用 DW TW" />}
          />
          <EntityBody>
            <ResourceMeter label="CPU" percent={2} />
            <ResourceMeter label="RAM" percent={25} />
            <ResourceMeter label="Disk" percent={17} />
          </EntityBody>
          <EntityDivider />
          <EntityBody>
            <MetricGroup columns={2}>
              <Metric label="↓ 当前" value="40.4" unit="KB/s" size="inline" />
              <Metric label="↑ 当前" value="2.0" unit="KB/s" size="inline" />
            </MetricGroup>
            <span className="text-meta text-muted-foreground">已运行 12d 5h</span>
          </EntityBody>
          <EntityFooter>
            <EntityActions {...standardActions} />
          </EntityFooter>
        </EntityCard>
      </Case>

      <Case title="Host · Offline" note="只有状态变，信息不变淡">
        {/*
          离线不是把整卡 opacity 掉 —— 那样表达了「不可用」，代价是全部信息一起
          变得难读，而离线时恰恰最需要看清 IP、地区、最后一次流量。
          只改状态点、状态文字，和拿不到的那几个指标。
        */}
        <EntityCard>
          <EntityHeader
            health="down"
            title="55"
            subtitle="Australia / NSW · 1.1.1.1"
            badges={<HealthBadge health="down" text="离线 5d 17h" />}
            trailing={<Switch aria-label="启用 55" />}
          />
          <EntityBody>
            <ResourceMeter label="CPU" percent={null} />
            <ResourceMeter label="RAM" percent={null} />
            <ResourceMeter label="Disk" percent={null} />
          </EntityBody>
          <EntityDivider />
          <EntityBody>
            <MetricGroup columns={2}>
              <Metric label="↓ 最后一次" value="4.91" unit="KB/s" size="inline" />
              <Metric label="↑ 最后一次" value="4.01" unit="KB/s" size="inline" />
            </MetricGroup>
          </EntityBody>
          <EntityFooter>
            <EntityActions {...standardActions} />
          </EntityFooter>
        </EntityCard>
      </Case>
    </div>
  );
}

/** 链路：健康 / 降级 / 多跳。入口出口不是字段，位置已经说明了。 */
function LinkCases() {
  const po0 = { id: "po0", name: "Po0", sublabel: "广东", health: "healthy" as const };
  const jinx = { id: "jinx", name: "Jinx", sublabel: "香港", health: "healthy" as const };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Case title="Link · Healthy">
        <EntityCard>
          <EntityHeader
            health="healthy"
            title="华南 → 香港"
            subtitle="ForwardX V1"
            trailing={<Switch defaultChecked aria-label="启用 华南 → 香港" />}
          />
          <EntityBody band>
            <NetworkPath nodes={[po0, jinx]} edges={[{ via: "ForwardX", latencyMs: 8 }]} />
          </EntityBody>
          <EntityBody>
            <MetricGroup>
              <Metric label="↓" value="18.4" unit="MB/s" size="inline" />
              <Metric label="↑" value="7.2" unit="MB/s" size="inline" />
              <Metric label="丢包" value="0.00" unit="%" size="inline" />
            </MetricGroup>
          </EntityBody>
          <EntityFooter>
            <EntityActions {...standardActions} />
          </EntityFooter>
        </EntityCard>
      </Case>

      <Case title="Link · Degraded" note="越界才变色">
        <EntityCard>
          <EntityHeader
            health="degraded"
            title="HK → TW"
            subtitle="ForwardX V2"
            badges={<HealthBadge health="degraded" text="延迟 82ms · 基线 34ms" />}
            trailing={<Switch defaultChecked aria-label="启用 HK → TW" />}
          />
          <EntityBody band>
            <NetworkPath
              nodes={[
                { id: "hk", name: "HK01", sublabel: "香港", health: "healthy" },
                { id: "tw", name: "TW01", sublabel: "台北", health: "degraded" },
              ]}
              edges={[{ via: "ForwardX", latencyMs: 82, health: "degraded" }]}
            />
          </EntityBody>
          <EntityBody>
            <MetricGroup>
              <Metric label="↓" value="3.1" unit="MB/s" size="inline" />
              <Metric label="↑" value="0.9" unit="MB/s" size="inline" />
              <Metric label="丢包" value="1.20" unit="%" size="inline" tone="warn" />
            </MetricGroup>
          </EntityBody>
          <EntityFooter>
            <EntityActions {...standardActions} />
          </EntityFooter>
        </EntityCard>
      </Case>

      <Case title="Link · Multi-hop" note="三个及以上节点自动竖排">
        <EntityCard>
          <EntityHeader health="healthy" title="华南 → 中继 → 香港" subtitle="ForwardX V2 · 多跳" />
          <EntityBody band>
            <NetworkPath
              nodes={[
                po0,
                { id: "relay", name: "Relay HK-01", sublabel: "香港中继", health: "healthy" },
                jinx,
              ]}
              edges={[
                { via: "ForwardX", latencyMs: 12 },
                { via: "ForwardX", latencyMs: 9 },
              ]}
            />
          </EntityBody>
          <EntityFooter>
            <EntityActions {...standardActions} />
          </EntityFooter>
        </EntityCard>
      </Case>

      <Case title="Link · Entry / Exit Group">
        <EntityCard>
          <EntityHeader health="healthy" title="聚合入口 → 香港出口组" subtitle="带宽聚合 · 800M" />
          <EntityBody band>
            <NetworkPath
              nodes={[
                { id: "g1", name: "入口组", sublabel: "Po0 500M / Po1 300M", health: "healthy" },
                { id: "fx", name: "ForwardX", sublabel: "聚合中继", health: "healthy" },
                { id: "g2", name: "出口组", sublabel: "Jinx / HK02", health: "healthy" },
              ]}
              edges={[{ latencyMs: 8 }, { latencyMs: 6 }]}
            />
          </EntityBody>
        </EntityCard>
      </Case>
    </div>
  );
}

/** 转发规则：直连 / 隧道 / 主备。Flow 成为主体。 */
function RuleCases() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Case title="Rule · Direct">
        <EntityCard>
          <EntityHeader
            health="healthy"
            title="Website TCP forward"
            subtitle="HK entry 01"
            badges={<EntityTag>iptables</EntityTag>}
            trailing={<Switch defaultChecked aria-label="启用 Website TCP forward" />}
          />
          <EntityBody band>
            <NetworkPath
              nodes={[
                { id: "in", name: "42.194.198.67:22222", health: "healthy" },
                { id: "out", name: "217.116.172.44:22222", health: "healthy" },
              ]}
              edges={[{ via: "直接转发" }]}
              orientation="vertical"
            />
          </EntityBody>
          <EntityBody>
            <MetricGroup>
              <Metric label="↓" value="38.56" unit="MB" size="inline" />
              <Metric label="↑" value="126.66" unit="MB" size="inline" />
              <Metric label="合计" value="5.39" unit="GB" size="inline" />
            </MetricGroup>
          </EntityBody>
          <EntityFooter>
            <EntityActions {...standardActions} />
          </EntityFooter>
        </EntityCard>
      </Case>

      <Case title="Rule · Tunnel">
        <EntityCard>
          <EntityHeader
            health="healthy"
            title="Sg"
            subtitle="Singapore API"
            badges={<EntityTag tone="path">隧道 / ForwardX</EntityTag>}
            trailing={<Switch defaultChecked aria-label="启用 Sg" />}
          />
          <EntityBody band>
            <NetworkPath
              nodes={[
                { id: "src", name: "42.194.198.67:22222", sublabel: "入口", health: "healthy" },
                { id: "po0", name: "Po0", sublabel: "广东", health: "healthy" },
                { id: "jinx", name: "Jinx", sublabel: "香港", health: "healthy" },
                { id: "dst", name: "217.116.172.44:22222", sublabel: "目标", health: "healthy" },
              ]}
              edges={[{}, { via: "ForwardX", latencyMs: 8 }, {}]}
            />
          </EntityBody>
          <EntityFooter>
            <EntityActions {...standardActions} />
          </EntityFooter>
        </EntityCard>
      </Case>
    </div>
  );
}

/** Route Policy：主备的三种状态。以后做主备不用设计第二套 UI。 */
function PolicyCases() {
  const line = (health: "healthy" | "standby" | "down") => [
    { id: "a1", name: "Po0", health },
    { id: "a2", name: "Relay-01", health },
    { id: "a3", name: "Jinx", health },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Case title="Route Policy · Active">
        <EntityCard>
          <EntityHeader
            health="healthy"
            title="香港出口组"
            subtitle="自动故障转移 · TCP 探测 5s"
            badges={<HealthBadge health="healthy" />}
          />
          <EntityBody>
            <PathBranch
              branches={[
                {
                  key: "a",
                  label: "主线 A",
                  nodes: line("healthy"),
                  active: true,
                  trailing: <PathMetric value="29" unit="ms" />,
                },
                {
                  key: "b",
                  label: "备线 B",
                  nodes: line("standby"),
                  trailing: <PathMetric value="34" unit="ms" />,
                },
              ]}
            />
          </EntityBody>
        </EntityCard>
      </Case>

      <Case title="Route Policy · Switching" note="唯一的瞬时态，脉冲">
        <EntityCard>
          <EntityHeader
            health="switching"
            title="香港出口组"
            subtitle="主线连续 3 次探测失败"
            badges={<HealthBadge health="switching" />}
          />
          <EntityBody>
            <PathBranch
              branches={[
                {
                  key: "a",
                  label: "主线 A",
                  nodes: line("down"),
                  health: "down",
                  trailing: <PathMetric value="超时" tone="down" />,
                },
                {
                  key: "b",
                  label: "备线 B",
                  nodes: line("healthy"),
                  health: "switching",
                  trailing: <PathMetric value="34" unit="ms" />,
                },
              ]}
            />
          </EntityBody>
          <EntityDivider />
          <EntityBody>
            {/*
              切换不能只弹一个 toast 就完事 —— 用户不在场的那次切换同样需要
              留下痕迹。卡片本身要能回答：现在走哪条、为什么切、什么时候切的。
            */}
            <ul className="flex flex-col gap-1 text-meta text-muted-foreground">
              <li>22:17 A → B　自动故障切换</li>
              <li>22:15 A　　　延迟 381ms</li>
              <li>22:15 A　　　探测失败</li>
            </ul>
          </EntityBody>
        </EntityCard>
      </Case>

      <Case title="Route Policy · All Failed" note="没有可用线路">
        <EntityCard>
          <EntityHeader
            health="down"
            title="香港出口组"
            subtitle="全部线路探测失败"
            badges={<HealthBadge health="down" />}
          />
          <EntityBody>
            <PathBranch
              branches={[
                { key: "a", label: "主线 A", nodes: line("down"), health: "down" },
                { key: "b", label: "备线 B", nodes: line("down"), health: "down" },
              ]}
            />
          </EntityBody>
        </EntityCard>
      </Case>

      <Case title="Route Policy · Unknown" note="没上报过 ≠ 正常">
        {/*
          这一格是故意留的。把「还没有结论」画成绿色，等于让一台失联的机器
          看起来健康 —— 整套状态词汇表里最不能省的就是这一档。
        */}
        <EntityCard>
          <EntityHeader
            health="unknown"
            title="东京出口组"
            subtitle="Agent 从未上报当前线路"
            badges={<HealthBadge health="unknown" />}
          />
          <EntityBody>
            <PathBranch
              branches={[{ key: "a", label: "主线 A", nodes: line("standby"), health: "unknown" }]}
            />
          </EntityBody>
        </EntityCard>
      </Case>
    </div>
  );
}

export default function EntityGallery() {
  return (
    <div className="flex flex-col gap-8">
      <Case title="状态信号" note="六档，unknown 单列一档">
        <div className="flex flex-wrap items-center gap-3">
          {(["healthy", "degraded", "down", "standby", "switching", "unknown"] as const).map((h) => (
            <span key={h} className="inline-flex items-center gap-2">
              <StatusDot health={h} size="large" />
              <HealthBadge health={h} />
            </span>
          ))}
        </div>
      </Case>

      <Case title="数值" note="数字大，标签和单位小">
        <div className="flex flex-wrap items-end gap-8">
          <Metric label="累计流量" value="6.04" unit="TB" size="display" hint="近 24H 173.63 GB" />
          <Metric label="延迟" value="8" unit="ms" />
          <Metric label="丢包" value="1.20" unit="%" tone="warn" />
          <Metric label="在线" value="4 / 5" />
        </div>
      </Case>

      <HostCases />
      <LinkCases />
      <RuleCases />
      <PolicyCases />

      <Case title="创建流程 · Review" note="点「创建」之前先看到将要得到的东西">
        <div className="max-w-md">
          <PathPreview
            nodes={[
              { id: "src", name: "42.194.198.67:22222", sublabel: "入口", health: "healthy" },
              { id: "po0", name: "Po0", sublabel: "广东", health: "healthy" },
              { id: "fx", name: "ForwardX", sublabel: "隧道", health: "healthy" },
              { id: "jinx", name: "Jinx", sublabel: "香港", health: "healthy" },
              { id: "dst", name: "217.116.172.44:22222", sublabel: "目标", health: "healthy" },
            ]}
            edges={[{}, { latencyMs: 8 }, {}, {}]}
          />
        </div>
      </Case>

      <Case title="操作" note="一级最多 2 个，删除永远在菜单最后且为红">
        <div className="flex flex-wrap items-center gap-4">
          <EntityActions
            primary={[act("probe", "诊断", <Stethoscope className="h-4 w-4" />)]}
            menu={standardActions.menu}
          />
          <EntityActions
            primary={[
              act("probe", "诊断", <Stethoscope className="h-4 w-4" />),
              act("live", "实时", <Activity className="h-4 w-4" />),
            ]}
            menu={standardActions.menu}
          />
        </div>
      </Case>
    </div>
  );
}

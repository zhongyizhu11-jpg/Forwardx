import { Activity, Coins, Cpu, Download, Gauge, HardDrive, MemoryStick, Pencil, RotateCcw, Trash2, type LucideIcon } from "lucide-react";

import { formatBytes } from "@shared/formatBytes";
import { EntityActions, type EntityAction } from "@/components/entity/EntityActions";
import {
  EntityBody,
  EntityCard,
  EntityFooter,
  EntityHeader,
} from "@/components/entity/EntityCard";
import { HealthBadge } from "@/components/network/StatusDot";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatCpuPercent, isAgentUpgradeTimedOut } from "./hostDisplay";
import { hostAddressText, hostRegionText } from "./hostDisplay";
import { HostIdentityTags, HostOsAvatar, hostOsOf } from "./HostOsBadge";
import { deriveHostVitals, type HostVitals } from "./useHostVitals";

/**
 * 主机列表里的那张卡 —— Summary 态。
 *
 * **列表负责看状态，详情负责看数据。**
 *
 * 上一版的 HostCard 在列表里同时放了：状态、名称、Agent 版本、IP、地区、计费、
 * CPU、RAM、Disk、延迟、当前流量、累计流量、系统累计、运行时间、到期时间、
 * 五个操作按钮 —— 一台机器 260～420px，二十台就是二十屏。
 *
 * 这张卡只留支撑「要不要点进去」这个决定所需的东西：
 *
 *   [图标] 名字      发行版图标（右下角挂状态点）+ 名字
 *          Debian 12 · Agent v2.2.196   系统和版本号两枚标识
 *          地区 · IP  一行注脚
 *   CPU/RAM/Disk    三条细占用条
 *   ↓ / ↑ 速率      两个数
 *   已运行 12d 5h   一行
 *                   诊断  ···
 *
 * 其余全部进详情。
 *
 * 离线的机器不整卡变灰：只有状态点、状态徽标和那三条占用条变（占用条画成
 * 「—」，因为离线时那三个数是三天前的化石）。IP、地区、最后一次流量保持满
 * 对比度 —— 机器出问题的时候，恰恰最需要看清这几项。
 */

export type HostSummaryCardProps = {
  host: any;
  /** 列表页批量查回来的 metrics。不传则这张卡不显示占用条（不会自己发请求） */
  metrics?: any[] | null;
  traffic?: { bytesIn?: number | null; bytesOut?: number | null } | null;
  canUpgrade: boolean;
  resetTrafficPending?: boolean;
  onOpenDetail: (host: any) => void;
  onEdit: (host: any) => void;
  onDelete: (id: number) => void;
  onUpgrade: (host: any) => void;
  onResetTraffic?: (host: any) => void;
  onCorrectTraffic?: (host: any) => void;
  onEditBilling?: (host: any) => void;
  onViewProbeLatency?: (host: any) => void;
};

/** 操作项的组装单独拆出来，详情页要用同一套 —— 两处给出不同的菜单是 bug 不是特性。 */
export function buildHostActions(
  props: Pick<
    HostSummaryCardProps,
    | "host"
    | "canUpgrade"
    | "resetTrafficPending"
    | "onEdit"
    | "onUpgrade"
    | "onResetTraffic"
    | "onCorrectTraffic"
    | "onEditBilling"
    | "onViewProbeLatency"
  > & { onConfirmDelete: () => void },
): { primary: EntityAction[]; menu: EntityAction[] } {
  const { host } = props;
  const isOnline = !!host?.isOnline;
  // 服务端没给这个字段时按「能管」算：管理员那一侧本来就都能管。
  const manageable = host?.manageable !== false;
  const upgradeTimedOut = isAgentUpgradeTimedOut(host);

  const primary: EntityAction[] = [];
  if (props.onViewProbeLatency) {
    primary.push({
      key: "probe",
      label: "诊断",
      icon: <Activity className="h-4 w-4" />,
      onSelect: () => props.onViewProbeLatency?.(host),
    });
  }
  /*
    编辑排在诊断后面而不是前面：诊断是「这台怎么了」，编辑是「改它」。
    列表上更常问前者 —— 真要改配置的人已经知道自己要点进哪一台了。
  */
  if (manageable) {
    primary.push({
      key: "edit",
      label: "编辑",
      icon: <Pencil className="h-4 w-4" />,
      onSelect: () => props.onEdit(host),
    });
  }

  const menu: EntityAction[] = [];
  if (props.onResetTraffic) {
    menu.push({
      key: "reset",
      label: props.resetTrafficPending ? "正在重置流量" : "重置流量统计",
      icon: <RotateCcw className="h-4 w-4" />,
      disabled: props.resetTrafficPending,
      onSelect: () => props.onResetTraffic?.(host),
    });
  }
  if (props.onCorrectTraffic) {
    menu.push({
      key: "correct",
      label: "用量修正",
      icon: <Gauge className="h-4 w-4" />,
      onSelect: () => props.onCorrectTraffic?.(host),
    });
  }
  if (props.onEditBilling) {
    menu.push({
      key: "billing",
      label: "按量计费",
      icon: <Coins className="h-4 w-4" />,
      onSelect: () => props.onEditBilling?.(host),
    });
  }
  /*
    升不了的人干脆别给这一项 —— 渲染出来再 disabled，对租户就是一个永远灰着的
    菜单项，因为下发升级本来就是管理员专属接口。
  */
  if (props.canUpgrade) {
    menu.push({
      key: "upgrade",
      label: "升级 Agent",
      icon: <Download className="h-4 w-4" />,
      disabled: !isOnline,
      onSelect: () => props.onUpgrade(host),
    });
  }
  /*
    不是自己的机器就不给删除入口。管理员授权他使用的机器，服务端按
    `userId === 自己` 挡着；留着按钮点下去只会吃一句「无权操作此主机」——
    那不是提示，是绊脚石。
  */
  if (manageable) {
    menu.push({
      key: "delete",
      label: "删除主机",
      icon: <Trash2 className="h-4 w-4" />,
      destructive: true,
      onSelect: props.onConfirmDelete,
    });
  }

  return { primary, menu };
}

/**
 * 一行「标签 值」。列表里所有数值都走这个。
 *
 * 不用 Metric —— Metric 是标签在上、值在下的两行结构，给的是「这个数值得
 * 单独看一眼」的分量。列表卡里一次要放五六个数，每个都占两行就是 100px，
 * 而它们在这里的作用只是「扫一眼有没有异常」。
 */
function Stat({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="shrink-0 text-meta text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 truncate text-meta font-medium tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}
      >
        {value}
      </span>
    </span>
  );
}

/**
 * 资源一行三个小方块，**不画条**。
 *
 * 条留给详情页。列表要回答的是「有没有哪台快满了」，一个数字就够。
 * 方块的样子照 kfchost 套餐卡里的规格格：比卡深一点的灰底、小圆角、左边一枚图标，
 * 右边上标签下数值 —— 三个数各自有一块地，扫一眼就分得开，比一行「CPU 12% 内存 40%」
 * 省认读。
 *
 * 拿不到数据写「—」不写 0% —— 一台离线的机器 CPU 不是 0%，是不知道。
 */
function SpecBlock({ icon: Icon, label, value, muted }: { icon: LucideIcon; label: string; value: string; muted: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-[8px] bg-[var(--fx-l2-group)] px-2 py-1">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className={`truncate text-meta font-semibold tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}>{value}</span>
      </span>
    </span>
  );
}

function ResourceRow({ vitals }: { vitals: HostVitals }) {
  const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value)}%`);
  const unknown = vitals.cpuPercent === null;
  return (
    <div className="grid min-w-0 grid-cols-3 gap-1.5">
      <SpecBlock icon={Cpu} label="CPU" value={formatCpuPercent(vitals.cpuPercent, vitals.isOnline)} muted={unknown} />
      <SpecBlock icon={MemoryStick} label="内存" value={pct(vitals.memoryPercent)} muted={unknown} />
      <SpecBlock icon={HardDrive} label="磁盘" value={pct(vitals.diskPercent)} muted={unknown} />
    </div>
  );
}

/** 速率一行。离线时标签是「最后一次」而不是「当前」。 */
function SpeedRow({ vitals }: { vitals: HostVitals }) {
  const fmt = (value: number | null) => (value === null ? "—" : `${formatBytes(value)}/s`);
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <Stat label="↓" value={fmt(vitals.speedIn)} />
      <Stat label="↑" value={fmt(vitals.speedOut)} />
      <span className="shrink-0 text-meta text-muted-foreground">{vitals.speedLabel}</span>
    </div>
  );
}

export default function HostSummaryCard(props: HostSummaryCardProps) {
  const { host, metrics, traffic } = props;
  const confirmDialog = useConfirmDialog();
  const vitals = deriveHostVitals(host, metrics, traffic);

  const name = String(host?.name || "-").trim() || "-";
  const os = hostOsOf(host);
  const region = hostRegionText(host);
  const address = hostAddressText(host);
  const subtitle = [region, address].filter(Boolean).join(" · ");

  const confirmDelete = async () => {
    if (
      await confirmDialog({
        title: "删除主机",
        description: "确定要删除此主机吗？删除后相关状态和配置会同步移除。",
        confirmText: "删除",
        tone: "destructive",
      })
    ) {
      props.onDelete(host.id);
    }
  };

  const { primary, menu } = buildHostActions({ ...props, onConfirmDelete: () => void confirmDelete() });

  return (
    <EntityCard
      interactive
      role="button"
      tabIndex={0}
      aria-label={`查看 ${name} 详情`}
      onClick={() => props.onOpenDetail(host)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpenDetail(host);
        }
      }}
    >
      <EntityHeader
        className="gap-3"
        health={vitals.health}
        leading={<HostOsAvatar os={os} health={vitals.health} />}
        title={name}
        /*
          系统和 Agent 版本单独一行，不挤在名字右边：名字才是这张卡的主角，
          两枚标识放名字旁边，长一点的名字就被截成「Tokyo-II…」。
        */
        meta={os.label || host?.agentVersion ? <HostIdentityTags os={os} agentVersion={host?.agentVersion} /> : null}
        subtitle={subtitle}
        trailing={
          /*
            离线才挂状态徽标。在线时那一列绿色徽标每行都有，说的全是同一件事，
            反而把真正异常的那几行淹掉了 —— 状态点已经说完了「正常」。
          */
          vitals.isOnline ? null : (
            <HealthBadge
              health={vitals.health}
              text={vitals.health === "unknown" ? "未上报" : "离线"}
            />
          )
        }
      />

      {/*
        运行时间、系统累计、计费用量、到期时间全部进详情 —— 它们回答不了
        「要不要点进去」这个问题，而列表上的每一行都要为这个问题服务。
      */}
      <EntityBody tight>
        <ResourceRow vitals={vitals} />
        <SpeedRow vitals={vitals} />
      </EntityBody>

      {/*
        底栏的点击不能冒泡成「打开详情」—— 点「删除」结果弹出详情页是最糟的
        那种意外。整卡可点带来的代价就是这一条，所以在这里截断。
      */}
      <EntityFooter onClick={(event) => event.stopPropagation()}>
        <EntityActions primary={primary} menu={menu} />
      </EntityFooter>
    </EntityCard>
  );
}

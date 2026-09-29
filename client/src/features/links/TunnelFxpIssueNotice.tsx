import { cn } from "@/lib/utils";

/**
 * NEX 隧道上有成员主机的 FXP 握不上当前协议时的提示（面板在 tunnels.list/options 里给的
 * fxpIssues，见 server/tunnelFxpRuntime.ts）。
 *
 * 这种隧道 tcping 能通、真实流量全超时，光看延迟和状态点看不出来，所以直接把「哪台、
 * 什么版本、怎么修」写在隧道和走这条隧道的规则上。
 */

type FxpIssue = { hostId?: number | null; hostName?: string | null; fxpVersion?: string | null; message?: string | null };

export function tunnelFxpIssueText(tunnel: { fxpIssues?: FxpIssue[] | null } | null | undefined) {
  const issues = Array.isArray(tunnel?.fxpIssues) ? tunnel!.fxpIssues! : [];
  const messages = Array.from(new Set(
    issues.map((issue) => String(issue?.message || "").trim()).filter(Boolean),
  ));
  return messages.join("；");
}

export function TunnelFxpIssueNotice({
  tunnel,
  className,
  as: Tag = "p",
}: {
  tunnel: { fxpIssues?: FxpIssue[] | null } | null | undefined;
  className?: string;
  as?: "p" | "span";
}) {
  const text = tunnelFxpIssueText(tunnel);
  if (!text) return null;
  return (
    <Tag className={cn("mt-1 block text-[11px] leading-snug text-destructive", className)} title={text} data-fxp-issue="">
      {text}
    </Tag>
  );
}

import { ZodError, type ZodIssue } from "zod";

/**
 * tRPC 的输入校验失败时，默认把整份 ZodError（一串 JSON）塞进 message，
 * 前端 toast 直接把它展示给用户。这里只改写「输入校验失败」这一种错误的 message：
 * 取第一条 issue，拼成「字段: 原因」。其它错误的 message 原样保留 ——
 * 前端会解析一些错误码（LOGIN_RATE_LIMITED:N 之类），不能动。
 * shape.data.zodError 保留完整 issue 列表，方便表单按字段标红。
 */

const CJK_PATTERN = /[㐀-鿿]/;

function sizeUnit(type: string): string {
  if (type === "string") return "个字符";
  if (type === "array" || type === "set") return "项";
  return "";
}

/** 把一条 zod issue 翻成一句人话；schema 里自带中文提示的直接用。 */
export function zodIssueReason(issue: ZodIssue): string {
  const message = String(issue.message || "").trim();
  if (message && CJK_PATTERN.test(message)) return message;
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" || issue.received === "null" ? "不能为空" : "类型不正确";
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.type === "string" && min === 1) return "不能为空";
      if (issue.type === "array" && min === 1) return "至少选择一项";
      const unit = sizeUnit(issue.type);
      if (unit) return `至少 ${min} ${unit}`;
      return issue.inclusive ? `不能小于 ${min}` : `必须大于 ${min}`;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      const unit = sizeUnit(issue.type);
      if (unit) return `最多 ${max} ${unit}`;
      return issue.inclusive ? `不能大于 ${max}` : `必须小于 ${max}`;
    }
    case "invalid_string":
      return "格式不正确";
    case "invalid_enum_value":
    case "invalid_literal":
    case "invalid_union":
    case "invalid_union_discriminator":
      return "取值无效";
    case "not_multiple_of":
      return `必须是 ${String(issue.multipleOf)} 的倍数`;
    case "invalid_date":
      return "日期无效";
    case "unrecognized_keys":
      return "包含不支持的字段";
    default:
      return message || "取值无效";
  }
}

/** 第一条校验错误的可读描述，例如「name: 最多 128 个字符」。 */
export function zodErrorMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "输入参数无效";
  const path = issue.path.map(String).join(".");
  const reason = zodIssueReason(issue);
  return path ? `${path}: ${reason}` : `输入参数无效：${reason}`;
}

type ErrorFormatterInput<TShape> = {
  shape: TShape;
  error: { cause?: unknown };
};

export function formatTrpcErrorShape<TShape extends { message: string; data: Record<string, unknown> }>(
  { shape, error }: ErrorFormatterInput<TShape>,
): TShape & { data: TShape["data"] & { zodError: ReturnType<ZodError["flatten"]> | null } } {
  const cause = error.cause;
  if (cause instanceof ZodError) {
    return {
      ...shape,
      message: zodErrorMessage(cause),
      data: { ...shape.data, zodError: cause.flatten() },
    };
  }
  return { ...shape, data: { ...shape.data, zodError: null } };
}

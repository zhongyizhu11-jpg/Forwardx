import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { formatTrpcErrorShape, zodErrorMessage } from "./errorFormatter";
import { publicProcedure, router } from "./trpc";

function zodErrorOf(schema: z.ZodTypeAny, value: unknown) {
  const result = schema.safeParse(value);
  assert.equal(result.success, false);
  return (result as z.SafeParseError<unknown>).error;
}

const baseShape = () => ({
  message: "raw",
  code: -32600,
  data: { code: "BAD_REQUEST", httpStatus: 400, path: "x" } as Record<string, unknown>,
});

test("zod validation errors become a readable first-issue message", () => {
  const error = zodErrorOf(z.object({ name: z.string().min(1).max(128) }), { name: "x".repeat(200) });
  assert.equal(zodErrorMessage(error), "name: 最多 128 个字符");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ name: z.string().min(1) }), { name: "" })), "name: 不能为空");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ port: z.number().int().min(1) }), { port: 0 })), "port: 不能小于 1");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ a: z.object({ b: z.string() }) }), { a: {} })), "a.b: 不能为空");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ kind: z.enum(["a", "b"]) }), { kind: "c" })), "kind: 取值无效");
  assert.equal(zodErrorMessage(zodErrorOf(z.object({ email: z.string().email() }), { email: "nope" })), "email: 格式不正确");
});

test("custom Chinese messages in schemas are kept as-is", () => {
  const error = zodErrorOf(z.object({ name: z.string().min(1, "请填写名称") }), { name: "" });
  assert.equal(zodErrorMessage(error), "name: 请填写名称");
  assert.equal(zodErrorMessage(zodErrorOf(z.number().min(1), 0)), "输入参数无效：不能小于 1");
});

test("errorFormatter rewrites zod errors and keeps zodError details", () => {
  const cause = zodErrorOf(z.object({ name: z.string().max(2) }), { name: "abcd" });
  const error = new TRPCError({ code: "BAD_REQUEST", message: cause.message, cause });
  const shape = formatTrpcErrorShape({ shape: baseShape(), error });
  assert.equal(shape.message, "name: 最多 2 个字符");
  assert.ok(shape.data.zodError);
  assert.deepEqual(Object.keys(shape.data.zodError!.fieldErrors), ["name"]);
  assert.equal(shape.data.code, "BAD_REQUEST");
});

test("errorFormatter leaves non-zod messages (client-parsed codes) untouched", () => {
  const error = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "LOGIN_RATE_LIMITED:5" });
  const shape = formatTrpcErrorShape({ shape: { ...baseShape(), message: "LOGIN_RATE_LIMITED:5" }, error });
  assert.equal(shape.message, "LOGIN_RATE_LIMITED:5");
  assert.equal(shape.data.zodError, null);
});

test("the tRPC instance uses the formatter for input validation failures", async () => {
  const appRouter = router({
    echo: publicProcedure.input(z.object({ name: z.string().min(1).max(4) })).mutation(({ input }) => input.name),
  });
  const caller = appRouter.createCaller({} as any);
  const thrown = await caller.echo({ name: "toolong" }).then(() => null, (e) => e);
  assert.ok(thrown instanceof TRPCError);
  const config = (appRouter as any)._def._config;
  const shape = config.errorFormatter({
    shape: { ...baseShape(), message: thrown.message },
    error: thrown,
    type: "mutation",
    path: "echo",
    input: { name: "toolong" },
    ctx: undefined,
  });
  assert.equal(shape.message, "name: 最多 4 个字符");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 每个表单控件都要说得出自己是干什么的。
 *
 * 读屏念一个没有名字的开关只会说「switch, checked」，念一个没有名字的下拉只会说
 * 「combobox」。设置页一度有 11 个开关全无名称：读屏用户连着听到十一声
 * 「switch, checked」，分不清哪个是「开放注册」哪个是「启用 HTTPS」。
 *
 * 什么算「有名字」，下面每一条都在 Chrome 里用 Accessibility.getPartialAXTree
 * 实测过，不是照着规范猜的：
 *
 *   - `aria-label` / `aria-labelledby`                → 来源 attribute
 *   - `title`                                          → 来源 attribute
 *   - `id=` 配一个 `<Label htmlFor>`                    → 来源 relatedElement:labelfor
 *   - 被 `<label>` / `<Label>` 包着                     → 来源 relatedElement:labelwrapped
 *   - 在 `<FormField>` 里且同一层有 `<Label>`            → FormField 用 context 发 id，
 *                                                        Label 拿去当 htmlFor，等价于上一条
 *   - 输入框的 `placeholder`                            → 来源 placeholder（兜底，弱）
 *
 * 两条容易想当然的，实测结论和直觉相反，写在这里免得以后又改错：
 *   - `<label for>` 对 `<button>` **有效**。Radix 的开关和下拉渲染出来都是 button，
 *     一样能被 label 命名，不必非写 aria-label。
 *   - 下拉（role=combobox）**不从内容取名**。`<SelectTrigger><SelectValue /></...>`
 *     里显示的当前值，读屏一个字都念不到 —— 看得见不等于听得见。
 *
 * 这是**源码级**检查，不开浏览器，所以跑得起也拦得住新增的漏网：浏览器走查只能
 * 看到当下渲染出来的那些，对话框里、条件分支里的控件根本走不到。
 * 代价是它认不出「控件先存进变量、再塞进别处的 <label> 里」这种写法（Tunnels 的
 * renderTransportSwitch 就是），那几处直接写了 aria-label，不去教脚本追数据流。
 */

const ROOT = path.resolve(import.meta.dirname);

/** 控件名 → 类别。输入框的 placeholder 能兜底，开关和下拉不能。 */
const CONTROLS: Record<string, "input" | "switch" | "select"> = {
  Input: "input",
  Textarea: "input",
  Switch: "switch",
  OptimisticSwitch: "switch",
  // 复选框渲染出来是 <input type="checkbox">，但 placeholder 对它没意义，
  // 所以归到 switch 这一类（不给 placeholder 兜底）。
  Checkbox: "switch",
  SelectTrigger: "select",
};

function collectTsx(dir: string, out: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsx(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * 找出标签属性区的结尾 `>`。
 *
 * 不能拿正则按行切：`<Switch` 后面直接换行、属性写在下面几行是常见写法，
 * 第一版就是按行扫的，结果 31 个这样写的开关一个都没看见，名单「清空」其实是瞎的。
 * 括号和引号要跟着数，否则 `className={cn("a>b")}` 里的 `>` 会被当成标签结束。
 */
function tagEnd(source: string, index: number) {
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
    } else if (c === ">" && depth === 0) return i;
    i += 1;
  }
  return -1;
}

type Frame = { name: string; hasLabel: boolean };

function scan(source: string, relative: string) {
  /*
    wouter 的路由组件也叫 <Switch>，和开关同名。只认从 ui/switch 导入的那个 ——
    不排除的话 App.tsx 里的路由会被当成没名字的开关报出来（第一版就误报了两处）。
  */
  const routerSwitchOnly = !/from\s+["'][^"']*\/components\/ui\/switch["']/.test(source);
  const stack: Frame[] = [];
  const found: { loc: string; named: boolean }[] = [];
  const tags = /<(\/?)([A-Za-z][A-Za-z0-9]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(source))) {
    const name = match[2];
    if (match[1] === "/") {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }
    const end = tagEnd(source, match.index + match[0].length);
    if (end < 0) continue;
    const attrs = source.slice(match.index + match[0].length, end);
    const selfClosing = source[end - 1] === "/";
    if (name === "Label" || name === "label") {
      for (let k = stack.length - 1; k >= 0; k -= 1) {
        if (stack[k].name === "FormField") { stack[k].hasLabel = true; break; }
      }
    }
    const kind = CONTROLS[name];
    if (kind && !(kind === "switch" && routerSwitchOnly)) {
      const named = /\baria-label[=\s]/.test(attrs)
        || /\baria-labelledby=/.test(attrs)
        || /\btitle=/.test(attrs)
        || /\bid=/.test(attrs)
        || stack.some((frame) => frame.name === "Label" || frame.name === "label")
        || stack.some((frame) => frame.name === "FormField" && frame.hasLabel)
        || (kind === "input" && /\bplaceholder=/.test(attrs));
      found.push({ loc: `${relative}:${source.slice(0, match.index).split("\n").length}`, named });
    }
    if (!selfClosing) stack.push({ name, hasLabel: false });
  }
  return found;
}

/*
  还没补名字的控件，一处一行。

  这是**棘轮**不是豁免：名单只许变短。新写的控件漏了名字会直接红，
  名单里的补好了就从这里删掉 —— 删不掉说明没真补。

  为什么不靠脚本自动补：按「最近的中文」自动提名试过了，一半提出来的是说明文字
  而不是名字（「低于阈值时提醒。」这种做可访问名称是错的，WCAG 要的是和可见标签
  一致）。硬套上去比没有更糟 —— 读屏用户听到一句和界面对不上的话，反而更难定位。
*/
const 待补: readonly string[] = [
  // 已清空：全站的开关、输入框、下拉都有可访问名称了。新增的漏网会直接红。
];

test("每个表单控件都有可访问名称", () => {
  const offenders: string[] = [];
  let total = 0;
  for (const file of collectTsx(ROOT)) {
    // 组件自身的定义不算用法
    if (file.endsWith(path.join("ui", "switch.tsx"))) continue;
    if (file.endsWith(path.join("ui", "form-field.test.tsx"))) continue;
    for (const item of scan(fs.readFileSync(file, "utf8"), path.relative(ROOT, file))) {
      total += 1;
      if (!item.named) offenders.push(item.loc);
    }
  }
  assert.ok(total >= 500, `只扫到 ${total} 个控件，扫描逻辑可能失效了`);
  const 新增 = offenders.filter((x) => !待补.includes(x));
  assert.deepEqual(
    新增,
    [],
    `新写的控件漏了可访问名称，读屏里只会念出「switch」「combobox」「编辑框，空」：\n  ${新增.join("\n  ")}`,
  );
  // 名单只许变短：补好了就从 待补 里删掉。
  const 已补好 = 待补.filter((x) => !offenders.includes(x));
  assert.deepEqual(
    已补好,
    [],
    `这些已经补上名字了，请从 待补 名单里删掉：\n  ${已补好.join("\n  ")}`,
  );
});

test("扫描器看得见多行标签和包裹式 label", () => {
  // 这两种写法第一版都看不见，各留一条回归。
  const multiline = scan('import x from "@/components/ui/switch";\nconst a = <Switch\n  checked\n/>;\n', "a.tsx");
  assert.equal(multiline.length, 1, "多行开头的 <Switch 没被扫到");
  assert.equal(multiline[0].named, false);

  const wrapped = scan('import x from "@/components/ui/switch";\nconst a = <label><span>甲</span><Switch checked /></label>;\n', "b.tsx");
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].named, true, "被 <label> 包着的开关应当算有名字");

  const viaField = scan('const a = <FormField><Label>乙</Label><SelectTrigger /></FormField>;\n', "c.tsx");
  assert.equal(viaField.length, 1);
  assert.equal(viaField[0].named, true, "FormField + Label 应当算有名字");

  const lonelyField = scan('const a = <FormField><SelectTrigger /></FormField>;\n', "d.tsx");
  assert.equal(lonelyField[0].named, false, "FormField 里没有 Label 就没有名字可给");

  // 下拉不从内容取名：当前值看得见，读屏念不到。
  const selectValue = scan('const a = <SelectTrigger><SelectValue placeholder="选择主机" /></SelectTrigger>;\n', "e.tsx");
  assert.equal(selectValue[0].named, false);
});

/*
  只有图标、没有文字的按钮同样要有名字。

  这一条的判定比上面的控件弱：JSX 里「按钮内容是不是只有图标」只能按文本粗判，
  `{pending ? <Loader2 /> : <Send />}` 这种分支会被当成「有文字」而放过。
  宁可漏报不误报 —— 误报会逼着人给本来就有文字的按钮再加一个 aria-label，
  那个名字和可见文字一旦不一致，WCAG 2.5.3（名称含可见标签）反而挂了。
  漏掉的那部分由真面板走查兜：走查读的是 Chrome 算出来的名称，不猜。
*/
function scanIconButtons(source: string, relative: string) {
  const found: { loc: string; named: boolean }[] = [];
  const opens = /<Button[\s/>]/g;
  let match: RegExpExecArray | null;
  while ((match = opens.exec(source))) {
    const end = tagEnd(source, match.index + "<Button".length);
    if (end < 0) continue;
    const attrs = source.slice(match.index + "<Button".length, end);
    const named = /\baria-label[=\s]/.test(attrs) || /\baria-labelledby=/.test(attrs) || /\btitle=/.test(attrs);
    const loc = `${relative}:${source.slice(0, match.index).split("\n").length}`;
    if (source[end - 1] === "/") { found.push({ loc, named }); continue; }   // 自闭合：肯定没内容
    let depth = 1;
    let i = end + 1;
    while (i < source.length && depth > 0) {
      if (source.startsWith("<Button", i)) depth += 1;
      else if (source.startsWith("</Button>", i)) { depth -= 1; if (depth === 0) break; }
      i += 1;
    }
    const children = source.slice(end + 1, i);
    if (/<span className="sr-only">/.test(children)) continue;              // sr-only 也是可见标签的替代
    const withoutIcons = children.replace(/<[A-Za-z][^<>]*\/>/g, "").replace(/\s+/g, "");
    if (withoutIcons === "") found.push({ loc, named });
  }
  return found;
}

const 图标按钮待补: readonly string[] = [
  // 已清空。
];

test("只有图标的按钮都有可访问名称", () => {
  const offenders: string[] = [];
  let total = 0;
  for (const file of collectTsx(ROOT)) {
    for (const item of scanIconButtons(fs.readFileSync(file, "utf8"), path.relative(ROOT, file))) {
      total += 1;
      if (!item.named) offenders.push(item.loc);
    }
  }
  assert.ok(total >= 100, `只扫到 ${total} 个图标按钮，扫描逻辑可能失效了`);
  const 新增 = offenders.filter((x) => !图标按钮待补.includes(x));
  assert.deepEqual(新增, [], `图标按钮没有名字，读屏里只会念出「按钮」：\n  ${新增.join("\n  ")}`);
  const 已补好 = 图标按钮待补.filter((x) => !offenders.includes(x));
  assert.deepEqual(已补好, [], `这些已经补上名字了，请从名单里删掉：\n  ${已补好.join("\n  ")}`);
});

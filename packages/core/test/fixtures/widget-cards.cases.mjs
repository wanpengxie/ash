// Home-screen cards checked by both the core (widget-card.test.ts) and the phone (WidgetPlanTest.kt), through
// widget-cards.json: edit the cases here, then `npm run gen:widget-cards`.
const col = (id, children, extra = {}) => ({ id, component: "Column", children, ...extra });
const row = (id, children, extra = {}) => ({ id, component: "Row", children, ...extra });
const text = (id, t, extra = {}) => ({ id, component: "Text", text: t, ...extra });
const chain = (n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(col(i === 0 ? "root" : `c${i}`, [i === n - 1 ? "leaf" : `c${i + 1}`]));
  out.push(text("leaf", "deep"));
  return out;
};
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const cases = [
  { name: "the first card format still works", expect: "ok", levels: 4, a2ui: { components: [
    col("root", ["head", "temp", "bar", "line", "buttons"]),
    row("head", ["icon", "city", "badge"], { justify: "spaceBetween" }),
    { id: "icon", component: "Image", url: "icon:sun" }, text("city", { path: "/city" }, { variant: "caption" }), { id: "badge", component: "Badge", text: "晴" },
    text("temp", { path: "/temp" }, { variant: "h1" }), { id: "bar", component: "ProgressBar", value: { path: "/rain" }, label: "降雨" },
    { id: "line", component: "Divider" }, row("buttons", ["refresh"]),
    { id: "refresh", component: "Button", child: "refresh_label", action: { event: { name: "refresh" } } }, text("refresh_label", "刷新")],
    data: { city: "上海", temp: 23, rain: 40 } } },
  { name: "Column > Row > Column > Text (drew blank on the phone)", expect: "ok", levels: 4, a2ui: { components: [
    col("root", ["title", "r"]), text("title", "今日", { variant: "h3" }), row("r", ["left", "right"], { justify: "spaceBetween" }),
    col("left", ["t1", "t2"]), text("t1", "23℃", { variant: "h1" }), text("t2", "多云", { variant: "caption" }),
    col("right", ["t3"], { align: "end" }), text("t3", "空气良\n湿度 60%")] } },
  { name: "translucent dark card with text styles", expect: "ok", levels: 2, a2ui: { components: [
    col("root", ["a", "b"], { style: { background: "#000000B3", color: "white", cornerRadius: 24, padding: [12, 16] } }),
    text("a", "**体重** 61.8 kg", { style: { fontSize: 28, fontWeight: "bold", italic: true, textAlign: "center", maxLines: 1, ellipsize: "middle" } }),
    text("b", "比上周 -0.4", { style: { color: { light: "#2E7D32", dark: "#81C784" }, opacity: 0.8, margin: { top: 4 } } })] } },
  { name: "ten nested levels are fine", expect: "ok", levels: 10, a2ui: { components: chain(9) } },
  { name: "eleven nested levels are more than Android takes", expect: "error", error: "nests 11 levels deep", levels: 11, a2ui: { components: chain(10) } },
  { name: "a weighted child sits in a slot and costs a level", expect: "error", error: "nests 11 levels deep", levels: 11, a2ui: { components: [
    ...chain(9).map((c) => c.id === "c8" ? { ...c, weight: 1 } : c)] } },
  { name: "per-size layouts take one level of the budget", expect: "error", error: "at most 9 with per-size layouts", levels: 10, a2ui: { components: [...chain(9), text("small", "s")],
    sizes: [{ width: 100, height: 100, root: "small" }, { width: 300, height: 200, root: "root" }] } },
  { name: "a to-do list: template items with checkboxes and buttons", expect: "ok", levels: 2, a2ui: { components: [
    col("root", ["title", "list"]), text("title", { call: "formatString", args: { value: "待办 ${/count} 项" } }, { variant: "h3" }),
    { id: "list", component: "List", children: { componentId: "item", path: "/todo" } },
    row("item", ["check", "del"], { action: { event: { name: "open", context: { id: { path: "id" } } } } }),
    { id: "check", component: "CheckBox", label: { path: "title" }, value: { path: "done" }, weight: 1, action: { event: { name: "toggle" } } },
    { id: "del", component: "Button", child: "del_icon", variant: "borderless", action: { event: { name: "delete" } } },
    { id: "del_icon", component: "Icon", name: "delete" }],
    data: { count: 2, todo: [{ id: "milk", title: "买牛奶", done: false }, { id: "mail", title: "回邮件", done: true }] } } },
  { name: "any number of buttons", expect: "ok", levels: 3, a2ui: { components: [
    row("root", ["b1", "b2", "b3", "b4", "b5"]),
    ...[1, 2, 3, 4, 5].flatMap((n) => [{ id: `b${n}`, component: "Button", child: `l${n}`, variant: n === 1 ? "primary" : "default", action: { event: { name: `a${n}` } } }, text(`l${n}`, `按钮${n}`)])] } },
  { name: "images, icons and actions that open things", expect: "ok", levels: 4, a2ui: { components: [
    col("root", ["pic", "data", "face", "ic", "svg", "links"]),
    { id: "pic", component: "Image", url: "https://example.com/a.jpg", fit: "cover", variant: "header", action: { openApp: { app: "health", surface: "trends" } } },
    { id: "data", component: "Image", url: png, variant: "icon" }, { id: "face", component: "Image", url: "avatar:thinking", variant: "avatar" },
    { id: "ic", component: "Icon", name: "favorite", style: { color: "red", fontSize: 20 } },
    { id: "svg", component: "Icon", name: { svgPath: "M2 2 L22 2 L12 22 Z" } },
    row("links", ["l1", "l2"]),
    { id: "l1", component: "Button", child: "l1t", action: { functionCall: { call: "openUrl", args: { url: "ui://todo/home" } } } }, text("l1t", "详情"),
    { id: "l2", component: "Button", child: "l2t", action: { openAsh: {} } }, text("l2t", "问 Ash")] } },
  { name: "every other component", expect: "ok", levels: 5, a2ui: { components: [
    col("root", ["tabs", "grid", "stack", "pick", "sw", "sp", "clock", "timer", "pb", "div"], { justify: "spaceBetween" }),
    { id: "tabs", component: "Tabs", tabs: [{ title: "今天", child: "t1" }, { title: "明天", child: "t2" }], selected: 1 }, text("t1", "晴"), text("t2", "雨"),
    { id: "grid", component: "Grid", columns: 2, children: ["g1", "g2", "g3"] }, text("g1", "1"), text("g2", "2"), text("g3", "3"),
    { id: "stack", component: "Stack", children: ["bg", "dot"] }, { id: "bg", component: "Image", url: "icon:sun" },
    { id: "dot", component: "Badge", text: "3", style: { place: "topEnd" } },
    { id: "pick", component: "ChoicePicker", label: "心情", options: [{ label: "好", value: "good" }, { label: "一般", value: "ok" }], value: { path: "/mood" }, displayStyle: "chips" },
    { id: "sw", component: "Switch", label: "勿扰", value: true }, { id: "sp", component: "Spacer" },
    { id: "clock", component: "Clock", format: "HH:mm", timeZone: "Asia/Shanghai" }, { id: "timer", component: "Timer", since: 1791306000000 },
    { id: "pb", component: "ProgressBar", value: 3, max: 8, label: "3/8" }, { id: "div", component: "Divider" }],
    data: { mood: ["good"] } } },
  { name: "per-size layouts", expect: "ok", levels: 2, a2ui: { components: [col("root", ["big", "note"]), text("big", "61.8", { variant: "h1" }), text("note", "kg"), col("small", ["big2"]), text("big2", "61.8")],
    sizes: [{ width: 110, height: 110, root: "small" }, { width: 250, height: 110, root: "root" }] } },
  { name: "a Stack's align places every child in a slot", expect: "ok", levels: 3, a2ui: { components: [
    { id: "root", component: "Stack", align: "bottomEnd", children: ["a", "b"] }, text("a", "a"), text("b", "b", { style: { place: "topStart" } })] } },
  { name: "justify stretch gives every child a slot", expect: "ok", levels: 3, a2ui: { components: [row("root", ["a", "b"], { justify: "stretch" }), text("a", "a"), text("b", "b")] } },
  { name: "the phone's to-do card (its list came out empty on ColorOS)", expect: "ok", levels: 4, a2ui: {"components":[{"id":"root","component":"Column","style":{"background":"translucentDark","color":"white","cornerRadius":20,"padding":14},"children":["title","list","divider","footer"]},{"id":"title","component":"Text","text":"**待办**","variant":"h3"},{"id":"list","component":"List","weight":1,"children":{"componentId":"item","path":"/todo"}},{"id":"item","component":"CheckBox","label":{"path":"title"},"value":{"path":"done"},"action":{"event":{"name":"toggle"}}},{"id":"divider","component":"Divider"},{"id":"btnlabel","component":"Text","text":"看趋势"},{"id":"btn","component":"Button","variant":"primary","child":"btnlabel","action":{"openApp":{"app":"health","surface":"trends"}}},{"id":"footer","component":"Row","justify":"spaceBetween","align":"center","children":["btn"]}],"data":{"todo":[{"id":"t1","title":"门磁 / 摄像头比价","done":false},{"id":"t2","title":"温控器背面拍型号","done":false},{"id":"t3","title":"Gadgetbridge 开 Intent API","done":false},{"id":"t4","title":"早上空腹称重","done":false},{"id":"t5","title":"体脂秤接入 Ash","done":true},{"id":"t6","title":"奥森灯光秀（10/7）","done":true},{"id":"t7","title":"需求文档交给作者","done":true},{"id":"t8","title":"回龙观 → 公司骑行记录","done":false}]}} },
  { name: "more scrolling lists than Android has views for", expect: "error", error: "at most 16 scrolling lists", a2ui: { components: [
    col("root", Array.from({ length: 17 }, (_, i) => `l${i}`)), ...Array.from({ length: 17 }, (_, i) => ({ id: `l${i}`, component: "List", children: [] }))] } },
  { name: "video cannot be drawn", expect: "error", error: "Video \"root\" cannot be drawn", a2ui: { components: [{ id: "root", component: "Video", url: "https://x/v.mp4" }] } },
  { name: "text input cannot be drawn", expect: "error", error: "TextField \"root\" cannot be drawn", a2ui: { components: [{ id: "root", component: "TextField", label: "x" }] } },
  { name: "sliders cannot be drawn", expect: "error", error: "Slider \"root\" cannot be drawn", a2ui: { components: [{ id: "root", component: "Slider", max: 10, value: 1 }] } },
  { name: "unknown components are named", expect: "error", error: "unknown type \"Foo\"", a2ui: { components: [{ id: "root", component: "Foo" }] } },
  { name: "plain http images are not fetched", expect: "error", error: "plain http images are not fetched", a2ui: { components: [{ id: "root", component: "Image", url: "http://example.com/a.png" }] } },
  { name: "svg images cannot be drawn", expect: "error", error: "SVG cannot be drawn", a2ui: { components: [{ id: "root", component: "Image", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }] } },
  { name: "borders are not settable", expect: "error", error: "style.border is not possible", a2ui: { components: [text("root", "x", { style: { border: 1 } })] } },
  { name: "style at the top level points into style", expect: "error", error: "put it in style", a2ui: { components: [text("root", "x", { color: "red" })] } },
  { name: "lists only scroll vertically", expect: "error", error: "only scroll lists vertically", a2ui: { components: [{ id: "root", component: "List", direction: "horizontal", children: [] }] } },
  { name: "a list inside a list item", expect: "error", error: "cannot scroll a list inside a list", a2ui: { components: [{ id: "root", component: "List", children: ["inner"] }, { id: "inner", component: "List", children: [] }] } },
  { name: "colours are checked", expect: "error", error: "is not a colour", a2ui: { components: [text("root", "x", { style: { color: "reddish" } })] } },
  { name: "icons are checked", expect: "error", error: "is not a built-in icon", a2ui: { components: [{ id: "root", component: "Icon", name: "unicorn" }] } },
  { name: "bindings must exist", expect: "error", error: "not in data", a2ui: { components: [text("root", { path: "/missing" })] } },
  { name: "a component in two places", expect: "error", error: "more than one place", a2ui: { components: [row("root", ["a", "a"]), text("a", "x")] } },
];

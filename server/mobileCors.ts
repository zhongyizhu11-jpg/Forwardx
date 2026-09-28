/*
  手机 App（Capacitor）的 WebView 源：
  - Android：capacitor.config.ts 里 androidScheme=http、hostname 默认 localhost → http://localhost
  - iOS：默认 iosScheme=capacitor → capacitor://localhost
  https://localhost / ionic://localhost 是 Capacitor/Ionic 其它配置下的默认值，一并放行。
  这些源都不带端口。

  这里的 CORS 带着 Access-Control-Allow-Credentials，放行谁就等于允许谁带着用户 Cookie 调面板 API。
  原来 http(s)://localhost:<任意端口> 全放行，用户本机任何一个本地网页/开发服务器都能以用户身份
  调用面板；生产环境只放行上面固定的 App 源，带端口的 localhost 只留给开发环境（Vite dev server、
  Capacitor live reload）。
*/
const MOBILE_APP_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "http://localhost",
  "https://localhost",
]);

export function isAllowedMobileCorsOrigin(origin: unknown, isProduction = process.env.NODE_ENV === "production") {
  const value = String(origin || "");
  if (!value) return false;
  if (MOBILE_APP_ORIGINS.has(value)) return true;
  return !isProduction && /^https?:\/\/localhost:\d+$/i.test(value);
}

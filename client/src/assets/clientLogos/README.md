# 客户端图标

**多数情况下你不需要这个目录 —— 用 `node scripts/fetch-client-logos.mjs` 把官方图标
下到服务器的数据目录即可，那条路不用重新构建、也不会把第三方商标资源打进公开的
Release 包。**

这个目录是给「就是要把图标打进构建产物」的场景准备的（比如自建分发、离线镜像）。
放这里的图标会随 `vite build` 一起打包；服务器数据目录里的同名图标优先级更高。

把图片文件丢进这个目录，「一键订阅」网格里对应客户端的图案就会自动换成它；
没放的继续用内置的几何图案。**构建时扫描，不需要改任何代码。**

## 命名

文件名必须是客户端 id，扩展名支持 `.svg` / `.png` / `.webp` / `.jpg` / `.ico`：

| 文件名 | 对应客户端 |
|---|---|
| `clash.*` | Clash / mihomo（含 Clash Verge Rev、ClashX、ClashX Meta、FlClash 等） |
| `stash.*` | Stash |
| `singbox.*` | sing-box |
| `loon.*` | Loon |
| `surge.*` | Surge |
| `quantumultx.*` | Quantumult X |
| `hiddify.*` | Hiddify |
| `shadowrocket.*` | Shadowrocket |
| `v2rayng.*` | v2rayNG |
| `surfboard.*` | Surfboard |
| `nekobox.*` | NekoBox |
| `nekoray.*` | NekoRay |
| `v2rayn.*` | v2rayN |

建议正方形、去掉圆角（界面自己会切圆角）、透明底，边长 128px 以上；
SVG 最佳，深浅色主题下都不会糊。

## 从哪儿拿

开源客户端的图标在各自仓库里，按其许可证使用：

- mihomo / Clash Meta — https://github.com/MetaCubeX/mihomo
- sing-box — https://github.com/SagerNet/sing-box
- Hiddify — https://github.com/hiddify/hiddify-app
- v2rayNG — https://github.com/2dust/v2rayNG
- v2rayN — https://github.com/2dust/v2rayN
- NekoBox — https://github.com/MatsuriDayo/NekoBoxForAndroid
- FlClash — https://github.com/chen08209/FlClash
- Clash Verge Rev — https://github.com/clash-verge-rev/clash-verge-rev

闭源的（Shadowrocket、Surge、Stash、Loon、Quantumult X）图标是各自开发者的
商标资源，仓库里不预置。要用的话自行确认用途是否合适 —— 这个面板是公开分发的
（AGPL 仓库 + GitHub Release），放进来的图会跟着一起分发出去。

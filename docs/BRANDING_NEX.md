# NEX 品牌更名

产品展示名称由 ForwardX 统一为 **NEX**。网页、文档、iOS 和 Android 使用用户提供的 NEX 黑底白字、蓝色 X 标识。

- `assets/brand/nex-logo-source.png` 保存原始图片；运行 `node scripts/prepare-brand-assets.mjs`（需要 ImageMagick）生成各平台资源。仅裁切画布留白和等比例缩放，不重画或拉伸字形。
- 空站名及旧默认站名 `ForwardX` 显示为 NEX；管理员设置的其他站名和自定义 Logo 保留。
- iOS/Android 应用展示名为 NEX；安装身份仍为 `com.forwardx.app`，允许现有应用继续升级。
- GitHub 仓库、Release 文件名、容器与服务名称、数据目录、环境变量、数据库字段、协议标识及浏览器存储键保持兼容。订阅配置中的历史分组名也保留，避免破坏已导入的客户端规则。
- 历史变更记录、许可证与上游署名保留原文。

网页更新后使用新默认图标；手机桌面名称和图标需要安装重新构建的 App。自签升级时继续使用原来的签名与应用标识。

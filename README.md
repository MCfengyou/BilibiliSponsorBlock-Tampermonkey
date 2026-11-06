# BilibiliSponsorBlock-Tampermonkey
一个脚本，用于跳过B站视频广告  从 [bsbsb.top](https://bsbsb.top/) 改写而来，仅有跳过功能

Greasy Fork地址：[BilibiliSponsorBlock-Tampermonkey](https://greasyfork.org/zh-CN/scripts/553623-bilibilisponsorblock-tampermonkey)

支持普通视频、番剧，以及以下播放列表页面：

- 稍后再看：`https://www.bilibili.com/list/watchlater`（包含 `?bvid=BV...` 参数的播放地址）。
- 收藏夹等新版播放列表：`https://www.bilibili.com/list/*`，例如 `/list/ml123456`。
- 旧版播放列表：`https://www.bilibili.com/medialist/play/*`。

列表内切换视频时会清空上一条视频的标记和提示，再加载新视频的片段；快速切换时，旧请求返回的结果不会覆盖当前视频。更新脚本后，请刷新已经打开的播放列表页面。

开发验证：`node --test tests/*.test.cjs`。

脚本会在视频进度条上显示小绿条以标注赞助部分：

<img width="1440" height="900" alt="截屏 4" src="https://github.com/user-attachments/assets/48e443aa-9a31-4718-a7ba-3a4b036d1a1b" />

跳过后的提示：

<img width="360" height="312" alt="image" src="https://github.com/user-attachments/assets/0760943c-3ab4-4ee2-9032-74a62e233b43" />

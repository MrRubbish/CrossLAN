# CrossLAN（中文说明）

最后更新时间：2026年9月5日

---

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/github/license/MrRubbish/CrossLAN)

> 在同一局域网内，用浏览器在手机和电脑之间传输文件。
>
> 不需要安装手机 App，打开服务主机地址即可发现设备并发送文件。

CrossLAN 会根据文件大小和接收目标自动选择传输路线：

- 单个文件不超过 `32 MB`：使用 WebRTC DataChannel 点对点传输。
- 大文件发送到 CrossLAN 服务主机：使用 HTTP Stream 直接写入配置目录。
- 大文件发送到手机或普通浏览器：使用有界内存 Relay，一边上传一边进入接收端浏览器下载。
- 同时选择多个文件：小文件按批次打包，大文件保持原文件并按顺序传输。

**注意：当前项目定位为可信局域网内的轻量文件互传工具。默认 HTTP 部署没有账号、权限系统和生产级传输加密，不要直接暴露到公网。**

## 目录

- [传输方式](#传输方式)
- [安装](#安装)
  - [Windows Node.js 部署](#windows-nodejs-部署)
- [使用](#使用)
  - [发送文件](#发送文件)
  - [批量传输](#批量传输)
  - [服务主机直存](#服务主机直存)
  - [取消与任务清理](#取消与任务清理)
  - [上传限速](#上传限速)
- [参数及配置](#参数及配置)
- [项目结构](#项目结构)
- [已实现的能力](#已实现的能力)

## 传输方式

| 场景 | 数据路线 | 接收结果 |
| --- | --- | --- |
| 文件 `<=32 MB` | WebRTC DataChannel | 接收端浏览器保存 |
| 多个小文件 | 无压缩 ZIP + WebRTC/HTTP | 接收一个或多个 ZIP，不自动解压 |
| 大文件发给服务主机 | HTTP 请求流直接写盘 | 保存到服务主机配置目录 |
| 大文件发给手机或普通 PC 浏览器 | HTTP 有界内存 Relay | 进入接收端浏览器下载管理器 |

WebRTC 使用 `256 KB` 文件分块和 DataChannel 高低水位背压。大文件 Relay 不会把完整文件放入服务端内存，也不使用旧式临时文件缓存；发送和下载通过受控内存窗口同步流动。

## 安装

先获取代码：

```powershell
git clone https://github.com/MrRubbish/CrossLAN.git
cd CrossLAN
```

### Windows Node.js 部署

要求：

- Node.js `20` 或更高版本。
- 发送端和接收端处于同一局域网。
- Windows 防火墙允许所用 TCP 端口，默认是 `6100`。

首次安装：

```powershell
npm install
npm run build
npm start
```

默认监听：

```text
http://0.0.0.0:6100
```

其他设备需要使用服务主机的局域网 IP，例如：

```text
http://192.168.1.20:6100
```

不要在其他设备上输入 `127.0.0.1` 或 `localhost`，它们只代表当前设备自己。

#### Windows 后台启动

双击：

```text
scripts\windows\start-local-background.cmd
```

停止或重启：

```text
scripts\windows\stop-local.cmd
scripts\windows\restart-local.cmd
```

后台启动不会每次重新构建。首次运行或修改前端代码后执行：

```powershell
npm run build
```

#### Windows 开机启动

安装当前用户的登录启动任务：

```text
scripts\windows\install-autostart.cmd
```

移除：

```text
scripts\windows\uninstall-autostart.cmd
```

默认服务主机保存目录：

```text
%USERPROFILE%\Downloads\CrossLAN
```

## 使用

### 发送文件

1. 在服务主机启动 CrossLAN。
2. 在需要互传的设备上打开 `http://<服务主机局域网 IP>:6100`。
3. 等待目标设备出现在设备列表中。
4. 点击目标设备卡，选择一个或多个文件。
5. 接收端确认后开始传输。

任务卡会显示方向、文件名、进度、当前速度、平均速度、峰值和用时。

### 批量传输

同一次文件选择会生成一个批次：

- 每个不超过 `32 MB` 的小文件会参与小文件打包。
- 每个无压缩 ZIP 批次最多 `64 MB`。
- ZIP 只用于合并文件，不额外压缩内容，避免增加浏览器 CPU 和准备时间。
- 大文件不参与浏览器端打包，按选择顺序逐个传输。
- 混合选择小文件和大文件时，它们共享同一个批次接收授权。
- CrossLAN 不自动解压接收到的 ZIP。

### 服务主机直存

当目标是服务主机直存设备卡时，大文件通过 HTTP Stream 直接写入配置目录：

- 不经过浏览器下载管理器。
- 不会被 IDM 等浏览器下载工具接管。
- 不先写入 Relay 临时文件。
- 取消或上传失败时删除未完成文件。
- 文件重名时不会覆盖已有文件。

网页“存储”区域可以修改服务主机保存目录。该设置只影响服务主机直存，不会修改手机或其他浏览器的下载目录。

### 取消与任务清理

- 发送方和接收方都可以取消活动任务。
- 取消消息会同步到另一端。
- WebRTC 会话、HTTP 上传、浏览器 Relay 下载和等待中的任务都有对应清理逻辑。
- 取消直存任务时，服务端会删除未完成文件。
- 已取消 Relay ID 会保留短期终止状态，防止移动浏览器恢复后台后重新打开旧下载。
- “清空任务”只移除已经结束、失败或取消的任务，不会静默删除仍在传输的任务。

### 上传限速

网络设置支持：

- `不限速`：默认选项。
- `手动`：单位为 `Mbps`，初始值为 `100 Mbps`。

限速作用于当前浏览器作为发送方时的上传。发送端与接收端短时间显示的速度可能不同，因为双方统计的是不同阶段，且浏览器下载缓冲、Wi-Fi 和存储写入都会影响接收速度。

## 参数及配置

### 常用环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `6100` | HTTP 和 WebSocket 服务端口 |
| `CROSSLAN_SAVE_DIR` | `~/Downloads/CrossLAN` | Node.js 服务主机直存目录 |
| `CROSSLAN_ADVERTISED_IP` | 自动判断 | 多网卡环境中向其他设备显示的服务主机 IP |
| `CROSSLAN_RELAY_TOTAL_BUFFER_MB` | `256` | 所有 Relay 会话共享的内存预算 |
| `CROSSLAN_RELAY_BUFFER_MB` | `256` | 兼容旧配置的总内存预算别名 |
| `CROSSLAN_RELAY_TARGET_MB` | `32` | Relay 正常目标缓冲 |
| `CROSSLAN_RELAY_HIGH_WATER_MB` | `64` | 单会话暂停上传的高水位 |
| `CROSSLAN_RELAY_LOW_WATER_MB` | `24` | 单会话恢复上传的低水位 |

Relay 参数会被限制为：

```text
low <= target <= high <= total
```

一般不需要修改 Relay 水位。增大缓冲不能突破手机 Wi-Fi、浏览器下载或存储写入的实际瓶颈，只会增加服务端可占用内存。

### 修改 Node.js 端口

前台启动：

```powershell
$env:PORT = "6200"
npm start
```

后台脚本：

```powershell
.\scripts\windows\start-local-background.ps1 -Port 6200
```

不要使用端口 `6000`，Chromium 系浏览器通常将其列为不安全端口并拒绝访问。项目默认使用 `6100`。

## 项目结构

```text
CrossLAN/
├─ client/
│  └─ src/
│     ├─ App.vue                     页面、设备和传输编排
│     ├─ identity/DeviceIdentity.ts  浏览器设备标识
│     ├─ signaling/                  WebSocket 客户端
│     ├─ storage/                    IndexedDB 设备记录
│     └─ transfer/                   WebRTC、批次和背压
├─ server/
│  └─ src/
│     ├─ index.js                    HTTP、直存和 Relay
│     ├─ signaling/                  设备连接和信令路由
│     ├─ relay/RelayBufferPool.js    共享内存缓冲池
│     └─ Logger.js                   服务日志
└─ scripts/
   └─ windows/                       Windows Node.js 启停脚本
```

## 已实现的能力

- 同一局域网内的浏览器设备列表和 WebSocket 实时信令。
- `<=32 MB` 文件使用 WebRTC DataChannel 点对点传输。
- WebRTC 文件分块、ACK、高低水位背压、排队和取消。
- 小文件无压缩 ZIP 批次和大小文件混合传输规划。
- 服务主机大文件 HTTP 流式直存。
- 手机和普通浏览器大文件有界内存 Relay。
- Relay 单会话水位与所有会话共享总内存预算。
- 双端取消、延迟请求拦截和未完成文件清理。
- 任务进度、平滑速度、平均速度、峰值和用时显示。
- 默认不限速、手动 `Mbps` 上传限速。
- 中文/英文界面和系统/亮色/深色外观。
- Windows 后台启动、停止、重启和当前用户开机启动脚本。

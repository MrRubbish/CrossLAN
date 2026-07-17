# CrossLAN

CrossLAN is a lightweight LAN file transfer PWA for phones and PCs on the same network. It uses WebSocket signaling, WebRTC DataChannel for smaller peer-to-peer transfers, and HTTP streaming routes for large files so browser memory is not used as the final storage buffer.

## Features

- LAN device discovery through the local signaling server and mDNS hooks.
- Files up to and including `32 MB` use peer-to-peer WebRTC DataChannel transfer with backpressure.
- Batch file selection: small files are packed into uncompressed ZIP batches; large files are sent one by one in selection order.
- Large-file direct save to disk when the receiver is the CrossLAN service host.
- Large-file browser-download relay for phone/browser receivers, streamed through server memory instead of a temporary relay file.
- Synchronized cancellation for direct-save and Relay transfers: active upload/download streams are aborted and stale cancelled links are rejected.
- Best-effort background transfer continuity with wake-lock support and Relay progress reconciliation after the page returns to the foreground.
- Transfer task cleanup and upload speed limiting. The manual speed limit is in `Mbps` and defaults to unlimited.
- System-language UI: Chinese browsers show Chinese, other languages show English.
- System dark mode support through `prefers-color-scheme`.
- Optional HTTPS server and optional HTTP to HTTPS redirect for deployments with a trusted certificate.

## Run Locally

```bash
npm install
npm run build
npm start
```

Then open `http://<PC-LAN-IP>:8080` on the PC and phone. Both devices must be on the same LAN. During development you can use:

```bash
npm run dev
```

On Windows you can use the helper script:

```powershell
.\scripts\start-local.ps1
```

Optional parameters:

```powershell
.\scripts\start-local.ps1 -Port 8080 -SaveDir "$env:USERPROFILE\Downloads\CrossLAN" -RelayBufferMb 256
```

In local Node deployment, device cards are real browser clients. The browser running on the service host can receive files as a normal device, and large files sent to the service host direct-save card are written to the configured save directory.

## Docker

```bash
docker compose up -d --build
```

On Windows PowerShell:

```powershell
.\scripts\start-docker.ps1
```

The compose file maps the PC save directory to `~/Downloads/CrossLAN` on Windows-style hosts and `/data/CrossLAN` inside the container. It publishes host port `8080` to the container service. Open `http://<host-LAN-IP>:8080` from other devices on the same LAN.

Optional Docker script parameters:

```powershell
.\scripts\start-docker.ps1 -Port 8080 -RelayBufferMb 256
```

If Docker cannot pull `node:20-alpine`, configure Docker Desktop registry/proxy or build after the network can reach Docker Hub. The app code itself does not require Docker to run; local `npm run build && npm start` is fine.

After frontend or server code changes, rebuild the image:

```bash
docker compose up -d --build
```

Docker deployment sets `CROSSLAN_DEPLOYMENT=docker`. In this mode, CrossLAN advertises the Docker service host as one direct-save device card and hides the host browser UI from other devices, so sending to the service host avoids browser/IDM download interception and writes into the mapped save directory. If an old browser-download host card still appears after an update, close old tabs or force refresh the page. On the host PC you can also open:

```text
http://<host-LAN-IP>:8080/?serviceHost=1
```

## Device Cards

- Local Node mode: cards represent real browser clients.
- Docker mode: the service host is shown as a virtual direct-save card; the host browser tab is treated as a control UI and should not be advertised as a browser-download receiver.
- Other phones and PCs still appear as normal browser receivers.
- A `Direct save` card means large files are streamed to the service host save directory. A `Browser receive` card means large files are handed to that receiver's browser download manager.

## HTTPS And Redirects

CrossLAN follows the same deployment principle used by PairDrop-style LAN web transfer tools: HTTPS is recommended when you want browser download behavior without security prompts, but HTTP remains the default for simple LAN use.

Optional built-in HTTPS:

```powershell
$env:CROSSLAN_HTTPS_KEY="D:\certs\crosslan.key"
$env:CROSSLAN_HTTPS_CERT="D:\certs\crosslan.crt"
$env:HTTPS_PORT="8443"
npm start
```

Optional HTTP to HTTPS redirect:

```powershell
$env:CROSSLAN_HTTP_REDIRECT="1"
npm start
```

Do not enable redirect until the phone trusts the certificate. A self-signed certificate that the phone does not trust can be worse than plain HTTP because the browser will block or warn on downloads.

Docker environment variables:

```yaml
environment:
  CROSSLAN_HTTPS_KEY: /certs/crosslan.key
  CROSSLAN_HTTPS_CERT: /certs/crosslan.crt
  HTTPS_PORT: 8443
  CROSSLAN_HTTP_REDIRECT: "1"
volumes:
  - ./certs:/certs:ro
```

## File Saving Model

- Service-host large files: the sender uploads to `/api/transfers/direct`; the server streams the request directly to the configured save directory.
- Phone/browser large files: the receiver opens `/api/transfers/relay/:transferId/:fileName` as a browser download, while the sender uploads to `/api/transfers/relay/:transferId`; the server pipes both sides through a bounded memory stream.
- Files up to and including `32 MB`: WebRTC DataChannel transfers chunks in memory and hands the completed file to the browser download flow.
- Multiple selected files of at most `32 MB` each are packed into uncompressed `.zip` batches of at most `64 MB`, so the receiver confirms once per small batch. Larger files are sent sequentially as original files. CrossLAN does not auto-unzip the batch on the receiver.

The large-file HTTP paths stream data and do not intentionally buffer the whole file in frontend memory.
For PC-to-phone browser downloads, the sender's upload speed is naturally back-pressured by the phone download speed. Relay uses explicit high/low-water flow control: each session normally targets `32` MB, pauses at `64` MB, and resumes after draining to `24` MB. All active Relay sessions share a `256` MB memory budget, so several slow receivers cannot each allocate an independent 256 MB buffer.

Relay memory settings:

- `CROSSLAN_RELAY_TOTAL_BUFFER_MB`: total budget shared by all active Relay sessions; default `256`.
- `CROSSLAN_RELAY_BUFFER_MB`: backward-compatible alias for the total budget.
- `CROSSLAN_RELAY_TARGET_MB`: normal backlog target exposed to paced clients; default `32`.
- `CROSSLAN_RELAY_HIGH_WATER_MB`: per-session pause threshold; default `64`.
- `CROSSLAN_RELAY_LOW_WATER_MB`: per-session resume threshold; default `24`.
- `CROSSLAN_RELAY_CANCEL_TOMBSTONE_TTL_MS`: how long a cancelled Relay ID remains blocked; default `1800000` ms (30 minutes).

The limits are clamped to `low <= target <= high <= total`. `-RelayBufferMb` in the PowerShell helpers configures the shared total budget.
The old relay temporary disk cache path is not used for large browser-download relay transfers.

Small batch ZIP packaging is done in the sender browser before transfer. It is intentionally limited to small batches because the generated `.zip` exists as a browser-side file before being sent.

## Cancellation And Background Tabs

- Cancelling either side sends a peer cancellation signal and calls the matching server cleanup endpoint.
- Direct-save cancellation stops the request and removes an incomplete destination file. Relay cancellation closes the sender upload, receiver download response, and in-memory session.
- Cancelled Relay IDs are temporarily retained as tombstones so a restored phone tab or delayed browser request cannot reopen an old download.
- CrossLAN keeps active transfers attached when a tab is hidden and reconciles Relay byte counts when the page becomes visible or connectivity returns. Mobile browsers and operating systems may still suspend a background tab, so background operation is best effort rather than a service-level guarantee.

## PC Save Directory

The service-host save path can be changed in the Storage panel. This setting applies only to files sent to the CrossLAN service host direct-save card. It does not change another browser's normal Downloads folder.

By default it is:

```text
%USERPROFILE%\Downloads\CrossLAN
```

For Docker the default container path is:

```text
/data/CrossLAN
```

The default Docker compose maps this to:

```text
%USERPROFILE%\Downloads\CrossLAN
```

## Speed Limit

The Network panel can limit upload speed from the current browser. The unit is `Mbps`; manual mode starts at `100 Mbps`, and the default mode is unlimited.

The limit is applied at the sender upload path. Browser-download receive speed is still affected by the receiver browser, phone storage, Wi-Fi quality, and router performance.

## Updating The App

The app unregisters stale Service Workers and clears old caches on startup, but browsers can still keep an old tab alive. After rebuilding or updating:

```text
PC: Ctrl+F5
Phone: close the tab, reopen CrossLAN, or use the browser refresh menu
```

## Release Checks

Before publishing:

```bash
npm run check
npm run build
```

## Architecture

- `client/src/identity/DeviceIdentity.ts`: device identity based on the server-reported LAN address.
- `client/src/storage/DeviceStore.ts`: IndexedDB cache for known devices.
- `client/src/transfer/TransferEngine.ts`: WebRTC signaling, chunked file reads, DataChannel backpressure, progress, and cleanup.
- `server/src/signaling/SignalingHub.js`: multi-tab aware WebSocket signaling and transfer-route tracking.
- `server/src/index.js`: static app server, storage API, large-file direct/relay HTTP streaming, optional HTTPS.
- `server/src/relay/RelayBufferPool.js`: per-session watermarks and the shared Relay memory budget.
- `server/test/RelayBufferPool.test.js`: focused capacity, backpressure, fairness, and cancellation tests for Relay buffering.
- `server/src/discovery/MdnsDiscovery.js`: Bonjour/mDNS advertisement hooks.
- `server/src/network/NetworkProber.js`: reserved network diagnostics API.

## Resource Rules

- WebRTC file reads use `Blob.slice()` chunks and DataChannel backpressure.
- Large HTTP uploads stream either to the configured PC save directory or through a bounded in-memory relay stream for browser downloads.
- DOM progress updates are throttled.
- File payloads are not cached by the Service Worker.
- WebRTC connections are created only when a user starts a transfer.

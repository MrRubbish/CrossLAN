# CrossLAN

CrossLAN is a lightweight LAN file transfer PWA for phones and PCs on the same network. It uses WebSocket signaling, WebRTC DataChannel for smaller peer-to-peer transfers, and HTTP streaming routes for large files so browser memory is not used as the final storage buffer.

## Features

- LAN device discovery through the local signaling server and mDNS hooks.
- Small-file peer-to-peer transfer with WebRTC DataChannel backpressure.
- Batch file selection: small files are packed into uncompressed ZIP batches; large files are sent one by one in selection order.
- Large-file direct save to PC disk when the receiver is a desktop/server device.
- Large-file browser-download relay for phone receivers, streamed through server memory instead of a temporary relay file.
- Cancellable large-file transfers: cancelling aborts the active HTTP upload and notifies the peer.
- System-language UI: Chinese browsers show Chinese, other languages show English.
- Optional HTTPS server and optional HTTP to HTTPS redirect for deployments with a trusted certificate.
- Built-in diagnostics panel for transfer and signaling logs.

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

## Docker

```bash
docker compose up --build
```

The compose file maps the PC save directory to `~/Downloads/CrossLAN` on Windows-style hosts and `/data/CrossLAN` inside the container. The service uses `network_mode: host` because LAN discovery, local IP detection, and phone-to-PC access work best when the container shares the host network.

If Docker cannot pull `node:20-alpine`, configure Docker Desktop registry/proxy or build after the network can reach Docker Hub. The app code itself does not require Docker to run; local `npm run build && npm start` is fine.

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

- Phone to PC large files: the browser uploads to `/api/transfers/direct`; the server streams the request directly to the configured PC save directory.
- PC to phone large files: the phone opens `/api/transfers/relay/:transferId/:fileName` as a browser download, while the sender uploads to `/api/transfers/relay/:transferId`; the server pipes both sides through a bounded memory stream.
- Small files: WebRTC DataChannel transfers chunks in memory and hands the completed file to the browser download flow.
- Multiple selected small files are packed into uncompressed `.zip` batches so the receiver confirms once per small batch. Files larger than 8 MB, or batches beyond 64 MB total, are sent sequentially as original files instead of being packed.

The large-file HTTP paths stream data and do not intentionally buffer the whole file in frontend memory.
For PC-to-phone browser downloads, the sender's upload speed is naturally back-pressured by the phone download speed. The relay memory buffer defaults to `128` MB and can be tuned with `CROSSLAN_RELAY_BUFFER_MB`; a larger buffer absorbs short Wi-Fi stalls, but can also make upload progress look more bursty because the PC fills the buffer and then waits for the phone/browser download path.

## PC Save Directory

The PC save path can be changed in the Storage panel. By default it is:

```text
%USERPROFILE%\Downloads\CrossLAN
```

For Docker the default container path is:

```text
/data/CrossLAN
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
- `server/src/discovery/MdnsDiscovery.js`: Bonjour/mDNS advertisement hooks.
- `server/src/network/NetworkProber.js`: reserved network diagnostics API.

## Resource Rules

- WebRTC file reads use `Blob.slice()` chunks and DataChannel backpressure.
- Large HTTP uploads stream either to the configured PC save directory or through a bounded in-memory relay stream for browser downloads.
- DOM progress updates are throttled.
- File payloads are not cached by the Service Worker.
- WebRTC connections are created only when a user starts a transfer.

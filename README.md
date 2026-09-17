# Duo — private 1:1 messenger

End-to-end encrypted messaging, file sharing and WebRTC voice/video calls for exactly two people.
One small Node server + one installable PWA. No accounts, no phone number, no email.

Once it's hosted you get **one normal https link**. Send it to the other person, and both of you
can add it to your phone's home screen where it behaves like a real app.

---

## Fastest way to get a link (Render — free, ~5 minutes)

1. Put this folder in a GitHub repo (drag the files into a new repo on github.com — no git needed).
2. Go to **render.com** → New → **Web Service** → connect that repo.
3. Settings: Runtime **Node**, Build command `npm install`, Start command `npm start`.
4. Add a **Disk** (Advanced → Add Disk), mount path `/data`, size 1 GB, and an environment
   variable `DATA_DIR=/data`. This keeps messages and files across restarts.
5. Deploy. You get something like `https://duo-xxxx.onrender.com` — that's your link.

Free Render services sleep when idle and take ~30 seconds to wake. **Railway**, **Fly.io** and
**Koyeb** work the same way without sleeping.

### Other options

| Where | How |
|---|---|
| Any VPS (DigitalOcean, Hetzner, Oracle free tier) | `npm install && npm start`, then put Caddy or nginx in front for HTTPS |
| Your own PC, on your home Wi-Fi only | `npm install && npm start`, open `http://<your-local-ip>:3000` |
| Temporary public link from your PC | run it, then `npx localtunnel --port 3000` (or Cloudflare Tunnel) |

**HTTPS is required** for camera, microphone and encryption on any address other than
`localhost`. All the hosts above give it to you automatically.

---

## Installing it on your phone

Open the link in the phone browser, then:

- **Android / Chrome** — menu ⋮ → *Install app* / *Add to Home screen*
- **iPhone / Safari** — Share button → *Add to Home Screen*

It then opens full screen with its own icon, remembers your login, and works over Wi-Fi or
mobile data automatically.

---

## Connecting the two of you

1. First person opens the link, types a username → gets an **invitation link** (`…/#i=code`).
2. Send that to the second person however you like.
3. They open it, pick a username, tap **Send connection request**.
4. First person taps **Accept**. Done — you're paired, and neither of you can be paired with
   anyone else until one of you disconnects (⋮ in the chat header).

---

## What's inside

```
server.js            Express + WebSocket server (messages, invites, files, call signalling)
public/index.html    The whole app (UI, crypto, WebRTC) — one file
public/sw.js         Service worker, makes it installable and openable offline
public/manifest.json PWA manifest
data/                Created at runtime: db.json + encrypted uploads
```

### Security notes

- Each device generates an **ECDH P-256** keypair; only the public key is uploaded.
  A shared **AES-GCM-256** key is derived per pair and never leaves the browsers.
- Message text and file bytes are encrypted **before** they're sent. The server stores
  ciphertext only — reading `data/db.json` shows nothing readable.
- Files are served only to the two paired users, over an authenticated endpoint. They're
  never in a public directory.
- Signing out wipes the device key by design, so old messages stop being readable there.
- Disconnecting deletes the conversation and every shared file for both sides.

### Calls

WebRTC media is peer-to-peer and encrypted by DTLS-SRTP; the server only relays the
offer/answer/ICE messages. Public STUN servers are configured. If both of you are behind
strict mobile-carrier NAT the call may fail to connect — add a TURN relay in `public/index.html`:

```js
const ICE = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: 'turn:YOUR_TURN_HOST:3478', username: 'user', credential: 'pass' }
];
```

Self-host [coturn](https://github.com/coturn/coturn), or use a paid service (Metered, Twilio).

### Limits

- Uploads capped at 24 MB per file (`MAX_UPLOAD` in `server.js`).
- Notifications appear while the app is open in the background. True push notifications when
  the app is fully closed need VAPID Web Push keys — the service worker is already in place
  if you want to add that later.
- Storage is a JSON file, which is right for two users. Swap in SQLite if you ever grow it.

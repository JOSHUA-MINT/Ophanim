# Ophanim

A zero-knowledge, end-to-end encrypted messenger that runs entirely in the browser. Keypairs are generated client-side (ECC Curve25519), private keys never leave `localStorage` on your device, and every message is encrypted to the recipient's public key before it touches the network. The relay server sees ciphertext and nothing else — no accounts, no database, no message persistence.

## Tools

| Page | Does |
|---|---|
| `keys.html` | Generate a Curve25519 keypair, manage contacts, back up keys |
| `encrypt.html` | Encrypt a message to a recipient's public key |
| `decrypt.html` | Decrypt a message with your private key + passphrase |
| `chat.html` | Live encrypted rooms over Socket.IO, with mandatory fingerprint verification and a kill switch |

## Stack

- **Client**: static HTML/CSS/JS, no framework, no build step. Crypto via [OpenPGP.js](https://openpgp.js.org/).
- **Server**: `server/` — a small Express + Socket.IO relay (`ophanim-relay`) that forwards ciphertext between clients and stores nothing beyond an in-memory room list.

## Running locally

```bash
cd server
npm install
npm start        # relay + static client on http://localhost:3000
```

Open `index.html` directly, or via the relay's static server, in a browser.

## Deployment

The client and server deploy separately:

- **Frontend** (`index.html`, `encrypt.html`, `decrypt.html`, `keys.html`, `chat.html`, `src/`, `public/`) — deploy as a static site, e.g. [Vercel](https://vercel.com).
- **Backend** (`server/`) — deploy as a persistent Node service, e.g. [Render](https://render.com), since Socket.IO needs a long-lived process rather than serverless functions.

When the two are on different domains, update:
- `chat.html`'s `SERVER_URL` to point at the deployed relay's URL.
- `chat.html`'s CSP `connect-src` to allow that URL (`wss://` and `https://`).
- The relay's `ALLOWED_ORIGIN` environment variable to the deployed frontend's URL (for CORS).

## Documentation

See [`Documents/`](Documents/) for the full user guide, project report, and PRD:

- [`Documents/GUIDE.md`](Documents/GUIDE.md) — the complete manual: what PGP is, how to use every page, the cryptography behind it, and its honest limitations.
- [`Documents/PROJECT_REPORT.md`](Documents/PROJECT_REPORT.md) — architecture, trust boundaries, message lifecycle, and a codebase map.
- [`Documents/PRD_REPORT.md`](Documents/PRD_REPORT.md) — product requirements and feature status.

## Security notes

- Private keys are encrypted at rest with your passphrase and never transmitted.
- Chat requires out-of-band fingerprint verification before messages can be sent, to prevent key-substitution attacks by a malicious relay.
- This is a one-person project, not an audited product. For situations where the stakes are real, use an audited desktop tool such as Kleopatra/GnuPG instead — see `Documents/GUIDE.md` for details.

## License

No license file is currently included; all rights reserved by the author unless stated otherwise.

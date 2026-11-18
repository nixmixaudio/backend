# NixMix Audio backend

This directory is the standalone backend for the NixMix Audio frontend. It can
run locally as Node/Express and in Cloudflare Workers through `worker.js` and
Cloudflare's `httpServerHandler`.

## Deploy

Run locally from this directory:

```bash
npm install
npm start
```

Deploy the Worker with:

```bash
npm run deploy
```

Set the variables in `.env.example` in the hosting provider. In particular,
`ADMIN_PASSWORD`, `SESSION_SECRET`, `API_PUBLIC_URL`, `FRONTEND_URL`, and the
Google, SMTP, Razorpay, and persistent-storage settings must be configured.

The frontend must be built with `VITE_API_URL` set to `API_PUBLIC_URL`.

## Cloudflare Worker migration

`wrangler.jsonc` contains the D1 and R2 bindings. The Worker adapter is now in
`worker.js`. The data layer still needs to be migrated from local JSON/filesystem
storage to D1/R2 before production data is persistent on Workers.

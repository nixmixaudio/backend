# NixMix Audio backend

This directory is the standalone Express backend for the NixMix Audio frontend.

## Deploy

Run from this directory:

```bash
npm install
npm start
```

Set the variables in `.env.example` in the hosting provider. In particular,
`ADMIN_PASSWORD`, `SESSION_SECRET`, `API_PUBLIC_URL`, `FRONTEND_URL`, and the
Google, SMTP, Razorpay, and persistent-storage settings must be configured.

The frontend must be built with `VITE_API_URL` set to `API_PUBLIC_URL`.

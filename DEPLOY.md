# DEPLOY — first-time Cloudflare setup (mobile)

You only do the dashboard part ONCE. After that: edit code on GitHub → auto-deploys.

## 0. Push this repo to GitHub
Repo `nano-banana-mcp` — files uploaded via GitHub web UI.

## 1. Create the Worker from GitHub
1. dash.cloudflare.com → **Compute (Workers)** (or "Workers & Pages").
2. **Create** → choose **Import a repository** / **Connect to Git**.
3. Authorise GitHub if asked → pick **nano-banana-mcp**.
4. Build settings:
   - **Deploy command:** `npx wrangler deploy`
   - Build command: leave default / empty (CF runs `npm install`).
5. **Save and Deploy.** First deploy may warn about missing secrets — fine.

## 2. Set the secrets
Worker → **Settings** → **Variables and Secrets** → **Add** (type: *Secret*, "Encrypt"):

| Name | Value |
|---|---|
| `MCP_AUTH_TOKEN` | a random 64-char token (generate and save in KeePassDX) |
| `GEMINI_API_KEY` | your Google AI Studio / Gemini API key |

## 3. Redeploy so secrets take effect
Worker → **Deployments** → **... → Retry deployment** (or push any commit).

## 4. Get your URL
Worker → **Settings** → find the `*.workers.dev` URL. Your connector URL is:
```
https://nano-banana-mcp.<subdomain>.workers.dev/<MCP_AUTH_TOKEN>/mcp
```

## 5. Add as a Claude.ai custom connector
Claude.ai → Settings → Connectors → Add custom connector → paste the URL above.

## Forever after (no dashboard)
- Change behaviour → edit code on GitHub → auto-deploys.

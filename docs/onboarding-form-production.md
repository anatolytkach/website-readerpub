# ReaderPub Onboarding Form Production Setup

The onboarding form in `src/pages/contact.astro` submits to the Cloudflare Pages Function at:

```text
POST /api/onboarding
```

The function validates the form, optionally verifies Cloudflare Turnstile, sends an internal notification email, and sends an auto-reply to the requester.

## Cloudflare Pages Environment Variables

Email provider:

```text
PINGRAM_API_KEY
PINGRAM_CLIENT_ID
PINGRAM_CLIENT_SECRET
PINGRAM_API_BASE_URL
NOTIFICATIONAPI_BASE_URL
PINGRAM_SENDER_NAME
PINGRAM_SENDER_EMAIL
```

Use either `PINGRAM_API_KEY` or both `PINGRAM_CLIENT_ID` and `PINGRAM_CLIENT_SECRET`.

Website onboarding:

```text
ONBOARDING_TO_EMAIL
ONBOARDING_REPLY_TO_EMAIL
ONBOARDING_SITE_NAME
ONBOARDING_SITE_URL
ONBOARDING_LOGO_URL
```

`ONBOARDING_SITE_URL` and `ONBOARDING_LOGO_URL` are optional. If `ONBOARDING_LOGO_URL` is not set, the requester auto-reply uses `/images/small-logo.jpg` on the current site origin.

Turnstile:

```text
PUBLIC_TURNSTILE_SITE_KEY
TURNSTILE_SECRET_KEY
```

`PUBLIC_TURNSTILE_SITE_KEY` is public and is embedded into the built contact page. `TURNSTILE_SECRET_KEY` must stay server-side in Cloudflare Pages environment variables.

Turnstile is optional in the function. If `TURNSTILE_SECRET_KEY` is not configured, the function skips Turnstile verification and still uses validation plus the `_gotcha` honeypot. If `TURNSTILE_SECRET_KEY` is configured, the frontend build must also include `PUBLIC_TURNSTILE_SITE_KEY`, or submissions will fail verification.

## Build And Deploy

Build the static Astro site:

```powershell
$env:ASTRO_TELEMETRY_DISABLED='1'
npm run build
```

Deploy with Wrangler:

```powershell
$env:WRANGLER_LOG_PATH='.\.wrangler-logs'
npx wrangler pages deploy dist --project-name <cloudflare-pages-project-name>
```

## Manual Test Steps

1. Open `/contact`.
2. Open the onboarding modal.
3. Submit with missing required fields and confirm the browser or API keeps the modal open.
4. Submit with an invalid email and confirm an inline error appears.
5. Submit with `_gotcha` filled by a manual POST and confirm `{ "ok": true }` is returned without sending mail.
6. Submit with missing provider env vars and confirm the API returns `{ "ok": false, "error": ... }`.
7. Submit a valid request with provider env vars set and confirm:
   - the internal notification arrives at `ONBOARDING_TO_EMAIL`
   - the requester receives the auto-reply
   - the success modal appears only after the API response succeeds

Example PowerShell POST without Turnstile:

```powershell
Invoke-WebRequest -Uri "https://staging.reader.pub/api/onboarding" -Method Post -Body @{
  role = "Author"
  name = "Test Author"
  email = "test@example.com"
  project = "Testing the ReaderPub onboarding form."
  needs = "Web publishing"
} -UseBasicParsing
```

When `TURNSTILE_SECRET_KEY` is configured, use the browser form so Cloudflare Turnstile can generate a valid `cf-turnstile-response`.

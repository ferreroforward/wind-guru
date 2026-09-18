# Deploying the report Worker

This is the one piece of the app that isn't a static file — a tiny
Cloudflare Worker that receives the report-popup submission from
`index.html` and files it as a GitHub issue, the same way the old
GitHub-hosted form did, but without sending the visitor to GitHub or
requiring them to have an account. It's free (Cloudflare's free tier is
100,000 requests/day — this app will never get close) and takes about
10 minutes to set up the first time.

You'll do two things: create a fine-grained GitHub token, and deploy the
Worker using it. Dashboard-only steps below — no command line needed.

## 1. Create a GitHub token scoped to just this repo

1. Go to <https://github.com/settings/personal-access-tokens/new> (you'll
   need to be signed in to the `ferreroforward` GitHub account).
2. **Token name**: `wind-guru-report-worker` (or anything memorable).
3. **Expiration**: your choice — a long one (e.g. 1 year) is fine since
   this token can only touch one repo's issues; just put a reminder
   somewhere to renew it before it expires, since an expired token makes
   the popup silently fall back to the old GitHub-issue-form link.
4. **Repository access**: "Only select repositories" → pick
   `ferreroforward/wind-guru`.
5. **Permissions** → **Repository permissions** → **Issues**: set to
   **Read and write**. Leave every other permission at "No access" —
   this token should not be able to touch code, settings, or anything
   else in the repo.
6. Click **Generate token**, then copy it immediately (GitHub only shows
   it once). Paste it somewhere safe for step 2.4 below.

## 2. Deploy the Worker (dashboard only, no CLI)

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account
   (email + password, no credit card needed for the free tier).
2. Once logged in, go to **Workers & Pages** in the left sidebar →
   **Create** → **Workers** → **Create Worker** (previously called
   "Quick edit" — the flow may say something slightly different
   depending on when you're reading this, but "create a Worker from
   scratch" is the option you want).
3. Give it the name `wind-guru-reports` (this becomes part of the
   Worker's URL: `wind-guru-reports.<your-subdomain>.workers.dev`).
   Deploy it once with the placeholder starter code — you'll replace it
   next.
4. Open the Worker → **Edit code** (this opens Cloudflare's in-browser
   editor). Delete everything there and paste in the full contents of
   `index.js` from this folder. Click **Deploy** (or **Save and Deploy**).
5. Go to the Worker's **Settings** tab → **Variables and Secrets**:
   - Add a variable named `ALLOWED_ORIGIN`, type **Text**, value
     `https://ferreroforward.github.io` (or your custom domain if the
     site has moved — see the note in `wrangler.toml`).
   - Add a variable named `GITHUB_TOKEN`, type **Secret**, and paste the
     token from step 1.6.
   - Save.
6. Copy the Worker's URL from the top of its dashboard page — it looks
   like `https://wind-guru-reports.<something>.workers.dev`.

## 3. Point the site at the deployed Worker

In `index.html`, find this line (search for `WORKER_URL`):

```js
const WORKER_URL = "https://wind-guru-reports.YOUR-SUBDOMAIN.workers.dev";
```

Replace it with the real URL from step 2.6, commit, and push. That's it —
the report popup will now submit directly instead of falling back to the
GitHub link.

## Testing it

Open the site, click "Report actual conditions" on any spot, enter a
speed, and submit. Check
<https://github.com/ferreroforward/wind-guru/issues?q=is%3Aissue+label%3Awind-report>
— a new issue should appear within a few seconds, formatted exactly like
one filed through the old GitHub form. If it doesn't, open your browser's
dev tools console on the site — `submitReport()` in `index.html` logs the
failure there, and the on-page message will say "Couldn't submit right
now" with a fallback GitHub link, which tells you the Worker call itself
failed (wrong URL, CORS, or a bad/expired token) rather than something on
the GitHub side.

## Alternative: deploying with the `wrangler` CLI

If you'd rather work from a terminal: `npm install -g wrangler`, then
from this `worker/` folder run `wrangler login`, `wrangler deploy`, and
`wrangler secret put GITHUB_TOKEN` (paste the token when prompted). The
`ALLOWED_ORIGIN` var in `wrangler.toml` is deployed automatically. This
skips steps 2.2–2.5 above but does the same thing.

## If you ever need to change the GitHub token

Repos → Settings → Variables and Secrets on the Worker, update
`GITHUB_TOKEN`, save. No redeploy of the code needed.

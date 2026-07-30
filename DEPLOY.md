# Cross-Channel Control Room — Deploy to GCP Cloud Run

A single Node service that serves the dashboard and proxies live pulls from
Windsor.ai. No BigQuery, no cache, no LLM in the refresh path. The Windsor API
key stays server-side; the team reaches it through Google sign-in.

## What you need once

- A GCP project (note its ID, e.g. `bkh-marketing`)
- The `gcloud` CLI installed and logged in (`gcloud auth login`)
- Your Windsor.ai API key from https://onboard.windsor.ai

Set your project:

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com
```

### Which of the many GCP APIs this project actually needs

Enable only these: **Cloud Run, Secret Manager, Artifact Registry, Cloud Build,
IAM** (the line above), plus **Model Armor** if you want prompt screening (below).
**Cloud Logging, Monitoring and Trace** you likely already have on — the app emits
structured logs that light them up automatically, no code from you.

You do **not** need Vertex AI Agent Platform / Agent Registry, App Hub, App
Topology, Compute Engine, Dataform, Notebooks, Security Command Center, Network
Security/Services, or Text-to-Speech for this service. (Agent Platform would be
relevant only if a future v.3 becomes genuinely agentic; this one is deterministic
by design.)

## 1. Store your keys as secrets (never in code)

```bash
printf "YOUR_WINDSOR_API_KEY" | gcloud secrets create windsor-api-key \
  --data-file=- --replication-policy=automatic

# v.2 Topic Explorer needs an Anthropic key too
printf "YOUR_ANTHROPIC_API_KEY" | gcloud secrets create anthropic-api-key \
  --data-file=- --replication-policy=automatic
```

To rotate later: `printf "NEW_KEY" | gcloud secrets versions add windsor-api-key --data-file=-`

## 2. Deploy from source

From inside the project folder (the one with `Dockerfile`):

```bash
gcloud run deploy control-room \
  --source . \
  --region asia-southeast1 \
  --set-secrets WINDSOR_API_KEY=windsor-api-key:latest,ANTHROPIC_API_KEY=anthropic-api-key:latest \
  --cpu 1 --memory 512Mi \
  --timeout 120 \
  --no-allow-unauthenticated
```

Optional: pin the model with `--set-env-vars ANTHROPIC_MODEL=claude-sonnet-4-6`
(default is `claude-sonnet-4-6`; set it to whatever your API access allows).

- `asia-southeast1` is Singapore — lowest latency from Bangkok.
- `--timeout 120` gives slow connector pulls headroom (they run in parallel, so this is generous).
- `--no-allow-unauthenticated` means it is NOT public — only identities you grant can open it. That is what makes the next step a real access gate.

Cloud Build packages the container and deploys it. You'll get a service URL like
`https://control-room-xxxx.asia-southeast1.run.app`.

## 3. Give your team access

Two ways, pick one.

### Option A — grant Google accounts directly (simplest)

Each teammate opens the URL while signed into their Google account, and you grant
them the run.invoker role:

```bash
# one person
gcloud run services add-iam-policy-binding control-room \
  --region asia-southeast1 \
  --member="user:teammate@bangkokhospital.com" \
  --role="roles/run.invoker"

# or the whole Workspace domain at once
gcloud run services add-iam-policy-binding control-room \
  --region asia-southeast1 \
  --member="domain:bangkokhospital.com" \
  --role="roles/run.invoker"
```

With this, opening the raw `run.app` URL requires the visitor to be signed in and
authorized. Good enough for an internal team tool.

### Option B — Identity-Aware Proxy behind a nice URL (more polished)

If you want a branded hostname and a login page rather than the raw run.app URL,
put it behind a load balancer + IAP. This is more setup; do Option A first and
only move to B if you need the custom domain. Google's guide:
https://cloud.google.com/iap/docs/enabling-cloud-run

## 4. Test it

Open the service URL, sign in, pick a 30-day range, hit **Pull fresh data**.
You should see spend, organic, GMB, Search Console and LINE populate. Anything
with no data for the range shows up in the footer note rather than as a fake zero.

## Optional — Model Armor prompt screening (recommended for hospital use)

Screens the user-typed topic for prompt injection / jailbreak attempts before it
reaches Claude. The app runs fine without it; when the two env vars are set, it
turns on automatically and fails *open* on a Model Armor outage (logged) so it
can't take the feature down.

```bash
gcloud services enable modelarmor.googleapis.com

# Create a template with the default filters (or build one in the console:
# Security → Model Armor → Create Template). Use a region that supports it,
# e.g. asia-southeast1.
gcloud model-armor templates create bkh-topic-guard \
  --location=asia-southeast1 \
  --rai-settings-filters='[{"filterType":"dangerous","confidenceLevel":"medium_and_above"}]' \
  --basic-config-filter-enforcement=enabled

# Let the Cloud Run runtime service account call Model Armor
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${PROJNUM}-compute@developer.gserviceaccount.com" \
  --role="roles/modelarmor.user"
```

Then redeploy with the two extra env vars (add to the Step 2 command):

```bash
  --set-env-vars MODEL_ARMOR_LOCATION=asia-southeast1,MODEL_ARMOR_TEMPLATE=bkh-topic-guard
```

Put the Model Armor region the same as Cloud Run (`asia-southeast1`) so screening
adds ~50–200ms over Google's backbone rather than a cross-region round trip.

## Observability — nothing to configure

Every request emits a structured JSON log line (method, path, status, latency)
that Cloud Logging parses automatically, with a `logging.googleapis.com/trace`
field so entries link to Cloud Trace. View them:

```bash
gcloud run services logs tail control-room --region asia-southeast1
```

In the console, Logs Explorer, Trace, and Monitoring pick these up with no extra
setup. You can build a latency/error dashboard in Monitoring straight from them.

Cloud Run scales to zero — you pay only while requests are being served. A small
internal dashboard like this typically lands in the free tier or a few dollars a
month. Secret Manager is effectively free at this volume.

## Updating the dashboard later

Change a file, then re-run the same deploy command from step 2. Each deploy is a
new revision with instant rollback in the Cloud Run console.

## Where things live (so you can hand this off)

| File | Role |
|------|------|
| `server.js` | Express app: `/api/sync` aggregator + static serving |
| `public/index.html` | The dashboard UI (calls `/api/sync`) |
| `Dockerfile` | How Cloud Run builds the container |
| `.env.example` | Local dev only — real key goes in Secret Manager |

## Local dev (optional)

```bash
npm install
WINDSOR_API_KEY=your_key node server.js
# open http://localhost:8080
```

## The field mapping (so future-you knows what's aggregated)

| Channel | Connector | Fields pulled | Dashboard metric |
|--------|-----------|---------------|------------------|
| Meta Ads | `facebook` | date, account_name, spend, impressions, clicks | Spend, impressions, clicks, top accounts |
| FB organic | `facebook_organic` | date, page_impressions, post_engagements | Organic reach + engagement |
| TikTok organic | `tiktok_organic` | date, video_views, likes, comments, shares | Folded into organic reach + engagement |
| GMB | `google_my_business` | date, location_title, impressions, call_clicks, website_clicks, direction_requests | Views, actions, per-location table |
| Search Console | `searchconsole` | date/clicks/impressions/position + query-level | Clicks, impr, CTR, avg position, top queries (auto language-tagged) |
| LINE | `line` | date, message__broadcast, message__targeting, message__api_push, followers__followers | Messages sent, new friends |

Search-query language tags (AR/JA/ZH/MY/KM/TH/EN) are inferred server-side from
the query's script in `detectLang()` — adjust there if you want finer buckets.

## Memory: bump to 1Gi (v3.2 requirement)

Topic Explorer pulls large Search Console result sets. At the default 512Mi the
container could be OOM-killed mid-request, which surfaces in the browser as a
bare **Cloud Run 503 Service Unavailable** (not a JSON error from the app —
that's the tell). v3.2 splits the Search Console query into two narrower calls,
but give it headroom anyway:

Console: Cloud Run → service → **Edit & deploy new revision** → Container →
set **Memory** to `1 GiB`, **Request timeout** to `300` seconds → Deploy.

CLI equivalent:

```bash
gcloud run services update control-room --region asia-southeast1 \
  --memory 1Gi --timeout 300
```

Optionally add `--min-instances=1` to keep the in-memory cache warm so the first
load each morning isn't a cold start.

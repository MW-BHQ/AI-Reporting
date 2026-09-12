# BHQ War Room — handover at v3.284.0

Written because the previous session's judgement had visibly degraded: a working
feature was removed by over-thinking, a units regression shipped, and two test
assertions turned out to assert nothing. Read the four open items first — they
are corrections MW asked for and they are all specified precisely enough to just
do.

## Where things are

- Repo `MW-BHQ/AI-Reporting`, branch `main`, working dir `/home/claude/bkh/`.
- Auto-deploys to Cloud Run `ai-reporting`, `asia-southeast1`,
  project `ai-reporting-503911`.
- Current version **3.284.0**. Bump BOTH `package.json` and `CLIENT_BUILD` in
  `public/index.html`, and add a CONTEXT.md entry — the audit FAILS without one.
- Before every push: `ECOM_SHEET_ID=mock npm test` must exit 0, and
  `python3 test/print-overflow.py 900 <port>` must exit 0.
- Mock server:
  `WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ECOM_SHEET_ID=mock ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket PORT=8412 node --require ./test/mock-fetch.js server.js`
  It dies between bash calls — start it and use it in the SAME command.
- MW supplies a session-scoped GitHub PAT. Ask for it; do not look for one.

## OPEN — four corrections from MW, in his words

### 1. Bring back average scroll depth
"can you find average scroll depth? you just average all scroll depth events
fired in the page."

He is right and the previous session was wrong to remove it. The code already
computed it correctly — `wsum / ev`, each threshold weighted by its event count
— and it was replaced with a reach figure after an argument about single-
threshold containers that does not apply here: this property tracks 25/50/75/90.

`server.js`, in the campaign `quality` block: `scrollDepth` is still computed and
still on the payload. `scrollReach` was added beside it. The card in
`public/index.html` renders `scrollReach` only. Put the average back. Keeping
both is fine if they fit.

### 2. Missing (THB) labels — A REGRESSION, fix first
"Ad platform performance > Cost per link click you missed (THB)."

v3.284.0 moved the baht symbol out of every money VALUE in the campaign tab but
only added `(THB)` to four labels. Every other money figure is now unitless,
which is worse than before the change. Confirmed still missing:

- `Cost per link click` (Ad platform performance)
- `Landing page views` — its sub-line is a cost per view
- `Cost per ${d.goalResultLabel}`
- the funnel note and any other prose carrying a figure

Find them with: values using `{money:true,bare:true}` whose label has no `(THB)`.
`num(v,{money:true,bare:true})` keeps the rounding rules (satang below 100, K/M
above) and drops the glyph — do NOT use `{dp:0}`, which flattens THB 4.08 to "4".

### 3. Email — read every Click_URL, pattern-match it
"you just find all click_url in the page then filter out which falls into email
address pattern."

The current code only reads the `contact_link*` events, which exist only where a
GTM trigger fired — and `Click | email` fires solely on
`Click URL contains info@bangkokhospital.com`. Every other department inbox is
therefore invisible.

The fix is to widen the SOURCE, not the pattern. `contact_us` fires from
`Click | Contact URL`, whose regex is `^(tel:|mailto:|https?://(line\.me|...))`
— that catches EVERY `mailto:`, whatever the address. It sends `Click_URL`, and
`Click_URL` is a registered custom dimension (since Jul 2025, with
`Click_Classes`, `Click_ID`, `Click_Text`).

So: pull `contact_us` with `customEvent:Click_URL`, campaign-filtered, and treat
any value matching an email pattern as an email click. Dedupe against the
contact-link source the same way the other overlaps are handled — per channel,
the HIGHER of the two, never the sum.

### 4. Google Ads landing views — use GA4, not the connector
"you just look in GA4 see how many visit came from source/medium google/cpc or
google/paid search."

The previous session established that Google Ads has no landing-page-view metric
(true — checked all 2,902 connector fields) and then rendered a dash, which is
not what MW wants. GA4 has the answer: sessions where source/medium is
`google / cpc` (also `google / paid search`) for this campaign.

The campaign already pulls GA4 by `session_manual_source` and
`session_manual_medium` (`GA4_MAIN_DIMS`), so the number is likely already in
`variants` — no new request needed. Fill the Google Ads landing-views cell from
it and label it so nobody reads it as a Meta-style landing page view.

## How MW works

- Terse, reads the DEPLOYED output, catches naming and layout errors fast.
  When he says something is wrong he is right — trace to root cause first.
- One block of issues per turn; work through them and push. No incremental
  approval requests.
- He deletes footnotes on sight. Explanations belong in code and CONTEXT.md.
- Never show a 0 for something that was not measured — dash plus a reason. This
  is the single most repeated correction in the project's history.
- `/i-have-adhd` is on: lead with the next action, number the steps, no preamble.

## Traps that have each cost a release

- **Verify Windsor field names with `get_fields` before writing code.** Most
  repeated mistake on the project.
- **Ratios cannot be summed or averaged across rows** — impression share, bounce
  rate, scroll depth. Pull the components, divide once at the end.
- **Declaration order**: a `const` used before it is defined throws "Cannot
  access before initialization". Hit three times, most recently v3.279.
- **Write a negative test for every guard.** Break the code, watch the assertion
  fail, revert. Several assertions in this suite were decorative until this was
  done — two of them in v3.284 alone.
- **`.slide.pn tbody tr` reveals hidden rows in print**, and `print-prep` must
  mirror any print-only rule that changes block height or `@page` is sized wrong.
- **The SVG twin is what prints**, not the canvas.

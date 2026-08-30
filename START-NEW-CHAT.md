# BHQ War Room — handover at v3.153.0

Paste this into a new chat along with `bkh-dashboard-v3_153_0-FULL.zip`.

---

## Start here

Unzip to `/home/claude/bkh/`, `npm install`, then `ECOM_SHEET_ID=mock npm test`
**before and after every change**. 237 assertions, must exit 0.

Read `CONTEXT.md` §0 first, then the August 2026 entries at the top, newest
first. Every release since v3.128 is documented there with the reasoning.

**Release protocol:** bump `package.json` AND `CLIENT_BUILD` in
`public/index.html` (the audit fails if they disagree), commit with a version +
changelog message, push to `main`, package a rollback zip, then **re-clone and
verify both files landed** — partial deploys are a known failure here.

**GitHub:** `MW-BHQ/AI-Reporting`. MW pastes a fine-grained PAT each session —
it needs **Contents: Read and write**. Delete it at the end of the session.

    git push "https://x-access-token:${PAT}@github.com/MW-BHQ/AI-Reporting.git" main

---

## THE SECOND TEST — run it, it is not in `npm test`

    (WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ECOM_SHEET_ID=mock \
     ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket PORT=8412 \
     node --require ./test/mock-fetch.js server.js &) ; sleep 4
    python3 test/print-overflow.py

**Exit 0 as of v3.153.0 — 26 sections, none clipping. Keep it that way.**

It renders the report in print media and reports, per section, how many pixels
fall off the bottom of its page. It exists because the deck pins every section
to one 7.5in page with `overflow:hidden`, so content that does not fit
disappears **with no mark on the page**. CONTEXT claimed for several releases
that this was undetectable; that was true of CSS and false of the browser.

Notes that matter:

- There **is** a Chromium at `/opt/pw-browsers/chromium-1194` and the python
  `playwright` package is installed. An earlier session concluded there was no
  browser and shipped print changes unverified. There is one. Use it.
- **The server dies between tool calls.** Start it and render in the SAME shell
  invocation.
- The IAP header `X-Goog-Authenticated-User-Email: accounts.google.com:admin@bkh.test`
  must be a Playwright **context** header, not per-request.
- Drive sequence: click the `report` nav item, click `#loadBtn`, wait ~9s, then
  `emulate_media("print")`.
- **It defaults to a 900px layout on purpose.** The print layout can be narrower
  than the window. At 1600px the v3.150 grids measured correct while MW's real
  export was visibly broken — a wide render hides the entire grid-collapse class
  of bug.
- To see a page rather than a number: `pg.pdf(width="13.333in", height="7.5in",
  margin=0, print_background=True)` then `pdftoppm -png -r 55 -f N -l N`.

---

## What just happened (v3.150 to v3.153)

Four releases closing MW's PDF review. The pattern worth carrying: **most of the
fifteen separate complaints were four root causes.**

- **v3.150.0** — uniform page padding, no shadow anywhere, images print
  (`loading="lazy"` was the cause).
- **v3.151.0** — purple headers; `.g-4`/`.g-5` missing from the print grid
  overrides (four bug reports, one line); language pages given a real page box;
  cards hug content; CJK font *named*; footnotes removed; Burmese to Myanmar.
- **v3.152.0** — both scope pages were printing stacked (Chat Bubble was losing
  1611px invisibly); `print-overflow.py` added.
- **v3.153.0** — CJK fonts actually **loaded**; canvas contained; opt-in page
  fill; three sections split onto their own slides; global print density.

---

## Backlog

### Live
Nothing. MW's PDF list is closed. Wait for the next screenshot.

### Three judgement calls MW has not yet responded to
Flagged when v3.153.0 shipped; revert cheaply if MW dislikes them.

1. **Sections split onto their own slides** — AI assistants (was on Referral),
   Google reviews quotes, Facebook Meta Ads. Each was clipping, and the part
   being cut was the most human one: the patient's own words, the
   unmapped-accounts warning. MW may want them back together.
2. **The printed header shrank** — `min-height` 4rem to 2.5rem with the marks
   scaled to match. That bought 24px on all 26 slides and closed the last four
   sections. Tables, card padding and card-title margins are tighter too. If it
   reads cramped, this is the lever.
3. **The date range and generated timestamp are not in the PDF at all.** MW
   rejected the cover page in v3.150 and both mastheads are `display:none` in
   print. `printTitle` / `printRange` are still populated, so putting the stamp
   back somewhere per-slide is cheap.

### Known cosmetic risk
**Emoji flags on Actions by language render as two letters on Windows** (Segoe
UI Emoji has no flag glyphs). Still legible. macOS, iOS and Android draw flags.
If MW is on Windows and objects, swap for small SVG flags in `public/brand/`.

### Deferred by MW, not blocking
- **SKU on ~324 packages of 2026** — affects only English names and discount %,
  not any total. Top 40 cover 80% of THB 154m. Menu, "Which packages to map first".
- **Type scale** — 4 of 5 CSS groups done. ~44 sizes remain: roughly 27 in
  `<style>` (`.u-*`, `.ra-*`, `.stalebar`, `#tip`, `.search`, `.warnbox`,
  `.acct-tab`, plus deliberate print `@media`) and the rest **inline in JS
  template literals, which the `type:scale` audit cannot see at all**. A green
  audit does not mean the migration is done. Note the v3.151 fix: that rule's
  brace tracker used to be broken by a *comment* mentioning `@media`.
- **Repeat-purchase / customer view** — MW called it interesting. Hashed
  customer keys exist; no tab uses them.
- **Chat Bubble unmapped click ids** — MW: "forget it".

### Blocked on other people, not code
- **E-commerce campaign attribution** — every order says "Annual campaign", so
  marketplace revenue cannot be tied to activity.
- **Short.io** for LINE and short-link attribution — MW parked it.

---

## Hard-won learnings — read before changing anything

**Silent failure is the dominant risk in this project.** Find-and-replace
anchors that match nothing, filters that match no rows, guessed field names,
caches that outlive their schema — all produce a green 200 with wrong data.

**A test that cannot distinguish right from wrong is worth nothing. Always
verify a new rule by breaking the thing it guards.** Reintroduce the bug,
confirm the suite fails, restore. Every rule added in v3.150 to v3.153 was
checked this way.

**Measure, do not reason, about layout.** Four releases of print CSS were
shipped on reasoning alone and three of them were wrong in ways one render would
have caught. `scrollHeight - clientHeight` and `getComputedStyle` settle these
arguments in seconds.

**A font-family change that "should" work and visibly does not is a LOADING
problem, not a stack-order problem.** Naming a font the machine lacks is a
no-op. Two releases were lost to this.

**A BACKTICK INSIDE A TEMPLATE LITERAL TERMINATES IT.** This broke the client
three times in two sessions, every time from writing code in backticks inside an
HTML comment sitting inside a template string. `js:comment-backtick` names it now.

**`beforeprint` fires BEFORE Chrome applies the print layout.** Anything that
measures the DOM in that handler reads screen dimensions. Contain in CSS instead.

**`nth-child` counts hidden rows.** A ten-row print cap over a table with
`display:none` rows shows fewer than ten. Cap at render time.

**Print inherits responsive media queries.** `@media(max-width:1080px)` fires
whenever the page lays out narrow, which print often does. Anything that must
hold in print needs an explicit `!important` override in the print block.

**`boot.js` must EXECUTE the view, not parse it.** `renderOverview` was never
run by the suite for months because the tab waited for a click.

**Null is not zero.** A missing metric must never render as 0.

**Read columns by NAME, never by position.** Five real YouTube Studio exports
came back with five different column orders.

**Registering a new tab takes EIGHT edits**: `TABS` in `server.js`, the route
guard, the nav item, `TITLES`, the refresh branch, the render branch, the tab
group list, `VIEW_LOADERS`. Miss `VIEW_LOADERS` and the Load button does nothing.

**Adding a source to the Overview impressions bar takes FOUR**: `impressions`,
`totals.impressions`, `impressionsBySource` (an explicit whitelist), and the
TOFU note, which enumerates the sources in prose and will otherwise lie.

**BHQ is not B+/group.** BHQ is the four hospitals; B+ is the full 27-branch GA4
property. YouTube is the one deliberate exception, labelled as such.

**MW's corrections are usually right — and are often bug reports phrased as
requests.** "Action, page 3, show only 2 hospitals" read as a feature request;
it was a description of a grid collapsing. Read the complaint as a symptom
before implementing it as a spec.

**Be concise.** MW has said several times that verbosity is a problem and that
it worsens over long sessions. Short, plain language. No self-narration. MW
prefers completed work pushed over incremental approval, and sends one block per
turn expecting fast turnaround on that block only.

---

## Data sources

**GA4** direct (property `484633959`), **Search Console** direct
(`sc-domain:bangkokhospital.com`), **Windsor.ai** for GBP/GMB only — its GA4
connector silently ignores filters, which is why GA4 was migrated off it.
Windsor must NOT be removed for `google_my_business` (11 live call sites).

**Windsor's Facebook connector returns one row per campaign x ad set x date.**
Aggregate before computing anything, or every per-row counter inflates. Its
response is double-encoded: outer JSON, then `[0]['text']`, then `json.loads()`
again. The filter key is `operation`, not `operator`.

**YouTube** — a human-maintained Google Sheet
(`18dIkhWSyqcSVyVf9D07R-9R6Hkih4mpZ4c__WZbhyWs`), tabs `Daily` and `Videos`.
The API is a **dead end — do not retry.** The channel is a Brand Account; a
service account cannot read one, "Internal" OAuth needs Workspace, "External +
Testing" expires tokens in 7 days, "External + Production" was tried and the
grant failed. CONTEXT section 12 has the full record. Studio truncates every
table to 500 rows and keeps the busiest, so export one calendar year at a time;
`dayGaps` warns when this happens.

**E-commerce** — the Orders sheet, written by an Apps Script normaliser
(v2.10.0) that lives in the Sheet, not this repo. Centre mapping is complete:
0 blanks across 85,528 rows.

---

## Infrastructure

Cloud Run `ai-reporting-503911` / `ai-reporting-git` / `asia-southeast1`,
auto-deploying from GitHub `main`.

**Check memory is still 2Gi after deploys** — it has silently reset to 512Mi
before and caused hours of mystery 503s.

**The GCS report cache is keyed by build version**
(`report/v<VERSION>/<from>_<to>.json`). Deploying new UI against an old cached
payload shape renders zeros. `refresh=1` busts the upstream memo via one Express
middleware, so new routes cannot forget to support it. GA4 concurrency is
governed by the `GA4_MAX_CONCURRENT` slot queue.

---

## Visual conventions MW has established

No footnotes. No gradient shading that carries meaning. Scope always shown as a
pill. Tab nav under the section header, everywhere. `MoM`, not "Month on month".
Consistent icon set. Hospital logos, not letter codes, wherever a hospital is
named. `display:none!important` for print-only chrome. The audience is hospital
executives, which is what drives removals: unanswered review lists, thin font
weights, confusing multi-window comparisons.

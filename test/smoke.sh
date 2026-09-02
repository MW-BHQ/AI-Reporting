#!/usr/bin/env bash
# Executes every endpoint against stubbed upstreams and fails on any 5xx.
# Run before shipping:  bash test/smoke.sh
set -u
PORT=${PORT:-8399}
BASE="http://localhost:$PORT"
ADMIN="X-Goog-Authenticated-User-Email: accounts.google.com:admin@bkh.test"

WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock \
ADMIN_EMAILS=admin@bkh.test ACCESS_BUCKET=mock-bucket \
PORT=$PORT node --require ./test/mock-fetch.js server.js >/tmp/smoke.log 2>&1 &
SRV=$!
sleep 2.5

FAIL=0
check() {
  local name="$1" method="$2" path="$3" body="${4:-}"
  local code out
  if [ "$method" = "POST" ]; then
    out=$(curl -s -w '\n%{http_code}' -X POST -H "$ADMIN" -H 'content-type: application/json' -d "$body" "$BASE$path")
  else
    out=$(curl -s -w '\n%{http_code}' -H "$ADMIN" "$BASE$path")
  fi
  code=$(echo "$out" | tail -1)
  if [ "$code" -ge 500 ]; then
    FAIL=$((FAIL+1))
    printf '  FAIL %-22s %s\n' "$name" "$(echo "$out" | head -c 200)"
  else
    printf '  ok   %-22s %s\n' "$name" "$code"
  fi
}

# A 200 only proves the endpoint ran. This asserts a JSON path is actually
# populated — it catches an edit that silently failed to apply (e.g. a field
# dropped from a Windsor pull), which a status-code check cannot see.
expect_field() {
  local name="$1" path="$2" jqexpr="$3"
  local got
  got=$(curl -s -H "$ADMIN" "$BASE$path" | node -e "
    let raw=''; process.stdin.on('data',d=>raw+=d).on('end',()=>{
      try { const d=JSON.parse(raw); const v=(${jqexpr}); console.log(v===undefined||v===null?'MISSING':String(v)); }
      catch(e){ console.log('PARSE_ERROR'); }
    });")
  if [ "$got" = "MISSING" ] || [ "$got" = "PARSE_ERROR" ] || [ -z "$got" ]; then
    FAIL=$((FAIL+1)); printf '  FAIL %-22s %s => %s\n' "$name" "$jqexpr" "$got"
  else
    printf '  ok   %-22s %s\n' "$name" "$got"
  fi
}

FROM=2026-07-01; TO=2026-07-31
echo "--- client boot ---"
node "$(dirname "$0")/boot.js" || FAIL=$((FAIL+1))
echo
echo "--- static audit ---"
node "$(dirname "$0")/audit.js" || FAIL=$((FAIL+1))
echo
echo "--- endpoints ---"
check "version"    GET "/api/version"
check "me"         GET "/api/me"
check "users"      GET "/api/users"
check "overview"   GET "/api/overview?from=$FROM&to=$TO"
check "campaigns"  GET "/api/campaigns?from=$FROM&to=$TO"
check "campaign"   GET "/api/campaign?code=260701-08&from=$FROM&to=$TO"
check "gbp"        GET "/api/gbp?from=$FROM&to=$TO"
check "benchmark"  GET "/api/benchmark?to=$TO"
check "untagged"   GET "/api/untagged?from=$FROM&to=$TO"
check "audiences"  GET "/api/audiences?from=$FROM&to=$TO"
check "google ads" GET "/api/google-ads?from=$FROM&to=$TO"
check "page"       GET "/api/page?url=/th/bangkok&from=$FROM&to=$TO"
check "ecommerce"  GET "/api/ecommerce?from=$FROM&to=$TO"
check "ecom centres" GET "/api/ecommerce/centres?from=$FROM&to=$TO"
check "ecom packages" GET "/api/ecommerce/packages?from=$FROM&to=$TO"
check "ecom channels" GET "/api/ecommerce/channels?from=$FROM&to=$TO"
check "ecom migration" GET "/api/ecommerce/migration?from=$FROM&to=$TO"
check "ecom churn"   GET "/api/ecommerce/churn?from=$FROM&to=$TO"
check "ecom monthly" GET "/api/ecommerce/monthly?to=$TO"
check "ecom roas"    GET "/api/ecommerce/roas?from=$FROM&to=$TO"
check "report"       GET "/api/report?from=$FROM&to=$TO"
check "better club"  GET "/api/better-club?from=$FROM&to=$TO"

# Monthly Reports had NO smoke coverage until v3.100.0 — the GCS stub answered
# every read with the access list, so /api/report returned the users array with
# a 200 and nobody noticed. These assert the payload, not the status.
REPORT="/api/report?from=$FROM&to=$TO"
OVERVIEW="/api/overview?from=$FROM&to=$TO"
SA="d.searchAds.byBrand.find(b=>b.key==="
echo "--- monthly report: per-hospital split must be able to fail ---"
# The brand comes from the campaign code. A boundary bug here sent every coded
# campaign to unattributed and left the suite green.
expect_field "sa BGH impressions"  "$REPORT" "${SA}'BGH').impressions===2750?2750:undefined"
# Two rows, BIH and bih — a case-sensitive match would return 37745, not the sum.
expect_field "sa BIH case-merged"  "$REPORT" "${SA}'BIH').impressions===53440?53440:undefined"
expect_field "sa BIH terms"        "$REPORT" "${SA}'BIH').terms.length===2?2:undefined"
# All nine key events, whether or not they fired.
expect_field "sa nine key events"  "$REPORT" "${SA}'BGH').actions.length===9?9:undefined"
# bcm is a real code brand but NOT a hospital; the uncoded campaign joins it.
# If either leaks into a hospital this drops to 1.
expect_field "sa unattributed"     "$REPORT" "d.searchAds.unattributed.campaigns.length===2?2:undefined"
expect_field "sa bcm not a brand"  "$REPORT" "d.searchAds.byBrand.every(b=>b.impressions!==4100)?'ok':undefined"
# Four sources are emitted under BOTH Paid Search and Cross-network. Only the
# Paid Search ones count, because no source here is Google — 800 means the
# Cross-network guard was relaxed to match the channel on its own.
expect_field "sa excludes x-network" "$REPORT" "${SA}'BGH').visits===400?400:undefined"

echo "--- monthly report: referral quality and the AI spotlight ---"
expect_field "rf referrers found"  "$REPORT" "d.referral.byBrand[0].referrerCount>=2?d.referral.byBrand[0].referrerCount:undefined"
# Only Referral-channel sources belong in this table.
expect_field "rf referral only"    "$REPORT" "d.referral.byBrand[0].referrers.every(r=>r.channel==='Referral')?'ok':undefined"
# chatgpt.com must be detected as an assistant wherever GA4 filed it.
expect_field "rf ai detected"      "$REPORT" "d.referral.byBrand[0].ai.rows.some(r=>r.source==='chatgpt.com')?'ok':undefined"
# The assistant appears under several channels; all must be listed, not just one.
expect_field "rf ai multi-channel" "$REPORT" "d.referral.byBrand[0].ai.rows[0].channel.includes(',')?'ok':undefined"
expect_field "rf ai nine events"   "$REPORT" "d.referral.byBrand[0].ai.actions.length===9?9:undefined"
# A source that is NOT on the assistant name list may only appear in the AI
# block via GA4's channel — so its channel list must be exactly "AI Assistant".
# If name matching were leaking, pantip.com would show up under Referral too.
expect_field "rf ai name no leak" "$REPORT" "(d.referral.byBrand[0].ai.rows.find(r=>r.source==='pantip.com')||{}).channel==='AI Assistant'?'ok':undefined"
# Both totals must be present so the blacklist switch has something to show.
expect_field "rf dual totals"      "$REPORT" "d.referral.byBrand[0].totalsAll.sessions>=d.referral.byBrand[0].totals.sessions?'ok':undefined"
expect_field "rf blacklist flag"   "$REPORT" "d.referral.byBrand[0].referrers.every(r=>typeof r.blacklisted==='boolean')?'ok':undefined"
# The scorecard ratio counts assistants WITHIN referral, so it cannot exceed
# 100%. Dividing all-channel assistant sessions by referral sessions gave 250%.
expect_field "rf ai share bounded" "$REPORT" "(d.referral.byBrand[0].ai.shareOfReferral===null||d.referral.byBrand[0].ai.shareOfReferral<=1)?'ok':undefined"
# canva.com is on MW's blacklist. It must be flagged, and the clean total must
# be strictly lower than the full one — equal totals mean nothing was excluded.
expect_field "rf blacklist hits"   "$REPORT" "d.referral.byBrand[0].blacklistedCount>=1?d.referral.byBrand[0].blacklistedCount:undefined"
expect_field "rf canva flagged"    "$REPORT" "(d.referral.byBrand[0].referrers.find(r=>r.source==='www.canva.com')||{}).blacklisted===true?'ok':undefined"
expect_field "rf clean below all"  "$REPORT" "d.referral.byBrand[0].totals.sessions<d.referral.byBrand[0].totalsAll.sessions?'ok':undefined"
expect_field "rf blacklist active" "$REPORT" "d.referral.byBrand[0].blacklistActive===true?'ok':undefined"
# pantip.com is NOT on the list and must survive the filter.
expect_field "rf keeps real links" "$REPORT" "(d.referral.byBrand[0].referrers.find(r=>r.source==='pantip.com')||{}).blacklisted===false?'ok':undefined"
# Each referrer needs its own event breakdown, not just a total, or MW's five
# columns have nothing to read.
expect_field "rf per-source events" "$REPORT" "d.referral.byBrand[0].referrers.every(r=>r.events&&typeof r.events==='object')?'ok':undefined"
expect_field "rf events sum to total" "$REPORT" "d.referral.byBrand[0].referrers.every(r=>Object.values(r.events).reduce((a,b)=>a+b,0)===r.actions)?'ok':undefined"

echo "--- monthly report: content pages are PAGE-scoped, not landing-scoped ---"
# The out-of-scope branch has the highest view count in the fixture (9999), so
# a leak puts it top of every doctor table.
#
# TWO guards block it and either alone is sufficient: the branch regex on the
# pull, and the `brandBySegment` check in `parse()`. Removing just one keeps
# this green — it took removing BOTH to make it fail. So read this as a check on
# out-of-scope exclusion overall, NOT as proof the pull filter is present.
# The pull filter earns its place on ROW VOLUME (a 44,000-page property), which
# no assertion on the output can observe.
expect_field "ct excludes off-scope" "$REPORT" "JSON.stringify(d.content.byBrand).indexOf('dr-out-of-scope')===-1?'ok':undefined"
# Ranked by views: 900 before 500.
expect_field "ct ranked by views"  "$REPORT" "d.content.byBrand.BGH.th.doctor.rows[0].slug==='dr-valailuck'?'ok':undefined"
# Ranking is by VIEWS, the column reads APPOINTMENTS, and in the fixture the
# two disagree: dr-valailuck leads on views (900) while dr-second has more
# appointments (200 vs 90). So a card that sorts on the action column, or reads
# views into it, changes this row.
expect_field "ct ranks on views"   "$REPORT" "d.content.byBrand.BGH.th.doctor.rows[0].action===90?90:undefined"
expect_field "ct action beats top" "$REPORT" "d.content.byBrand.BGH.th.doctor.rows[1].action>d.content.byBrand.BGH.th.doctor.rows[0].action?'ok':undefined"
# The near-tie margin guard now has to be checked on a type that still shows a
# mix: Package suppresses its own, so Center carries the case. Its configured
# Contact us leads, so no warning either way — the guard itself is proven by the
# negative control in the release notes rather than by this line.
expect_field "ct center settled"   "$REPORT" "(d.content.types.find(t=>t.id==='center')||{}).suggestedAction===null?'ok':undefined"
# Articles: find_doctors clearly beats the configured view_item, so it IS flagged.
# With Contact us configured and Contact us the top event on article pages, the
# warning must now be SILENT — the swap has been made.
expect_field "ct article settled"  "$REPORT" "(d.content.types.find(t=>t.id==='article')||{}).suggestedAction===null?'ok':undefined"
expect_field "ct type split"       "$REPORT" "d.content.byBrand.BGH.th.package.rows.length>=1&&d.content.byBrand.BGH.th.center.rows.length>=1?'ok':undefined"
# Locale comes from the path, so an English doctor page must not land in Thai.
expect_field "ct locale split"     "$REPORT" "d.content.byBrand.BGH.en.doctor.rows[0].slug==='dr-valailuck-en'?'ok':undefined"
expect_field "ct top ten cap"      "$REPORT" "Object.values(d.content.byBrand).every(b=>Object.values(b).every(c=>['doctor','package','article','center'].every(t=>c[t].rows.length<=10)))?'ok':undefined"
# Category page (MW): 5,000 views in the fixture, more than any real package.
# A failed exclusion puts it top of the Package card and inflates that total.
expect_field "ct category excluded" "$REPORT" "d.content.byBrand.BGH.th.package.rows.every(r=>r.slug!=='health-check-up-packages')?'ok':undefined"
expect_field "ct category untotalled" "$REPORT" "d.content.byBrand.BGH.th.package.views<5000?'ok':undefined"
# All nine events are measured per type, which is what identifies a wrong column.
expect_field "ct mix measured"     "$REPORT" "d.content.types.every(t=>Array.isArray(t.mix))?'ok':undefined"
# Articles is Contact us now (MW, from live data: Contact us 22.6K vs View item 28).
expect_field "ct article contact"  "$REPORT" "(d.content.types.find(t=>t.id==='article')||{}).action==='contact_us'?'ok':undefined"
# Package suppresses the footer: on a package page view_item IS the page view,
# so the mix would forever "suggest" restating the Views column beside it.
expect_field "ct package no mix"   "$REPORT" "(d.content.types.find(t=>t.id==='package')||{}).mix.length===0?'ok':undefined"
expect_field "ct package no sugg"  "$REPORT" "(d.content.types.find(t=>t.id==='package')||{}).suggestedAction===null?'ok':undefined"
# GA4's own "AI Assistant" channel. pantip.com is NOT in the name list, so it
# can only appear here via the channel — 0 means native detection is dead.
# Counter populated only. This does NOT prove native detection works — with
# detection reduced to name matching it still passed, because a name-matched
# row arriving on the AI Assistant channel is counted native. The real proof of
# native detection is "ai channel-only hit" below.
expect_field "ai native counter"   "$REPORT" "d.referral.byBrand[0].ai.nativeSessions>0?'ok':undefined"
expect_field "ai channel-only hit" "$REPORT" "d.referral.byBrand[0].ai.rows.some(r=>r.source==='pantip.com')?'ok':undefined"
# The name list. chatgpt.com arrives under channels GA4 did not classify.
expect_field "ai named signal"     "$REPORT" "d.referral.byBrand[0].ai.namedSessions>0?'ok':undefined"
expect_field "ai named hit"        "$REPORT" "d.referral.byBrand[0].ai.rows.some(r=>r.source==='chatgpt.com')?'ok':undefined"
# The two signals partition the total; overlap or a gap means double counting.
expect_field "ai split partitions" "$REPORT" "(d.referral.byBrand[0].ai.nativeSessions+d.referral.byBrand[0].ai.namedSessions)===d.referral.byBrand[0].ai.totals.sessions?'ok':undefined"
# All nine on the scorecards, and per assistant in the table.
expect_field "ai per-assistant KEs" "$REPORT" "d.referral.byBrand[0].ai.rows.every(r=>r.events&&typeof r.events==='object')?'ok':undefined"
# GA4's own "AI Assistant" channel must be picked up on its own. `facebook` is
# not on the assistant name list, so if it appears in the AI rows the ONLY
# thing that could have put it there is the channel.
expect_field "rf ai by channel"    "$REPORT" "d.referral.byBrand[0].ai.rows.some(r=>r.source==='facebook')?'ok':undefined"
# Per-assistant event columns need per-assistant counts.
expect_field "rf ai per-row events" "$REPORT" "d.referral.byBrand[0].ai.rows.every(r=>r.events&&typeof r.events==='object')?'ok':undefined"

echo "--- overview: YouTube rides along as awareness, NOT in the funnel ---"
# One Sheets read on the overview pull. It must not join the funnel: YouTube
# views never become a GA4 session, and the sessions YouTube does drive are
# already counted under Organic Social, so adding views would double-count the
# ones that converted and invent the ones that did not.
expect_field "ov yt awareness"     "$OVERVIEW" "d.impressionsBySource.youtube===1000?1000:undefined"
expect_field "ov yt reach row"     "$OVERVIEW" "d.reachOnly.some(r=>r.channel==='YouTube')?'ok':undefined"
# The scope caveat travels on the payload, not just in the client template.
expect_field "ov yt scope stated"  "$OVERVIEW" "/NOT branch-scoped/.test((d.reachOnly.find(r=>r.channel==='YouTube')||{}).note||'')?'ok':undefined"
# YouTube must NOT appear as a funnel channel.
expect_field "ov yt not in funnel" "$OVERVIEW" "d.funnel.every(c=>!/youtube/i.test(c.channel))?'ok':undefined"
# YouTube IS inside totals.impressions. The bar draws each source as a share of
# that total, so a source in the bar but not the total makes every percentage
# overstate and the widths sum past 100%.
expect_field "ov yt in imp total"  "$OVERVIEW" "(d.totals.impressions>=d.impressionsBySource.youtube)?'ok':undefined"

echo "--- monthly report: YouTube (Studio export, Daily + Videos) ---"
YT="d.youtube"
expect_field "yt available"        "$REPORT" "$YT.available===true?'ok':undefined"
expect_field "yt source"           "$REPORT" "$YT.source==='studio-export'?'ok':undefined"
# Report window is 3 fixture days: 100+200+700.
expect_field "yt window sum"       "$REPORT" "$YT.totals.views===1000?1000:undefined"
# LIKES, NOT DISLIKES. `Dislikes` sits immediately before `Likes` in the real
# export; 1+2+7=10 for likes against 3+2+1=6 for dislikes, so a wrong match is
# not merely close. `Comments added` must resolve via the prefix rule.
expect_field "yt likes not dislikes" "$REPORT" "$YT.totals.likes===10?10:undefined"
expect_field "yt comments prefix"  "$REPORT" "$YT.totals.comments===3?3:undefined"
# A Total row has no parseable date and must never be summed with its own days.
expect_field "yt total row dropped" "$REPORT" "$YT.totals.shares===15?15:undefined"
# Watch time is HOURS in the header and must not be divided again.
expect_field "yt hours not minutes" "$REPORT" "$YT.totals.hoursWatched===100?100:undefined"
# MoM and YoY are the point of the Daily tab. prev=500 views, yoy=250.
expect_field "yt mom views"        "$REPORT" "Math.abs($YT.mom.views-1)<1e-9?'ok':undefined"
expect_field "yt yoy views"        "$REPORT" "Math.abs($YT.yoyChange.views-3)<1e-9?'ok':undefined"
# 2026-05-20 is outside all three windows and must count in none of them.
expect_field "yt out of window"    "$REPORT" "($YT.prev.views===500&&$YT.yoy.views===250)?'ok':undefined"
# THE 500-ROW CAP GUARD. 3 of 31 days present, so 28 are missing and the slide
# must be able to say so — a short export otherwise reads as a soft month.
expect_field "yt day gaps"         "$REPORT" "($YT.expectedDays===31&&$YT.foundDays===3&&$YT.dayGaps===28)?'ok':undefined"
# Coverage is read from the file, not from the report range.
expect_field "yt coverage"         "$REPORT" "($YT.covered.from==='2025-07-05'&&$YT.covered.to==='2026-07-31')?'ok':undefined"
expect_field "yt not stale"        "$REPORT" "$YT.stale===false?'ok':undefined"
# Videos are matched on the hand-added Month column, written by Studio as a DATE.
# The June row has the highest views in the fixture, so a missing month filter
# puts it top of a July report.
expect_field "yt videos month"     "$REPORT" "$YT.videos.rows.every(v=>v.id!=='junevid')?'ok':undefined"
expect_field "yt videos sorted"    "$REPORT" "$YT.videos.rows[0].id==='v1'?'ok':undefined"
expect_field "yt video blank title" "$REPORT" "($YT.videos.rows.find(v=>v.id==='v2')||{}).title===''?'ok':undefined"

echo "--- audiences field integrity (a dropped Windsor field must fail here) ---"
CAMPD="/api/campaign?code=260701-08&from=$FROM&to=$TO"
# Google Ads must reach campaign analysis through the shared platform registry.
expect_field "campaign platforms" "$CAMPD" "(d.byPlatform||[]).filter(function(p){return p.platform==='Google Ads' && p.connected;}).length?'ok':undefined"
AUD="/api/audiences?from=$FROM&to=$TO"
expect_field "aud ad account"   "$AUD" "d.audiences[0].accounts[0]"
expect_field "aud frequency"    "$AUD" "d.audiences[0].frequency"
expect_field "aud ctr"          "$AUD" "d.audiences[0].ctr"
expect_field "aud catalog flag" "$AUD" "d.catalogAvailable"
expect_field "aud meta rank"    "$AUD" "d.audiences[0].rankings.quality||'none-rated'"
expect_field "aud objective"    "$AUD" "d.audiences[0].objective==='CONVERSATIONS'?'CONVERSATIONS':undefined"
# The ad set goal must beat campaign_objective (mock sends OUTCOME_TRAFFIC alongside
# CONVERSATIONS, the real WhatsApp shape). If the goal field is ever dropped from the
# Windsor pull again, this fails instead of silently pricing everything per LPV.
expect_field "obj beats campaign" "$AUD" "d.audiences[0].primary.kpi==='message'?'per-msg':undefined"
expect_field "campaign obj"     "$AUD" "d.audiences[0].campaigns[0].goal==='CONVERSATIONS'?'ok':undefined"
expect_field "campaign cost/res" "$AUD" "d.audiences[0].campaigns[0].resultLabel==='per msg'?'per-msg':undefined"
# No campaign row may have zero delivery, and uses must match the rows shown.
expect_field "no empty campaigns" "$AUD" "d.audiences.every(a=>a.campaigns.every(c=>c.spend>0||c.impressions>0))?'clean':undefined"
expect_field "uses matches rows"  "$AUD" "d.audiences.every(a=>a.uses===a.campaigns.length)?'match':undefined"
# Guard: a reach/awareness buy must never be priced per LPV.
PAGE="/api/page?url=https://www.bangkokhospital.com/th/bangkok%3Futm_source=x&from=$FROM&to=$TO"
# A pasted URL is reduced to its path: host, query and anchor all dropped.
expect_field "page path"        "$PAGE" "d.path==='/th/bangkok'?'ok':undefined"
# The GA4 pull must be filtered and split, or a year-long range exceeds the
# response limit with "Data size is too big".
expect_field "page yoy window"  "$PAGE" "d.windows&&d.windows.yoy&&d.windows.yoy.from?'ok':undefined"
expect_field "page compare"     "$PAGE" "d.compare&&('yoy' in d.compare)&&('prev' in d.compare)?'ok':undefined"
echo "--- pages: where they go next ---"
NEXTP="/api/page?url=/th/bangkok/page/a&from=$FROM&to=$TO"
expect_field "np available"       "$NEXTP" "d.nextPages.available===true?'ok':undefined"
expect_field "np has rows"        "$NEXTP" "d.nextPages.rows.length>0?d.nextPages.rows.length:undefined"
# The page itself appears as its own referrer on a reload or a self-link; it
# must not top its own list of destinations.
expect_field "np excludes self"   "$NEXTP" "(d.nextPages.rows.every(r=>r.path!=='/th/bangkok/page/a')&&d.nextPages.selfViews>0)?'ok':undefined"
# CONTAINS is a coarse server-side filter, so `/th/bangkok/page/a-other` passes
# it as a referrer without being the page or beneath it. Shares are computed on
# the accepted set, so they cannot sum past 1.
expect_field "np shares bounded"  "$NEXTP" "d.nextPages.rows.reduce((a,r)=>a+r.share,0)<=1.0000001?'ok':undefined"
# The fixture includes a sibling referrer and an external one, both of which
# satisfy CONTAINS without being this page. A rejected count of 0 means the
# prefix guard is gone and unrelated referrers are being read as this page.
expect_field "np rejects strays"  "$NEXTP" "d.nextPages.rejectedRefViews>0?'ok':undefined"
expect_field "page url needed"  "/api/page?from=$FROM&to=$TO" "d.error?'rejected':undefined"
GADS="/api/google-ads?from=$FROM&to=$TO"
expect_field "gads accounts"    "$GADS" "d.accounts.length>0?'ok':undefined"
# The leading YYMMDD-NN code is what lets a Google campaign join the Campaign tab.
expect_field "gads code parsed" "$GADS" "d.campaigns.some(c=>c.code==='260701-08')?'ok':undefined"
expect_field "gads uncoded ok"  "$GADS" "d.campaigns.some(c=>c.code===null)?'ok':undefined"
# Ad groups are Google's ad sets; their spend must reconcile to the campaign.
expect_field "gads adgroups"    "$GADS" "d.campaigns.every(c=>Array.isArray(c.groups))?'ok':undefined"
expect_field "gads group sum"   "$GADS" "d.campaigns.every(c=>!c.groups.length||Math.abs(c.groups.reduce((a,g)=>a+g.spend,0)-c.spend)<1)?'ok':undefined"
# Google Ads must reach the Campaign tab through the shared platform registry.
# ---- Better Club -----------------------------------------------------------
BCLUB="/api/better-club?from=$FROM&to=$TO"
expect_field "bclub available"   "$BCLUB" "d.available?'ok':undefined"
# THE MONTH THE CARDS DESCRIBE. A July range must land on July, not on the last
# row of the sheet and not a month early — the first build wrote MonthYear as a
# Date and shifted every month back by one, displaying January as December 2025.
expect_field "bclub selected"    "$BCLUB" "d.selected.month==='2026-07'?'ok':undefined"
expect_field "bclub prev"        "$BCLUB" "d.prev.month==='2026-06'?'ok':undefined"
expect_field "bclub no pending"  "$BCLUB" "d.pending.length===0?'ok':undefined"
# A Date in MonthYear must still resolve to its own month rather than dropping
# out or landing in April, so all three fixture months must be present.
expect_field "bclub date row"    "$BCLUB" "d.months.map(m=>m.month).join(',')==='2026-05,2026-06,2026-07'?'ok':undefined"
# The note row and the trailing blank row must not become months.
expect_field "bclub drops notes" "$BCLUB" "d.months.length===3?'ok':undefined"
# RATES ARE RECOMPUTED, NEVER READ. The fixture's ARPU columns all say 99999 and
# its share columns all say 9.99; if either reaches the payload the sheet's stale
# values are being trusted over the counts printed beside them.
# COMMA-FORMATTED CELLS MUST PARSE. The fixture ships "฿66,000" because that is
# what the Sheets values endpoint returns; Number() gives NaN, which the global
# n() floors to 0. This is the assertion that would have stopped v3.186.0.
expect_field "bclub revenue parsed" "$BCLUB" "d.selected.revenue===66000?'ok':undefined"
expect_field "bclub big count"     "$BCLUB" "d.months.find(m=>m.month==='2026-06').revenue===50000?'ok':undefined"
# The funnel panel must exist with one entry per month, impressions/users pulled
# group-level and registers explicitly null until a feed exists.
expect_field "bclub funnel rows"   "$BCLUB" "d.funnel.length===d.months.length?'ok':undefined"
expect_field "bclub funnel newhns" "$BCLUB" "d.funnel.every(f=>f.newPaidHns===d.months.find(m=>m.month===f.month).newHns)?'ok':undefined"
# THE REGISTERS TAB. Fetched separately, because values:batchGet fails the whole
# request with a 400 if any range names a tab that does not exist and this tab is
# optional by design.
expect_field "bclub reg source"    "$BCLUB" "d.registerSource?'ok':undefined"
expect_field "bclub reg value"     "$BCLUB" "d.funnel.find(f=>f.month==='2026-06').registers===25?'ok':undefined"
# A month present in the tab but BLANK stays null. As 0 it would draw a trough on
# the funnel and divide into an infinite conversion.
expect_field "bclub reg blank"     "$BCLUB" "d.funnel.find(f=>f.month==='2026-07').registers===null?'ok':undefined"
expect_field "bclub reg no conv"   "$BCLUB" "d.funnel.find(f=>f.month==='2026-07').registerToPaid===null?'ok':undefined"
# June: 2 new paying members against 25 registers.
expect_field "bclub conversion"    "$BCLUB" "Math.abs(d.funnel.find(f=>f.month==='2026-06').registerToPaid-(2/25))<0.0001?'ok':undefined"
# Search Console rows are FLATTENED by gscQueryPage, so a date-dimension row
# carries `date`, not the API's raw `keys` array. Reading `keys` returned null
# for every month while still reporting the source as available.
expect_field "bclub impressions"   "$BCLUB" "d.funnel.some(f=>f.impressions>0)?'ok':undefined"
expect_field "bclub users"         "$BCLUB" "d.funnel.some(f=>f.users>0)?'ok':undefined"
# A month the upstream has no data for stays null rather than becoming 0 — a
# zero would draw a real-looking trough on the funnel panel.
expect_field "bclub gap is null"   "$BCLUB" "d.funnel.some(f=>f.impressions===null)?'ok':undefined"
# Group-level scope must be declared so the client cannot label it BHQ.
expect_field "bclub scope named"   "$BCLUB" "d.funnelScope.note.indexOf('group-level')>-1?'ok':undefined"
expect_field "bclub arpu derived" "$BCLUB" "Math.abs(d.selected.arpu-11000)<1?'ok':undefined"
expect_field "bclub share derived" "$BCLUB" "Math.abs(d.selected.newHnShare-(2/6))<0.001?'ok':undefined"
# Old counts fall out of the sheet, but must reconcile against new + old = paid.
expect_field "bclub splits sum"  "$BCLUB" "d.months.every(m=>m.newHns+m.oldHns===m.paidHns)?'ok':undefined"
expect_field "bclub rev splits"  "$BCLUB" "d.months.every(m=>Math.abs(m.newRev+m.oldRev-m.revenue)<1)?'ok':undefined"
# COHORTS. Of June's two new members (bbb1, bbb2) exactly one pays again in
# July, so the June row must report 2 and a 50% July rate. A blank HN_ID row
# must not become a cohort member.
expect_field "bclub cohort size" "$BCLUB" "d.cohorts.rows.find(r=>r.cohort==='2026-06').size===2?'ok':undefined"
expect_field "bclub cohort rate" "$BCLUB" "Math.abs(d.cohorts.rows.find(r=>r.cohort==='2026-06').retained.find(x=>x.month==='2026-07').rate-0.5)<0.001?'ok':undefined"
# A cohort is never reported against its own month or an earlier one.
expect_field "bclub cohort fwd"  "$BCLUB" "d.cohorts.rows.every(r=>r.retained.every(x=>x.month>r.cohort))?'ok':undefined"
# CONCENTRATION is computed over the selected month only, including the blank-id
# rows, so member count must match that month's paid total.
expect_field "bclub conc month"  "$BCLUB" "d.concentration.month==='2026-07'?'ok':undefined"
expect_field "bclub conc share"  "$BCLUB" "d.concentration.top10.share>0&&d.concentration.top10.share<=1?'ok':undefined"
# Registration-to-paid is computed ONLY from the Registers tab. With no tab the
# source is null and the stage stays empty; it is never filled from elsewhere.
expect_field "bclub reg named"   "$BCLUB" "d.registerSource==='Registers tab'?'ok':undefined"

ECOM="/api/ecommerce?from=$FROM&to=$TO"
# PACKAGES ARE GROUPED BY NAME, NOT BY SKU (MW). The master re-codes a package
# every promo cycle (0101-2604, 0101-2608), so grouping by SKU would split one
# package into a row per cycle. A duplicate name in the list means that split
# has come back.
expect_field "packages by name"  "$ECOM" "(function(n){return d.packages.every(p=>!n[p.name]&&(n[p.name]=1))?'ok':undefined})({})"
expect_field "ecom channels"    "$ECOM" "d.channels.length===2?'2':undefined"
expect_field "ecom stacked day" "$ECOM" "d.daily[0].byChannel.Shopee===5000?'ok':undefined"
# Unmapped rows must show up as a visible gap, never be dropped or hidden.
expect_field "ecom unmapped"    "$ECOM" "d.centers.some(c=>c.center==='(unmapped)')?'flagged':undefined"
# Comparison windows must be the equal-length span before, and the same dates a year back.
expect_field "cmp prev window"  "$ECOM" "d.compare.windows.prev.to==='2026-06-30'?'ok':undefined"
expect_field "cmp yoy window"   "$ECOM" "d.compare.windows.yoy.from==='2025-07-01'?'ok':undefined"
expect_field "cmp on channels"  "$ECOM" "d.channels.every(c=>'mom' in c && 'yoy' in c)?'ok':undefined"
expect_field "ecom repeat cust" "$ECOM" "d.customers.repeat===1?'1':undefined"
# The ฿500k Agent order must NOT be in the Online default, and must appear with scope=all.
expect_field "B2B excluded"     "$ECOM" "d.totals.revenue===24000?'24000':undefined"
expect_field "B2B in scope=all" "/api/ecommerce?from=$FROM&to=$TO&scope=all" "d.totals.revenue===524000?'524000':undefined"
PKG="/api/ecommerce/packages?from=$FROM&to=$TO"
expect_field "pkg rows"          "$PKG" "d.packages.length>0?'ok':undefined"
# GROUPED BY NAME, NEVER BY SKU. The master re-codes a package every promo cycle,
# and SKU is filled on 3-12% of rows while package_name is 100% — so a duplicate
# name here means the grouping has moved to SKU and split one product into a row
# per cycle.
expect_field "pkg by name"       "$PKG" "(function(n){return d.packages.every(p=>!n[p.name]&&(n[p.name]=1))?'ok':undefined})({})"
expect_field "pkg sorted"        "$PKG" "d.packages.every((p,i)=>!i||d.packages[i-1].revenue>=p.revenue)?'ok':undefined"
# Units must reconcile: every coupon in range belongs to exactly one package.
expect_field "pkg units total"   "$PKG" "d.packages.reduce((a,p)=>a+p.units,0)===d.totals.units?'ok':undefined"
# A missing list price means an UNKNOWN discount, not a 0% one.
expect_field "pkg discount null" "$PKG" "d.packages.some(p=>p.discountDepth===null)?'ok':undefined"
expect_field "pkg cmp fields"    "$PKG" "d.packages.every(p=>'mom' in p && 'yoy' in p)?'ok':undefined"
expect_field "pkg top80"         "$PKG" "(d.totals.top80>0&&d.totals.top80<=d.totals.packages)?'ok':undefined"

CEN="/api/ecommerce/centres?from=$FROM&to=$TO"
expect_field "centre count"     "$CEN" "d.centres.length===3?'3':undefined"
expect_field "centre at-risk"   "$CEN" "d.totals.unredeemedValue>0?'yes':undefined"
expect_field "centre discount"  "$CEN" "d.centres.some(c=>c.discountDepth!==null)?'yes':undefined"
expect_field "centre matrix"    "$CEN" "d.channels.length>=2?'ok':undefined"
expect_field "cmp on centres"   "$CEN" "d.centres.every(c=>'mom' in c && 'yoy' in c)?'ok':undefined"
# CHANNEL COLUMNS ORDERED BY REVENUE, NOT ALPHABETICALLY (MW). Alphabetical put
# the biggest channel off the right edge of the viewport, so the reader had to
# scroll past the small ones to reach the one that mattered.
expect_field "centre chan order" "$CEN" "(function(t){d.channels.forEach(c=>t[c]=0);d.centres.forEach(c=>Object.entries(c.byChannel).forEach(([k,v])=>t[k]+=v));return d.channels.every((c,i)=>!i||t[d.channels[i-1]]>=t[c])?'ok':undefined})({})"
# Volume rides alongside value so the cross-tab can be read either way. Coupons
# must be COUNTS, so the per-centre total has to match that centre's coupons.
expect_field "centre units field" "$CEN" "d.centres.every(c=>c.unitsByChannel&&Object.values(c.unitsByChannel).reduce((a,v)=>a+v,0)===c.coupons)?'ok':undefined"
CH2="/api/ecommerce/channels?from=$FROM&to=2026-08-31&scope=all"
expect_field "chan months"      "$CH2" "d.months.length===2?'2':undefined"
expect_field "chan affinity"    "$CH2" "d.channels.some(c=>c.bestAt.length)?'yes':undefined"
expect_field "chan momentum"    "$CH2" "d.channels.some(c=>c.momentum!==null)?'yes':undefined"
# A channel missing from CHANNEL_TYPE must be reported by name, not silently bucketed.
expect_field "unclassified named" "$CH2" "(d.unclassified||[]).some(u=>u.name==='Roadshow 2024')?'named':undefined"
MIG="/api/ecommerce/migration?from=$FROM&to=2026-08-31"
# c1 goes Online -> Offline (a switcher); c2 buys online twice (returning, not a switcher).
expect_field "mig switchers"    "$MIG" "d.totals.switchers===1?'1':undefined"
expect_field "mig loyal"        "$MIG" "d.totals.loyal===1?'1':undefined"
expect_field "mig flow dir"     "$MIG" "d.flows[0]&&d.flows[0].from==='Online'&&d.flows[0].to==='Offline'?'ok':undefined"
expect_field "mig monthly"      "$MIG" "d.monthly.some(m=>(m.byType||{}).Offline===1)?'ok':undefined"
# Movement between online storefronts must be reported separately from leaving online.
expect_field "mig online block" "$MIG" "d.online&&typeof d.online.switchRate==='number'?'ok':undefined"
# Churn over a 30-day window ending 2026-08-31: the July-only buyers are lost,
# and the identity churned + active must equal the customer count.
CHN="/api/ecommerce/churn?from=$FROM&to=2026-08-31&window=30"
expect_field "churn identity"   "$CHN" "d.totals.churned+d.totals.active===d.totals.customers?'ok':undefined"
expect_field "churn split"      "$CHN" "d.totals.oneAndDone+d.totals.lapsed===d.totals.churned?'ok':undefined"
expect_field "churn by channel" "$CHN" "d.channels.length>0?'ok':undefined"
expect_field "churn by centre"  "$CHN" "d.centres.length>0?'ok':undefined"
expect_field "churn cutoff"     "$CHN" "d.cutoff==='2026-08-01'?'ok':undefined"
MON="/api/ecommerce/monthly?to=$TO&scope=all"
expect_field "monthly month"    "$MON" "d.month==='2026-07'?'ok':undefined"
expect_field "monthly window"   "$MON" "d.windows.month.to==='2026-07-31'?'ok':undefined"
expect_field "monthly yoy win"  "$MON" "d.windows.monthPrev.from==='2025-07-01'?'ok':undefined"
expect_field "monthly ytd"      "$MON" "d.windows.ytd.from==='2026-01-01'?'ok':undefined"
expect_field "monthly centres"  "$MON" "d.centres.length>0?'ok':undefined"
expect_field "monthly channels" "$MON" "d.channels.length>0&&Math.abs(d.channels.reduce((a,c)=>a+c.share,0)-1)<0.001?'shares-sum-1':undefined"
ROAS="/api/ecommerce/roas?from=$FROM&to=$TO"
# be reported separately rather than inflating or deflating the ratio.
# Exactly the three marketplace accounts, matched on id so a rename cannot drop one.
expect_field "roas 3 accounts"  "$ROAS" "d.accounts.length===3?'ok':undefined"
expect_field "roas account ids" "$ROAS" "d.accounts.every(a=>/^\\d{15}$/.test(a.id))?'ok':undefined"
# Campaigns listed must have actually spent in the range.
expect_field "roas active only" "$ROAS" "d.accounts.every(a=>a.campaigns.every(c=>c.spend>0))?'ok':undefined"
# Every campaign carries its ad sets, and their spend must sum to the campaign.
expect_field "roas adsets"      "$ROAS" "d.accounts.every(a=>a.campaigns.every(c=>Array.isArray(c.adsets)))?'ok':undefined"
expect_field "roas adset sum"   "$ROAS" "d.accounts.every(a=>a.campaigns.every(c=>!c.adsets.length||Math.abs(c.adsets.reduce((x,s)=>x+s.spend,0)-c.spend)<1))?'ok':undefined"
# Days live counts DISTINCT dates. Windsor returns one row per campaign x adset
# x date, so a counter reports six ad sets over seven days as 42.
expect_field "roas days sane"   "$ROAS" "d.accounts.every(a=>a.campaigns.every(c=>c.days<=Math.max(...c.adsets.map(s=>s.days),0)||!c.adsets.length))?'ok':undefined"
expect_field "roas days vs range" "$ROAS" "d.accounts.every(a=>a.campaigns.every(c=>c.days<=32))?'ok':undefined"
# Days live counts distinct dates, so it can never exceed the days in the range
# nor be less than any of the campaign's own ad sets.
expect_field "roas days sane"   "$ROAS" "d.accounts.every(a=>a.campaigns.every(c=>c.days<=62&&c.adsets.every(s=>s.days<=c.days)))?'ok':undefined"
# Two accounts share Shopee, so the total must not count its revenue twice.
expect_field "roas no dbl count" "$ROAS" "d.channels.length===new Set(d.channels).size?'ok':undefined"
expect_field "awareness=CPM"    "$AUD" "d.audiences.every(a=>a.objectiveClass!=='awareness'||a.primary.kpi==='cpm')||'BAD'"
# Regression guard for the 3.20 bug: with no positive catalog metric anywhere,
# nothing may be classified as CPAS. `undefined !== null` once made every row
# ecommerce, which blanked every cost/result in the account.
expect_field "no false CPAS"    "$AUD" "d.audiences.every(a=>!a.isCpas||a.purchases>0)||'BAD'"

check "topic"      POST "/api/topic" "{\"topic\":\"gallbladder\",\"from\":\"$FROM\",\"to\":\"$TO\"}"
check "user upsert" POST "/api/users" '{"email":"x@bkh.test","tabs":["overview"]}'

echo "--- youtube: sheet only, the API path is GONE (v3.129.0) ---"
# Asserted as an ABSENCE. The OAuth path was removed, so the secrets being set
# must no longer change anything: a leftover YT_CLIENT_ID in Cloud Run cannot
# revive a code path that is not there, and `apiError` must never reappear on
# the payload. Tested with the secrets deliberately present.
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ADMIN_EMAILS=admin@bkh.test \
YT_CLIENT_ID=cid YT_CLIENT_SECRET=csec YT_REFRESH_TOKEN=rt \
PORT=$PORT node --require ./test/mock-fetch.js server.js >>/tmp/smoke.log 2>&1 &
SRV=$!
sleep 2.5
expect_field "yt source is export"   "$REPORT" "d.youtube.source==='studio-export'?'ok':undefined"
expect_field "yt secrets are inert"  "$REPORT" "d.youtube.apiError===undefined?'ok':undefined"
expect_field "yt has data"           "$REPORT" "d.youtube.totals.views===1000?1000:undefined"

echo "--- degradation: one source failing must not 500 ---"
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
WINDSOR_API_KEY=mock ANTHROPIC_API_KEY=mock ADMIN_EMAILS=admin@bkh.test \
MOCK_FAIL_CONNECTOR=facebook PORT=$PORT node --require ./test/mock-fetch.js server.js >>/tmp/smoke.log 2>&1 &
SRV=$!
sleep 2.5
check "overview (meta down)" GET "/api/overview?from=$FROM&to=$TO"
check "campaign (meta down)" GET "/api/campaign?code=260701-08&from=$FROM&to=$TO"
check "audiences (meta down)" GET "/api/audiences?from=$FROM&to=$TO"

kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "$FAIL endpoint(s) returned 5xx — see /tmp/smoke.log"
  exit 1
fi
echo "all endpoints executed without a server error"

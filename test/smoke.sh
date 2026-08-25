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
check "ecom channels" GET "/api/ecommerce/channels?from=$FROM&to=$TO"
check "ecom migration" GET "/api/ecommerce/migration?from=$FROM&to=$TO"
check "ecom churn"   GET "/api/ecommerce/churn?from=$FROM&to=$TO"
check "ecom monthly" GET "/api/ecommerce/monthly?to=$TO"
check "ecom roas"    GET "/api/ecommerce/roas?from=$FROM&to=$TO"
check "report"       GET "/api/report?from=$FROM&to=$TO"

# Monthly Reports had NO smoke coverage until v3.100.0 — the GCS stub answered
# every read with the access list, so /api/report returned the users array with
# a 200 and nobody noticed. These assert the payload, not the status.
REPORT="/api/report?from=$FROM&to=$TO"
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
# A NEAR-TIE must not produce a "wrong column" warning: on package pages
# Appointments edges the configured Add to cart by 10%, under the 20% margin.
# A flat tie could not test this — it resolves to the configured event anyway,
# because ties keep KEY_EVENTS order and add_to_cart sorts first.
expect_field "ct no tie warning"   "$REPORT" "(d.content.types.find(t=>t.id==='package')||{}).suggestedAction===null?'ok':undefined"
# Articles: find_doctors clearly beats the configured view_item, so it IS flagged.
expect_field "ct article suggests" "$REPORT" "((d.content.types.find(t=>t.id==='article')||{}).suggestedAction||{}).id==='find_doctors'?'ok':undefined"
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
expect_field "ct article flagged"  "$REPORT" "(d.content.types.find(t=>t.id==='article')||{}).action==='view_item'?'ok':undefined"
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

echo "--- monthly report: TikTok field names and floors ---"
# reach is unique_video_views; there is no `reach` field on this connector.
expect_field "tk reach"            "$REPORT" "d.tiktok.channel.reach===17897?17897:undefined"
expect_field "tk profile views"    "$REPORT" "d.tiktok.channel.profileViews===1868?1868:undefined"
expect_field "tk bio link clicks"  "$REPORT" "d.tiktok.channel.bioLinkClicks===30?30:undefined"
# Two accounts post on the same date: one row per date would halve this.
expect_field "tk daily multi-acct" "$REPORT" "d.tiktok.channel.daily[0].views===66941?66941:undefined"
# v4 has a 50% like rate on 6 views. If the floor goes, it tops the ranking.
expect_field "tk rate floor holds" "$REPORT" "d.tiktok.top.likeRate.id==='v2'?'v2':undefined"
expect_field "tk top by favorites" "$REPORT" "d.tiktok.top.favorites.id==='v1'?'v1':undefined"
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
ECOM="/api/ecommerce?from=$FROM&to=$TO"
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
CEN="/api/ecommerce/centres?from=$FROM&to=$TO"
expect_field "centre count"     "$CEN" "d.centres.length===3?'3':undefined"
expect_field "centre at-risk"   "$CEN" "d.totals.unredeemedValue>0?'yes':undefined"
expect_field "centre discount"  "$CEN" "d.centres.some(c=>c.discountDepth!==null)?'yes':undefined"
expect_field "centre matrix"    "$CEN" "d.channels.length>=2?'ok':undefined"
expect_field "cmp on centres"   "$CEN" "d.centres.every(c=>'mom' in c && 'yoy' in c)?'ok':undefined"
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

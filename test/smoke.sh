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
check "ecommerce"  GET "/api/ecommerce?from=$FROM&to=$TO"
check "ecom centres" GET "/api/ecommerce/centres?from=$FROM&to=$TO"
check "ecom channels" GET "/api/ecommerce/channels?from=$FROM&to=$TO"
check "ecom migration" GET "/api/ecommerce/migration?from=$FROM&to=$TO"
check "ecom churn"   GET "/api/ecommerce/churn?from=$FROM&to=$TO"
check "ecom monthly" GET "/api/ecommerce/monthly?to=$TO"
check "ecom roas"    GET "/api/ecommerce/roas?from=$FROM&to=$TO"
echo "--- audiences field integrity (a dropped Windsor field must fail here) ---"
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

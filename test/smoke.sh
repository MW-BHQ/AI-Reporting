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

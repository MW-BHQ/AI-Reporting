# BHQ War Room · metric dictionary

_Generated from `public/metrics.json` by `node scripts/metrics-md.js`. Edit the JSON, not this file._

## Overview

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Impressions → Visits → Key events | How many times people saw us, how many came to the website, and how many then did something we want (book, call, chat, buy). | Impressions from every ad platform and social channel; visits and key events from GA4. | GA4, Meta, Google Ads, TikTok, LINE, Google Business Profile |
| Ad spend | Money spent on paid ads in the selected dates. | Sum of spend across Meta, Google Ads and TikTok, in THB. | Windsor (ad platforms) |
| Ad clicks · Cost per click | Clicks on paid ads, and what each click cost. | Cost per click = ad spend ÷ ad clicks. | Windsor (ad platforms) |
| Action without site visits | Calls, direction requests and other actions people took straight from Google or social, without opening the website. | Counted from each platform's own action figures. | Google Business Profile, Meta, LINE |
| MoM · YoY | Change against the same number of days just before, and against the same dates a year earlier. | (this period − comparison period) ÷ comparison period. | Same sources as the number |

## Monthly report

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Total visibility | Every time the hospital was seen online: ad and post impressions, Google profile views and search impressions. | Sum across channels for the month. | GA4, Search Console, Google Business Profile, ad platforms |
| Total visits | Sessions on the hospital website. | GA4 sessions for this hospital's site. | GA4 |
| Total contact us | Times someone tried to contact the hospital: call, LINE, chat, form, email. | Sum of the contact key events. | GA4 key events |
| Direction requests | Times someone asked Google Maps for directions to the hospital. | From the hospital's Google profile. | Google Business Profile |
| Appointments · initiates / completes | People who started booking an appointment online, and people who finished. | GA4 events for the booking flow; realtime = slots booked live, not realtime = request forms. | GA4 |
| Sessions by language | Visits split by the language version of the site (Thai, English, others). | Page path language segment. | GA4 |
| Channels | Where visits came from: search, paid, social, AI assistants, referral, direct. | GA4 default channel grouping, with AI assistants split out. | GA4 |
| Back links · referral sessions | Visits that arrived from links on other websites. | GA4 referral sessions by source site. | GA4 |

## Call out

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| The call out | The month's executive summary in Thai, drafted by Claude from the report's numbers. | Every number must come from the report's facts; the checker marks any figure it cannot find in red. | Monthly report facts |
| Red numbers | A figure the checker could not match to a fact. Fix or remove it before sending. | Compared against the facts list for the month. | Monthly report facts |

## Google Business Profile

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Views | How many times the hospital's Google listing was shown, in Search and in Maps. | Profile impressions, desktop and mobile. | Google Business Profile |
| Calls · Directions · Website clicks | Actions people took straight from the listing. | Counted by Google per day. | Google Business Profile |
| Action rate | Share of profile views that led to an action. | (calls + directions + website clicks + bookings) ÷ views. | Google Business Profile |
| What people searched | The search terms that showed the listing. | Google's monthly keyword report; small terms are hidden by Google. | Google Business Profile |
| All-time rating · Rating in period | The star rating Google shows, and the average of reviews left in the selected dates. | Average of 1–5 stars. | Google reviews |
| Complaints by theme | What reviewers complained about, month by month. Bubble size = number of complaints; darker = a bigger share of that month's written reviews. | Each written review is read by Claude and tagged with themes (wait time, staff, cost …) as praise or complaint. Counts complaints at any star rating; the toggle narrows to 1–3★. | Google reviews, tagged by Claude |
| Rating mix | How many reviews gave 5, 4, 3, 2 and 1 stars. | Count per star. | Google reviews |

## Campaigns

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Campaign code | The code in the UTM link and the ad name (e.g. 261001-05) that ties ads, visits and results to one campaign. | Matched on the code in utm_campaign and in each ad campaign's name. | GA4, Meta, Google Ads, TikTok |
| Ad spend | Money spent on ad campaigns carrying this code. | Sum over every ad campaign whose name carries the code. Each ad campaign appears once. | Windsor (ad platforms) |
| Spend with ~ | Spend shared across several traffic rows by their share of visits, because one platform fed more than one row. | Platform spend × the row's share of that platform's visits. | Windsor + GA4 |
| Cost per visit · Cost per contact | What one website visit, and one contact attempt, cost. | Ad spend ÷ visits; ad spend ÷ contact key events. | Windsor + GA4 |
| Key events · Revenue | Actions we count as results, and online revenue, from visits carrying the code. | GA4 key events and purchase revenue. | GA4 |
| Link CTR · Cost per link click | Share of ad impressions that led to a link click, and its cost. | Link clicks ÷ impressions; spend ÷ link clicks. | Meta |
| Sessions not recorded | Ad link clicks that never arrived as a website session (blocked tracking, quick bounce). | Landing page views or link clicks − GA4 sessions. | Meta + GA4 |

## Pages

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Views · Visitors | How often each page was opened, and by how many people. | GA4 page views and users per page. | GA4 |
| Engaged page views · Bounce rate | Views where the visitor stayed or interacted, and the share of sessions that left straight away. | GA4 engagement definitions. | GA4 |
| Scroll depth · Scroll reach | How far down the page people read. | Share of views reaching the scroll events. | GA4 |

## Meta benchmarks

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Latest complete month | The last full month, used so a half month does not look like a drop. | Calendar month before today. | Meta |
| Avg monthly spend · 3M / 6M / 12M | Typical monthly Meta spend over the last 3, 6 and 12 complete months. | Total spend ÷ number of months. | Meta |
| CPM · CPC · CTR | Cost per 1,000 impressions, cost per click, and click rate, to compare months and accounts. | Spend ÷ impressions × 1,000; spend ÷ clicks; clicks ÷ impressions. | Meta |

## Audiences

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Audience sets | Groups of ad sets that target the same people (interests, age, location). | Grouped by the ad set targeting. | Meta |
| Overall link CTR | Share of impressions that became a link click. | Link clicks ÷ impressions. | Meta |
| Landing page views | Link clicks where the landing page actually loaded. | Meta's landing page view action. | Meta |

## Tagging audit

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Untagged visits | Visits from ads whose link had no campaign code, so they cannot be tied to a campaign. | GA4 paid sessions without a recognised code. | GA4 |
| Key events lost to it | Results from those untagged visits. | GA4 key events on the same sessions. | GA4 |
| Unattributable ad spend | Spend on ad campaigns whose name carries no code. | Sum of spend on uncoded ad campaigns. | Windsor (ad platforms) |
| Codes tracking properly | Share of campaign codes seen both in ads and in GA4. | Codes found on both sides ÷ all codes. | Windsor + GA4 |

## Google Ads

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Spend · Clicks · Cost per click | Money spent, clicks received, and the average cost of a click. | Cost per click = spend ÷ clicks. | Google Ads (Windsor) |
| Carrying a campaign code | Share of spend on campaigns whose name carries a campaign code. | Coded spend ÷ all spend. | Google Ads (Windsor) |

## Google Ads benchmarks

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Latest complete month · Avg monthly spend | The last full month, and typical monthly spend over 3 and 12 months. | Total spend ÷ months. | Google Ads (Windsor) |
| CPC · CTR · Conversion rate | Cost per click, click rate, and conversions per click, to compare against our own past. | Spend ÷ clicks; clicks ÷ impressions; conversions ÷ clicks. | Google Ads (Windsor) |

## Better Club · Performance

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Monthly active members | Members who did anything in the app or on the site while signed in during the month. | Distinct member IDs with at least one event. | Better Club (BigQuery) |
| New · Retained · Reactivated · Lost | Where this month's actives came from: joined this month, active last month too, back after a gap, or active last month but not this one. | Each active member falls in exactly one group; lost counts last month's actives missing this month. | Better Club (BigQuery) |
| Daily active ÷ monthly active | How often an active member comes back within the month. Higher = more habitual use. | Average daily actives ÷ monthly actives. | Better Club (BigQuery) |
| Joiners back this month | Of last month's joiners, the share active again this month. | Joiners active this month ÷ last month's joiners. | Better Club (BigQuery) |

## Better Club · Quiz insight

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Quizzes in range · Members who answered | Daily quizzes run in the dates, and how many members answered at least one. | Count of quizzes; distinct members with an answer. | Better Club (BigQuery) |
| Answer share | Share of answering members who picked each option. | Answers for the option ÷ answers to the question. | Better Club (BigQuery) |

## Better Club · Revenue attribution

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Paying members | Members who paid the hospital in the month. | Distinct members with a hospital bill. | Better Club + hospital billing (BigQuery) |
| Revenue (THB) | Hospital revenue from Better Club members. | Sum of members' bills in the month. | Hospital billing (BigQuery) |
| Revenue from new members | Revenue from members who became new patients. | Bills of members whose first visit came after joining. | Hospital billing (BigQuery) |
| Have become patients · Median time to first visit | Share of members who have ever visited, and the typical days from joining to the first visit. | Members with a first visit ÷ all members; median days. | Better Club + hospital billing (BigQuery) |
| Top 1% / 10% of members | Share of revenue from the highest-spending members. | Their revenue ÷ all member revenue. | Hospital billing (BigQuery) |

## LINE broadcasts

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Delivered · Opened | Messages that reached members, and how many were opened. | Open rate = opened ÷ delivered. | LINE Official Account |
| Avg. reach | Average people reached per broadcast. | Delivered ÷ broadcasts. | LINE Official Account |

## E-commerce · Overview

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Revenue | Value of coupons sold in the dates, all sales channels. | Sum of coupon prices from published orders. | BHQ Income (BigQuery) |
| Coupons · Orders · AOV | Coupons sold, orders placed, and the average order value. | AOV = revenue ÷ orders. | BHQ Income (BigQuery) |
| Fees · Net · Take rate | Platform fees (transaction + commission), revenue after fees, and fees as a share of revenue. | Net = revenue − fees; take rate = fees ÷ revenue. | BHQ Income (BigQuery) |
| Online / Special / Complementary / Offline | Channel types. The scope switch shows online only or every type. | Each channel is assigned one type in the taxonomy. | BHQ Income (BigQuery) |
| Marketplace card | Shopee and Lazada's own shop reports, set beside the orders we recorded for them. | Shop figures from each platform's reports. | Shopee / Lazada (BigQuery) |

## E-commerce · Report

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Monthly revenue and coupons | Each month's sales, against the month before and a year before. | Same as the Overview, month by month. | BHQ Income (BigQuery) |
| YTD | Sales from 1 January to the end of the selected month. | Sum of months so far this year. | BHQ Income (BigQuery) |

## E-commerce · Campaigns

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Campaign revenue | Sales recorded under each marketplace campaign name. | Sum of coupon prices per campaign. | BHQ Income (BigQuery) |

## E-commerce · Channels

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Revenue · Share · MoM / YoY by channel | Each sales channel's revenue, its share of the total, and its change. | Channel revenue ÷ all revenue. | BHQ Income (BigQuery) |
| Take rate | Fees as a share of the channel's revenue. | Fees ÷ revenue. | BHQ Income (BigQuery) |

## Shopee

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Visitors · Orders · Sales | Shop visitors and confirmed orders and sales, as Shopee reports them. | Daily Seller Centre figures summed over the dates. | Shopee (BigQuery) |
| Conversion | Share of visitors who placed an order. | Orders ÷ visitors. | Shopee (BigQuery) |
| Shopee Ads · Shop Ads | On-platform ad spend and the sales Shopee credits to it (any purchase within 7 days of a click, so it is a credit, not a split). | ROAS = credited sales ÷ spend. | Shopee (BigQuery) |
| Off-platform traffic | Visits and orders sent to the shop from outside: website, LINE, Facebook. | Shopee's off-platform report by channel and campaign. | Shopee (BigQuery) |
| Packages | Each package's monthly sales, visits and ad spend. | Package Sales and Package Ads reports (whole months). | Shopee (BigQuery) |
| Buyers by age and gender | Who bought, new and existing. | Shopee's monthly buyer profile. | Shopee (BigQuery) |

## Seller-Voucher

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Orders with a voucher | Completed Shopee orders that used a discount code, and their share of all Shopee orders. | Voucher orders ÷ confirmed Shopee orders in the same days. | Shopee order lines + Shopee sales (BigQuery) |
| Voucher discount | Money taken off by codes, as a share of sales. | Each order's discount counted once (it repeats on every line of the export). | Shopee order lines (BigQuery) |
| All-in cost | Discount plus Shopee commission and transaction fee, as a share of sales. | (discount + commission + fee) ÷ sales. | Shopee order lines (BigQuery) |
| Average order · rest of shop | Average order with a code against every other Shopee order in the same days. | Rest of shop = all confirmed orders minus voucher orders. | Shopee (BigQuery) |
| Pile-up (minimum spend) | Whether a code's minimum spend makes buyers top up. 1.5× or more = it grows baskets; near 1× = it discounts orders that were that size anyway. | Share of code orders within 20% above the lowest order that used it ÷ the same share for orders without a code. The minimum is inferred, not typed in. | Shopee order lines (BigQuery) |
| Packages · with and without a code | How many of each package's orders used a code. | Without code = all Shopee orders for the package − completed voucher orders. | Shopee package sales + order lines (BigQuery) |

## Lazada

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Visitors · Orders · Revenue | Shop visitors, orders and revenue as Lazada reports them. | Daily Key Metrics summed over the dates. | Lazada (BigQuery) |
| Traffic sources | Where shop visitors came from. Level 1 is the total; level 2 splits it; level 3 lists top search terms only. | One level summed at a time, never mixed. | Lazada (BigQuery) |
| Products | Each product's visitors, orders and revenue. | Product rows (totals of their SKUs). | Lazada (BigQuery) |
| External links | Visits and sales from links outside Lazada (website, LINE, social). | Lazada's external traffic reports. | Lazada (BigQuery) |
| New · Existing buyers | Buyers buying for the first time and buyers who bought before. | Lazada's customer insight report. | Lazada (BigQuery) |

## E-commerce · Centers

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Revenue by center | Sales of each medical center's packages, and their change. | Package mapped to a center through its SKU; unmapped packages are shown apart. | BHQ Income (BigQuery) |

## E-commerce · Packages

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Revenue · Units by package | Sales and coupons for each package, grouped by name (one package keeps one row across promo cycles). | Sum of coupon prices per package name. | BHQ Income (BigQuery) |

## E-commerce · Ad performance

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Ad spend · Impressions · Link clicks · CPC | Spend and reach of the ad accounts that sell e-commerce packages. | Cost per click = spend ÷ link clicks. | Meta (Windsor) |
| ROAS | Online revenue for each baht of ad spend. | E-commerce revenue ÷ ad spend for the same dates. | Meta + BHQ Income (BigQuery) |

## E-commerce · Churn

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Customers in range · Lost | Customers who bought in the dates, and those whose last purchase is more than the window (365 days by default, a yearly check-up) before the end of the range. | Customer = hashed email/phone key. Loss is put on the channel and center of their LAST purchase. Every channel type counts, so a move to the clinic is not a loss. | BHQ Income (BigQuery) |
| Value walked out | What lost customers had spent. | Sum of lost customers' past orders. | BHQ Income (BigQuery) |
| Only ever bought once | Customers with a single purchase ever, reported apart from those who bought repeatedly and then stopped. | One-time buyers point at acquisition quality; lapsed repeat buyers at retention. | BHQ Income (BigQuery) |

## E-commerce · Migration

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Identifiable customers | Customers we can follow across orders (they left an email or phone). | Distinct hashed customer keys. | BHQ Income (BigQuery) |
| Came back another day · Changed channel type | Customers who bought again on a later day, and those whose later order was in a different channel type. | Compared order by order per customer. | BHQ Income (BigQuery) |
| Stickiness by starting point | Share of customers who came back, by the channel type of their first order. | Returners ÷ customers, per first channel type. | BHQ Income (BigQuery) |

## Topic Explorer

| Metric | What it means | How it is worked out | Source |
|---|---|---|---|
| Search terms | For a clinical topic you type, Claude lists what patients search in each of the hospital's languages: medical name, everyday words, related conditions, misspellings. | 5-10 terms per language, written in that language's script. | Claude |
| Search volume and our ranking | How often each term is searched and where our pages show for it. | Search Console clicks, impressions and position for the matched terms in the dates. | Google Search Console |

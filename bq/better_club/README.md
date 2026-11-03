# Better Club → BigQuery

Source: sheet "Better Club - Raw Data" `18jH1m3dpq5SsSIyPyc49374vuo6CPkJ0RElLAIG3FRo`.
Target: `ai-reporting-503911.better_club` (asia-southeast1).

| Sheet tab | Raw table | View (report reads this) | Key |
|---|---|---|---|
| customers | raw_customers | customers, customers_history, members | user_id |
| better_staff | raw_better_staff | staff (members.is_staff) | user_id |
| all_event | raw_all_event | events | event_id |
| badge_history | raw_badge_history | badges | badge_row_id |
| read_post | raw_read_post | post_reads | user_id + read_at + post_id |
| click_cta | raw_click_cta | cta_clicks | user_id + clicked_at + event + url |
| quiz_result | raw_quiz_result | quiz_answers | user_id + answered_at + quiz_title + question |

Rules
- raw_* only grows. A row is stored once (hash of its values). Never delete from it.
- Views dedupe on the key; the latest load wins. Fix a parse bug in the view, not the data.
- customers: the hash skips Exported at, so history holds one row per real change.
- Event views leave out email/phone/gender/dob; join `members` for those.
- All datetimes are Asia/Bangkok wall clock (DATETIME).
- `_ingest_log.rows_in_source = 0` means the sheet was not refreshed that day.

Change anything
1. Edit `TABS` in build.js → `node build.js`.
2. `node test.js` → run the output in BigQuery; it must end with `ALL BETTER CLUB BQ TESTS PASSED`.
3. Run 00_setup.sql, 20_views.sql, 10_ingest.sql (in that order).

Daily: scheduled query `CALL \`ai-reporting-503911.better_club.ingest\`();` at 06:00 Asia/Bangkok,
run as `715584769614-compute@developer.gserviceaccount.com` (the sheet is shared with it).

Later backfill from the dev's database (2024-2025): load into the same raw_* tables with
`_source = 'db'`; views dedupe across sources by key.

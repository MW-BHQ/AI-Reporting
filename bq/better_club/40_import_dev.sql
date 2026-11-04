-- DEV DATABASE EXPORTS (v3.386.0). The dev's files are the app's own tables,
-- not the sheet tabs: different columns, and times in UTC (+00:00) or +07:00,
-- where the sheet writes Bangkok wall-clock time. Upload each into its
-- import_dev_<tab> (all STRING, header row skipped), then CALL the _run.
--
-- Each run: converts every time to Bangkok wall clock, maps the dev's columns
-- onto the sheet's, and takes ONLY rows from before the sheet's first day for
-- that tab. The dev's ids, URLs and quiz titles do not match the sheet's, so
-- rows the sheet already holds would otherwise count twice.
SET @@location = 'asia-southeast1';

CREATE OR REPLACE TABLE `ai-reporting-503911.better_club.import_dev_click_cta` (
  id STRING, date_created STRING, user_id STRING, referer_url STRING,
  cta_desc_1 STRING, cta_desc_2 STRING, cta_desc_json STRING);
CREATE OR REPLACE TABLE `ai-reporting-503911.better_club.import_dev_quiz_result` (
  id STRING, date_created STRING, user_id STRING, quiz_id STRING, quiz_title STRING,
  answer STRING, event_desc_2 STRING, event_desc_json STRING, website_url STRING, point_earned STRING);
CREATE OR REPLACE TABLE `ai-reporting-503911.better_club.import_dev_read_post` (
  id STRING, date_created STRING, user_id STRING, post_id STRING, post_title STRING, post_type STRING,
  campaign_key STRING, website_url STRING, fpd_tags STRING, fpd_tag_names STRING, point_earned STRING);

-- Bangkok wall clock from an ISO time with an offset (2024-09-16T00:12:44+00:00).
CREATE OR REPLACE FUNCTION `ai-reporting-503911.better_club.bkk`(s STRING) AS (
  FORMAT_DATETIME('%F %T', DATETIME(SAFE.TIMESTAMP(TRIM(s)), 'Asia/Bangkok')));

-- First day the sheet holds for a raw table (rows from the daily load).
CREATE OR REPLACE PROCEDURE `ai-reporting-503911.better_club.import_dev_click_cta_run`(label STRING)
BEGIN
DECLARE run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
DECLARE cutoff DATE DEFAULT (SELECT MIN(DATE(`ai-reporting-503911.better_club.parse_dt`(date)))
  FROM `ai-reporting-503911.better_club.raw_click_cta` WHERE _source = 'sheet');
DECLARE n INT64;
CREATE TEMP TABLE m AS
SELECT NULLIF(TRIM(user_id), '') AS user_id, `ai-reporting-503911.better_club.bkk`(date_created) AS date,
  NULLIF(TRIM(cta_desc_1), '') AS event, CAST(NULL AS STRING) AS email, CAST(NULL AS STRING) AS phone,
  CAST(NULL AS STRING) AS gender, CAST(NULL AS STRING) AS dob, NULLIF(TRIM(referer_url), '') AS url
FROM `ai-reporting-503911.better_club.import_dev_click_cta`
WHERE NULLIF(TRIM(user_id), '') IS NOT NULL;
SET n = (SELECT COUNT(*) FROM m);
ASSERT (SELECT COUNTIF(date IS NULL) FROM m) = 0 AS 'click_cta: a dev time did not parse';
MERGE `ai-reporting-503911.better_club.raw_click_cta` r
USING (
  SELECT *, TO_HEX(SHA256(TO_JSON_STRING(STRUCT(user_id, date, event, email, phone, gender, dob, url)))) AS _h
  FROM m WHERE cutoff IS NULL OR DATE(`ai-reporting-503911.better_club.parse_dt`(date)) < cutoff
  QUALIFY ROW_NUMBER() OVER (PARTITION BY _h) = 1
) s
ON r._row_hash = s._h
WHEN NOT MATCHED THEN INSERT (user_id, date, event, email, phone, gender, dob, url, _row_hash, _source, _loaded_at)
  VALUES (s.user_id, s.date, s.event, s.email, s.phone, s.gender, s.dob, s.url, s._h, CONCAT('import:', label), run_at);
INSERT `ai-reporting-503911.better_club._ingest_log` VALUES (run_at, CONCAT('import:click_cta:', label), n, @@row_count);
END;

-- The dev's quiz_title is the QUESTION; a quiz is identified by quiz_id. A
-- multi-select answer may arrive as a JSON array; it is stored "a|b|c" like the sheet.
CREATE OR REPLACE PROCEDURE `ai-reporting-503911.better_club.import_dev_quiz_result_run`(label STRING)
BEGIN
DECLARE run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
DECLARE cutoff DATE DEFAULT (SELECT MIN(DATE(`ai-reporting-503911.better_club.parse_dt`(date_created)))
  FROM `ai-reporting-503911.better_club.raw_quiz_result` WHERE _source = 'sheet');
DECLARE n INT64;
CREATE TEMP TABLE m AS
SELECT NULLIF(TRIM(user_id), '') AS user_id, `ai-reporting-503911.better_club.bkk`(date_created) AS date_created,
  CAST(NULL AS STRING) AS email, CAST(NULL AS STRING) AS phone, CAST(NULL AS STRING) AS gender, CAST(NULL AS STRING) AS dob,
  CAST(NULL AS STRING) AS quiz_type, NULLIF(TRIM(website_url), '') AS url,
  CONCAT('quiz-', TRIM(quiz_id)) AS quiz_title, NULLIF(TRIM(quiz_title), '') AS question,
  IF(STARTS_WITH(TRIM(answer), '['),
     ARRAY_TO_STRING(ARRAY(SELECT JSON_VALUE(x) FROM UNNEST(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(TRIM(answer)))) x), '|'),
     NULLIF(TRIM(answer), '')) AS answer
FROM `ai-reporting-503911.better_club.import_dev_quiz_result`
WHERE NULLIF(TRIM(user_id), '') IS NOT NULL;
SET n = (SELECT COUNT(*) FROM m);
ASSERT (SELECT COUNTIF(date_created IS NULL) FROM m) = 0 AS 'quiz_result: a dev time did not parse';
MERGE `ai-reporting-503911.better_club.raw_quiz_result` r
USING (
  SELECT *, TO_HEX(SHA256(TO_JSON_STRING(STRUCT(user_id, date_created, email, phone, gender, dob, quiz_type, url, quiz_title, question, answer)))) AS _h
  FROM m WHERE cutoff IS NULL OR DATE(`ai-reporting-503911.better_club.parse_dt`(date_created)) < cutoff
  QUALIFY ROW_NUMBER() OVER (PARTITION BY _h) = 1
) s
ON r._row_hash = s._h
WHEN NOT MATCHED THEN INSERT (user_id, date_created, email, phone, gender, dob, quiz_type, url, quiz_title, question, answer, _row_hash, _source, _loaded_at)
  VALUES (s.user_id, s.date_created, s.email, s.phone, s.gender, s.dob, s.quiz_type, s.url, s.quiz_title, s.question, s.answer, s._h, CONCAT('import:', label), run_at);
INSERT `ai-reporting-503911.better_club._ingest_log` VALUES (run_at, CONCAT('import:quiz_result:', label), n, @@row_count);
END;

-- fpd_tags is a JSON array of tag names; the sheet spreads them over tag_1..tag_10.
CREATE OR REPLACE PROCEDURE `ai-reporting-503911.better_club.import_dev_read_post_run`(label STRING)
BEGIN
DECLARE run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP();
DECLARE cutoff DATE DEFAULT (SELECT MIN(DATE(`ai-reporting-503911.better_club.parse_dt`(date)))
  FROM `ai-reporting-503911.better_club.raw_read_post` WHERE _source = 'sheet');
DECLARE n INT64;
CREATE TEMP TABLE m AS
WITH s AS (
  SELECT *, ARRAY(SELECT TRIM(JSON_VALUE(x)) FROM UNNEST(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(fpd_tags))) x) AS t
  FROM `ai-reporting-503911.better_club.import_dev_read_post` WHERE NULLIF(TRIM(user_id), '') IS NOT NULL)
SELECT NULLIF(TRIM(user_id), '') AS user_id, `ai-reporting-503911.better_club.bkk`(date_created) AS date,
  NULLIF(TRIM(post_id), '') AS post_id, NULLIF(TRIM(post_type), '') AS post_type, NULLIF(TRIM(post_title), '') AS post_title,
  NULLIF(ARRAY_TO_STRING(t, ', '), '') AS fpd_tags, NULLIF(TRIM(point_earned), '') AS points_earned,
  t[SAFE_OFFSET(0)] AS tag_1, t[SAFE_OFFSET(1)] AS tag_2, t[SAFE_OFFSET(2)] AS tag_3, t[SAFE_OFFSET(3)] AS tag_4,
  t[SAFE_OFFSET(4)] AS tag_5, t[SAFE_OFFSET(5)] AS tag_6, t[SAFE_OFFSET(6)] AS tag_7, t[SAFE_OFFSET(7)] AS tag_8,
  t[SAFE_OFFSET(8)] AS tag_9, t[SAFE_OFFSET(9)] AS tag_10,
  CAST(NULL AS STRING) AS email, CAST(NULL AS STRING) AS phone, CAST(NULL AS STRING) AS gender, CAST(NULL AS STRING) AS dob,
  NULLIF(TRIM(website_url), '') AS url
FROM s;
SET n = (SELECT COUNT(*) FROM m);
ASSERT (SELECT COUNTIF(date IS NULL) FROM m) = 0 AS 'read_post: a dev time did not parse';
MERGE `ai-reporting-503911.better_club.raw_read_post` r
USING (
  SELECT *, TO_HEX(SHA256(TO_JSON_STRING(STRUCT(user_id, date, post_id, post_type, post_title, fpd_tags, points_earned, tag_1, tag_2, tag_3, tag_4, tag_5, tag_6, tag_7, tag_8, tag_9, tag_10, email, phone, gender, dob, url)))) AS _h
  FROM m WHERE cutoff IS NULL OR DATE(`ai-reporting-503911.better_club.parse_dt`(date)) < cutoff
  QUALIFY ROW_NUMBER() OVER (PARTITION BY _h) = 1
) s
ON r._row_hash = s._h
WHEN NOT MATCHED THEN INSERT (user_id, date, post_id, post_type, post_title, fpd_tags, points_earned, tag_1, tag_2, tag_3, tag_4, tag_5, tag_6, tag_7, tag_8, tag_9, tag_10, email, phone, gender, dob, url, _row_hash, _source, _loaded_at)
  VALUES (s.user_id, s.date, s.post_id, s.post_type, s.post_title, s.fpd_tags, s.points_earned, s.tag_1, s.tag_2, s.tag_3, s.tag_4, s.tag_5, s.tag_6, s.tag_7, s.tag_8, s.tag_9, s.tag_10, s.email, s.phone, s.gender, s.dob, s.url, s._h, CONCAT('import:', label), run_at);
INSERT `ai-reporting-503911.better_club._ingest_log` VALUES (run_at, CONCAT('import:read_post:', label), n, @@row_count);
END;

-- The sheet-shaped import tables for these three are not used for dev files.
DROP TABLE IF EXISTS `ai-reporting-503911.better_club.import_click_cta`;
DROP TABLE IF EXISTS `ai-reporting-503911.better_club.import_quiz_result`;
DROP TABLE IF EXISTS `ai-reporting-503911.better_club.import_read_post`;

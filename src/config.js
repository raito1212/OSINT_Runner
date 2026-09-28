'use strict';

// ============================================================
// src/config.js — bảng hằng số vận hành của runner (CommonJS, Node 20)
// Nguồn chân lý: plans/chitiet/thiet-ke-runner.md mục 5.1, áp dụng
// GHI ĐÈ của plans/KE_HOACH_LAM_LAI_ONLINE_FREE.md mục 2 (2.2.3):
//   SEEN_PRUNE_DAYS = 7 · SEEN_HASH_CAP = 200 · SEEN_URL_CAP = 100
//   (bỏ SEEN_PRUNE_DAYS 14 / SEEN_CAP_PER_SOURCE 500 của mảnh thiết kế).
// Mỗi hằng ghi nguồn gốc ngay phía trên (file:dòng của code được port).
// ============================================================

/** Quy ước "local-as-UTC": mốc +7h dùng chung với frontend (frontend format
 *  với timeZone:'UTC'). Chỉ dùng khi collector tự dựng timestamp không có sẵn.
 *  Nguồn: OSINT_Web/agent/src/pipeline/pipeline.service.js — resolveTimestamp. */
const TZ_OFFSET_MS = 7 * 3600 * 1000;

/** Timeout tải feed RSS / trang danh sách (ms).
 *  Nguồn: AutoCollectingNews/newsbot/config.py dòng 71 — HTTP_TIMEOUT_FEED = 25 (giây). */
const HTTP_TIMEOUT_FEED_MS = 25000;

/** Timeout tải bài gốc khi deep crawl (ms).
 *  Nguồn: newsbot/config.py dòng 72 — HTTP_TIMEOUT_ARTICLE = 20 (giây). */
const HTTP_TIMEOUT_ARTICLE_MS = 20000;

/** Số entry tối đa lấy từ mỗi nguồn mỗi lượt chạy.
 *  Nguồn: newsbot/config.py dòng 74 — MAX_FEED_ENTRIES = 40. */
const MAX_FEED_ENTRIES = 40;

/** Cắt nội dung bài gửi AI (ký tự).
 *  Nguồn: newsbot/config.py dòng 73 — MAX_ARTICLE_CHARS = 6000. */
const MAX_ARTICLE_CHARS = 6000;

/** Số nguồn quét song song.
 *  Nguồn: newsbot/config.py dòng 77 — FEED_WORKERS = 8. */
const COLLECT_CONCURRENCY = 8;

/** Số luồng deep crawl bài gốc song song.
 *  Nguồn: newsbot/config.py dòng 78 — FETCH_WORKERS = 6. */
const DEEPCRAWL_CONCURRENCY = 6;

/** Cap số item deep crawl mỗi nguồn mỗi lượt (vượt cap → dùng summary làm manh mối).
 *  Nguồn: thiet-ke-runner.md mục 5.1 — hằng mới của runner. */
const MAX_DEEPCRAWL_PER_SOURCE = 8;

/** Số bài phân tích mỗi lần gọi Gemini (gọi theo lô chống rate limit).
 *  Nguồn: newsbot/config.py dòng 81 — STAGE2_BATCH = 5. */
const AI_BATCH = 5;

/** Giãn cách tối thiểu giữa 2 request Gemini (ms) — ~8.5 RPM, dưới ngưỡng
 *  free ~10 RPM của Gemini 2.5 Flash. (config.py dòng 82 GLM_MIN_INTERVAL_S = 6.5
 *  là con số cho GLM; runner Gemini lấy 7s theo thiet-ke-runner.md mục 5.1/8.1.) */
const GEMINI_MIN_INTERVAL_MS = 7000;

/** Timeout mỗi request Gemini (ms) — fail nhanh, chống treo cả lượt chạy.
 *  Nguồn: newsbot/config.py dòng 85 — GLM_TIMEOUT_S = 60 (giây). */
const GEMINI_TIMEOUT_MS = 60000;

/** Số lần thử mỗi request Gemini (backoff 3/6/12/24 giây — xem ai/gemini.js).
 *  Nguồn: newsbot/config.py dòng 86 — GLM_MAX_RETRIES = 4. */
const GEMINI_MAX_RETRIES = 4;

/** Ngân sách thời gian cho toàn bộ đợt gọi Gemini (ms) — hết hạn thì phần bài
 *  còn lại chuyển fallback. config.py dòng 87 GLM_BUDGET_S = 1680 (28 phút) là
 *  cho job Python dài 45+ phút; workflow runner timeout 10 phút nên co còn 6 phút. */
const GEMINI_BUDGET_MS = 360000;

/** Cap số bài mới ghi mỗi lượt chạy — bảo vệ không vượt timeout workflow 10 phút.
 *  Nguồn: thiet-ke-runner.md mục 5.1 — hằng mới của runner. */
const MAX_NEW_POSTS_PER_RUN = 80;

/** Xóa mục seen cũ hơn N ngày. GHI ĐÈ theo KE_HOACH mục 2.2.3 = 7 ngày
 *  (7 ngày > TTL mặc định 3 ngày = biên an toàn) — KHÔNG dùng 14 của
 *  newsbot/config.py dòng 76 (STATE_PRUNE_DAYS) hay mảnh thiết kế cũ. */
const SEEN_PRUNE_DAYS = 7;

/** Cap mảng seen_hashes [{h,t}] mỗi nguồn. GHI ĐÈ theo KE_HOACH mục 2.2.3 = 200
 *  (bỏ SEEN_CAP_PER_SOURCE 500 của mảnh thiết kế runner). */
const SEEN_HASH_CAP = 200;

/** Cap mảng seen_urls [{u,t}] mỗi nguồn. GHI ĐÈ theo KE_HOACH mục 2.2.3 = 100. */
const SEEN_URL_CAP = 100;

/** TTL bài viết mặc định (ngày) — chỉnh được trong tenants/{t}/settings/main.ttlDays (1–30).
 *  Nguồn: KE_HOACH mục 0.2 + 2.2.4. */
const TTL_DEFAULT_DAYS = 3;

/** Model Gemini mặc định — ghi đè được bằng settings.geminiModel (KHÔNG gemini_model).
 *  Nguồn: KE_HOACH mục 2.2.4 + 2.4 — MỘT settings.geminiModel dùng chung runner + browser. */
const GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash';

/** User-Agent Chrome cho mọi request HTTP của collector (axios / rss-parser).
 *  Nguồn: newsbot/config.py dòng 67–70 — USER_AGENT. */
const USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
);

/** Số cặp từ điển (EN→VN) tối đa đọc từ Firestore mỗi lượt chạy.
 *  Nguồn: thiet-ke-runner.md mục 5.3 bước 1 — cap 1000 cặp. */
const DICTIONARY_READ_CAP = 1000;

/** Số cặp glossary tối đa chèn vào system prompt Gemini (lớp prompt tự cắt).
 *  Nguồn: thiet-ke-runner.md mục 8.2 + KE_HOACH P2 ("glossary cap 300"). */
const GLOSSARY_CAP = 300;

module.exports = {
    TZ_OFFSET_MS,
    HTTP_TIMEOUT_FEED_MS,
    HTTP_TIMEOUT_ARTICLE_MS,
    MAX_FEED_ENTRIES,
    MAX_ARTICLE_CHARS,
    COLLECT_CONCURRENCY,
    DEEPCRAWL_CONCURRENCY,
    MAX_DEEPCRAWL_PER_SOURCE,
    AI_BATCH,
    GEMINI_MIN_INTERVAL_MS,
    GEMINI_TIMEOUT_MS,
    GEMINI_MAX_RETRIES,
    GEMINI_BUDGET_MS,
    MAX_NEW_POSTS_PER_RUN,
    SEEN_PRUNE_DAYS,
    SEEN_HASH_CAP,
    SEEN_URL_CAP,
    TTL_DEFAULT_DAYS,
    GEMINI_MODEL_DEFAULT,
    USER_AGENT,
    DICTIONARY_READ_CAP,
    GLOSSARY_CAP,
};

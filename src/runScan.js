'use strict';

/**
 * runScan.js — ORCHESTRATOR CHÍNH của runner GitHub Actions (kế hoạch P2).
 *
 * Luồng 11 bước theo plans/KE_HOACH_LAM_LAI_ONLINE_FREE.md mục P2 + 2.1/2.2/2.2.3/2.2.5/2.5/2.6
 * và plans/chitiet/thiet-ke-runner.md mục 5.3 — mọi chỗ mâu thuẫn thì KẾ HOẠCH CHÍNH THẮNG
 * (GHI ĐÈ: inputs 5 trường, settings/main + ai_rules/main, scan_state seen dạng MẢNG cap 200/100
 * prune 7 ngày, posts FLAT đúng tên trường, merge chỉ giữ done, postId web_<md5(normalizeUrl)>,
 * thông điệp SPA nguyên văn).
 *
 * Logic port (tham khảo; module chuyên trách đã port riêng — ở đây chỉ điều phối):
 * - AutoCollectingNews/main.py L109-241: khung lượt chạy — lọc seen + cửa sổ giờ, dry-run in
 *   ứng viên, re-check cửa sổ bằng ngày GỐC sau khi mở bài (ngày Google News trẻ hơn thật tới 44h).
 * - OSINT_Web/agent/src/pipeline/pipeline.service.js:
 *     L816-884   anchor mode nguồn website (quét đầu đặt mốc bỏ hết; quét sau giữ item TRƯỚC
 *                anchor; anchor mất → giữ ANCHOR_SAFE_LIMIT item mới nhất; có mới → advance),
 *     L919-967   prefix-merge dedup trong lô (đã port vào rules/dedup.js),
 *     L1049-1114 deep crawl fetchFullContent + re-check cửa sổ bằng ngày gốc,
 *     L1295-1307 merge giữ bản dịch cũ khi quét lại (đã port vào firebase.js writePosts).
 * - OSINT_Web/agent/src/services/sourceScanState.js L39-47: lastError {type, message, timestamp}.
 *
 * Ràng buộc: KHÔNG require('firebase-admin') trực tiếp (mọi Firestore qua src/firebase.js),
 * KHÔNG log key Gemini / dispatchToken (chỉ 4 ký tự cuối), một nguồn hỏng không làm sập lượt chạy.
 */

const fs = require('fs');
const pLimit = require('p-limit');

const config = require('./config');
const fb = require('./firebase');
const { fetchRss } = require('./collectors/rss');
const { fetchGnews } = require('./collectors/gnews');
const { fetchTelegram } = require('./collectors/telegram');
const { collectWebsite, fetchFullContent, NeedsBrowserError } = require('./collectors/website');
const { isJunkItem } = require('./rules/junkFilter');
// rules/dedup.js: MỘT công thức hash/postId dùng chung 3 lớp web–runner–agent (mục 2.1)
const { urlUid, normHash, contentHash, prefixMerge, dedupeBatch, computePostId } = require('./rules/dedup');
// rules/anchor.js: applyAnchor gói trọn luồng anchor (quét đầu / quét sau / anchor trôi)
const { applyAnchor, SAFE_LIMIT } = require('./rules/anchor');
const { GeminiClient } = require('./ai/gemini');
const { buildSystemPrompt } = require('./ai/prompts');
const { enrichFallback } = require('./ai/fallback');
const { detectLanguage } = require('./language/detector');

// Thông điệp BẮT BUỘC NGUYÊN VĂN theo kế hoạch 2.2.5 (GHI ĐÈ 7)
const NEEDS_BROWSER_MESSAGE = 'Nguồn SPA cần trình duyệt — chưa hỗ trợ. Hãy dùng RSS của trang hoặc nguồn social_generic';
// Kế hoạch 2.2/P2: glossary nhét vào prompt Gemini tối đa 300 cặp EN→VN
const GLOSSARY_CAP = config.GLOSSARY_CAP || 300;
// Cửa sổ mặc định 26h — trùng default input `lastHours` của workflow (kế hoạch 2.6)
const DEFAULT_LAST_HOURS = 26;
// config.js (agent song song) chưa export 2 hằng chọn nguồn — fallback local đúng
// hợp đồng thiết kế 5.1 để không phụ thuộc thứ tự hoàn thiện module kề nhau.
const HTTP_SOURCE_TYPES = config.HTTP_SOURCE_TYPES || ['rss', 'gnews', 'telegram', 'website'];
const SOURCE_SCAN_ORDER = config.SOURCE_SCAN_ORDER || ['rss', 'gnews', 'telegram', 'website'];

// Dispatch theo type nguồn → collector tương ứng (mục 5.3 bước 3)
const COLLECTORS = { rss: fetchRss, gnews: fetchGnews, telegram: fetchTelegram, website: collectWebsite };

// ============ HELPER ============

// Che bí mật khi cần log: chỉ giữ 4 ký tự cuối (ràng buộc: không log key/token)
const maskSecret = (v) => (v ? '...' + String(v).slice(-4) : '(rỗng)');

// Lọc ảnh nhiễu UI (port pipeline.service.js L1273-1275) + cap 12 ảnh/bài
const cleanImages = (imgs) => (Array.isArray(imgs) ? imgs : [])
    .filter((img) => typeof img === 'string' && !img.includes('rsrc.php') && !img.includes('static.xx') && !img.includes('emoji'))
    .slice(0, 12);

// Item collector có 2 dạng shape: website theo agent ({text, metadata:{url,title,images,...}}),
// rss/gnews/telegram port Python ({title, url, published, summary}). Truy cập qua helper chung.
const urlOf = (it) => it.url || (it.metadata && it.metadata.url) || null;
const titleOf = (it) => it.title || (it.metadata && it.metadata.title) || null;
const textOf = (it) => (it.text != null ? it.text : it.summary) || '';
const imagesOf = (it) => it.images || (it.metadata && it.metadata.images) || [];
const authorOf = (it) => it.author || (it.metadata && it.metadata.author) || null;
const publishedOf = (it) => it.published
    || (it.metadata && (it.metadata.detected_date || it.metadata.post_timestamp
        || it.metadata.published_date || it.metadata.date))
    || null;

// Chuỗi ngày → mili-giây; không parse được → null (xem như KHÔNG có ngày — vẫn giữ bài)
const toMs = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
};

// scan_state chuẩn 2.2.3: seen_hashes/seen_urls là MẢNG [{h|u, t}]; chịu cả dạng map cũ
// ({giá_trị: iso}) phòng dữ liệu chưa migrate — đều quy về danh sách giá trị.
const seenValues = (val, keyField) => {
    if (Array.isArray(val)) return val.map((e) => (e && e[keyField]) || null).filter(Boolean);
    if (val && typeof val === 'object') return Object.keys(val);
    return [];
};

// Chuẩn hóa input sourceIds: nhận 'all' (có thể bọc quote từ workflow), JSON array string,
// mảng sẵn, hoặc 1 id lẻ. Trả về 'all' hoặc mảng chuỗi.
const normSourceIds = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x));
    const s = String(v === undefined || v === null ? 'all' : v).trim();
    if (/^["']?all["']?$/i.test(s)) return 'all';
    try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr)) return arr.map((x) => String(x));
    } catch (_) { /* chuỗi thường — coi như 1 id */ }
    return [s];
};

// analyzeBatch trả kết quả theo index — chịu cả 3 dạng: Map, mảng, object {index: kết quả}
const pickAiResult = (results, i) => {
    if (!results) return null;
    if (typeof results.get === 'function') return results.get(i) || null;
    return results[i] || null;
};

// Đánh dấu seen cho item bị bỏ (vì cũ sau deep crawl): ghi cả hash dạng list (summary) lẫn
// dạng full-text để lượt sau khớp ở bất kỳ tầng nào; urlUid chống tải lại cùng URL.
const markSeenDrop = (rec, it) => {
    const t = String(textOf(it) || '');
    if (t) rec.seenDrops.push({ h: normHash(t) }); // bỏ hash chuỗi rỗng — chống trùng oan
    const full = it.__full;
    if (full && full.text) rec.seenDrops.push({ h: normHash(full.text) });
    const u = urlOf(it);
    if (u) rec.seenDrops.push({ u: urlUid(u) });
};

const isNeedsBrowser = (err) => Boolean(err)
    && ((NeedsBrowserError && err instanceof NeedsBrowserError) || err.name === 'NeedsBrowserError');

const fatal = (message, exitCode) => {
    const e = new Error(message);
    e.exitCode = exitCode;
    return e;
};

/**
 * runScan({tenantId, sourceIds, lastHours, dryRun, dispatchToken}) — 11 bước mục 5.3 (có GHI ĐÈ).
 * Trả summary {runId, sources, items, newPosts, aiOk, fallback, errors, durationS}.
 * Lỗi nguyên tắc: throw Error gán .exitCode (2 = dispatchToken sai, 1 = runner bị tắt).
 */
async function runScan({ tenantId, sourceIds, lastHours, dryRun = false, dispatchToken } = {}) {
    const t0 = Date.now();
    const hoursNum = Number(lastHours);
    const windowHours = Number.isFinite(hoursNum) && hoursNum > 0 ? hoursNum : DEFAULT_LAST_HOURS;
    const cutoff = Date.now() - windowHours * 3600 * 1000;
    const wanted = normSourceIds(sourceIds);

    // ===== B1: init + đọc 1 lần settings/ai_rules/dictionary/sources + kiểm tra dispatchToken =====
    await fb.initFirebase();
    const settings = (await fb.readSettings(tenantId)) || {};
    const aiRules = (await fb.readAiRules(tenantId)) || {};
    const glossary = (await fb.readDictionary(tenantId, GLOSSARY_CAP)) || [];
    const allSources = (await fb.listActiveSources(tenantId)) || [];

    // GHI ĐÈ 1: không dryRun → bắt buộc so dispatchToken với settings.dispatchToken của tenant đích.
    // mismatch HOẶC settings chưa đặt token → thoát 2 (chặn member tenant A dispatch tenant B — 2.6).
    if (!dryRun) {
        if (dispatchToken !== settings.dispatchToken || !settings.dispatchToken) {
            console.error('[SECURITY] dispatchToken không khớp tenant "' + tenantId + '" (nhận ' + maskSecret(dispatchToken) + ', settings ' + maskSecret(settings.dispatchToken) + ') — thoát 2');
            throw fatal('dispatchToken không khớp tenant', 2);
        }
    }
    // GHI ĐÈ 8: check mềm — trường thiếu coi như chạy bình thường, chỉ === false mới thoát 1
    if (settings.runnerEnabled === false) {
        console.error('[CONFIG] Runner đang bị tắt qua settings.runnerEnabled = false — thoát 1');
        throw fatal('Runner đã bị tắt qua settings.runnerEnabled', 1);
    }

    // ===== B2: chọn nguồn HTTP-thuần active; thứ tự SOURCE_SCAN_ORDER, trong loại sort theo tên =====
    const httpTypes = new Set(HTTP_SOURCE_TYPES);
    const active = allSources.filter((s) => s && s.id && httpTypes.has(s.type) && s.active !== false);
    const byId = new Map(active.map((s) => [s.id, s]));
    let selected = active;
    if (wanted !== 'all') {
        selected = [];
        for (const id of wanted) {
            if (byId.has(id)) selected.push(byId.get(id));
            else console.log('[WARN] sourceId "' + id + '" bị bỏ (không tồn tại / không active / không phải HTTP-thuần)');
        }
    }
    const typeRank = new Map(SOURCE_SCAN_ORDER.map((t, i) => [t, i]));
    selected = selected.slice().sort((a, b) =>
        ((typeRank.get(a.type) ?? 99) - (typeRank.get(b.type) ?? 99))
        || String(a.name || '').localeCompare(String(b.name || '')));

    console.log('[RUN] Tenant "' + tenantId + '"' + (dryRun ? ' (DRY-RUN — không ghi Firestore, không gọi Gemini)' : '')
        + ' · cửa sổ ' + windowHours + 'h · ' + selected.length + '/' + active.length + ' nguồn HTTP-thuần · nguồn: '
        + (wanted === 'all' ? 'all' : wanted.join(', ')));
    if (selected.length === 0) {
        console.log('[WARN] Không có nguồn nào hợp lệ — kết thúc lượt chạy rỗng');
    }

    // ===== B3: đọc scan_state TOÀN BỘ nguồn 1 LẦN (tiết kiệm read) =====
    const statesRaw = await fb.getScanStates(tenantId);
    const scanStates = {};
    if (Array.isArray(statesRaw)) {
        for (const st of statesRaw) if (st && st.source_id) scanStates[st.source_id] = st;
    } else if (statesRaw && typeof statesRaw === 'object') {
        Object.assign(scanStates, statesRaw);
    }

    // ===== B4 + B5: quét concurrency + quy tắc thuần per nguồn =====
    // (junkFilter → prefixMerge → dedup lô → anchor website → seen vs scan_state → cửa sổ giờ)
    const collectLimit = pLimit(config.COLLECT_CONCURRENCY);
    const records = await Promise.all(selected.map((source, i) => collectLimit(async () => {
        const ts = Date.now();
        const state = scanStates[source.id] || {};
        // rec: bản ghi per nguồn — chạy suốt từ quét tới bước ghi Firestore
        const rec = { source, rawCount: 0, candidates: [], anchorPatch: null, seenDrops: [], error: null, durationS: 0 };
        try {
            const collector = COLLECTORS[source.type];
            if (!collector) throw new Error('Không có collector cho type "' + source.type + '"');
            const collected = await collector(source);
            const items = Array.isArray(collected) ? collected : ((collected && collected.items) || []);
            let cand = items.slice();
            rec.rawCount = cand.length;

            // website hỏng KHÔNG throw — trả {items: [], lastError} (hợp đồng collectors/website.js);
            // rss/gnews/telegram hỏng → throw Error.lastErrorType (bắt ở catch dưới).
            const softError = (collected && !Array.isArray(collected) && collected.lastError) || null;
            if (softError && cand.length === 0) {
                throw Object.assign(new Error(String(softError.message || 'Lỗi quét nguồn')), {
                    lastErrorType: softError.type || 'scan_error',
                });
            }

            // Chuẩn hoá item về dạng nội bộ {text, title, url, images, author, published}:
            // rss/gnews/telegram trả `summary`, website trả `text` — quy về MỘT field `text`
            // để mọi tầng rules (prefixMerge/dedupeBatch/applyAnchor đều đọc it.text) chạy đúng.
            cand = cand.map((it) => ({
                text: String((it && (it.text != null ? it.text : it.summary)) || ''),
                title: (it && it.title) || null,
                url: urlOf(it),
                images: imagesOf(it),
                author: authorOf(it) || (it && it.origin_name) || null,
                published: publishedOf(it),
            }));

            // 5a. junkFilter — bỏ item rác/UI-label (rules/junkFilter.js port facebook.js).
            // Probe = title + text theo ghi chú header junkFilter.js: feed chỉ có headline
            // (summary rỗng/ngắn) vẫn qua sàn 30 ký tự của quy tắc "Ý nghĩa quá ngắn".
            cand = cand.filter((it) => {
                const probe = String(titleOf(it) || '') + (titleOf(it) ? '. ' : '') + String(textOf(it) || '');
                return !isJunkItem(probe);
            });

            // 5b. prefixMerge — gộp item trùng trong lô dạng tiền tố (rules/dedup.js port pipeline L919-967)
            cand = prefixMerge(cand);

            // 5c. dedup trong lô theo urlUid + normHash (rules/dedup.js::dedupeBatch — công thức 2.1)
            cand = dedupeBatch(cand);

            // 5d. anchor flow — CHỈ nguồn website (rules/anchor.js::applyAnchor port pipeline L816-884)
            if (source.type === 'website' && cand.length > 0) {
                const hadAnchor = Boolean(state.anchor_text_hash);
                const anchorRes = applyAnchor(cand, state);
                if (anchorRes.useAnchor && !hadAnchor) {
                    console.log('[ANCHOR] Quét đầu "' + source.name + '" — đặt mốc, bỏ ' + cand.length + ' item');
                } else if (anchorRes.useAnchor && !anchorRes.anchorFound) {
                    console.log('[ANCHOR] Không thấy anchor "' + source.name + '" — giữ ' + SAFE_LIMIT + ' item mới nhất');
                }
                if (anchorRes.anchor) {
                    // patch cho B10 ghi scan_state (use_anchor bật giữ cho lượt sau)
                    rec.anchorPatch = Object.assign({ use_anchor: true }, anchorRes.anchor);
                }
                cand = anchorRes.items;
            }

            // 5e. seen dedup vs scan_state (norm_hash ∈ seen_hashes.h, urlUid ∈ seen_urls.u — 2.2.3)
            const seenH = new Set(seenValues(state.seen_hashes, 'h'));
            const seenU = new Set(seenValues(state.seen_urls, 'u'));
            cand = cand.filter((it) => {
                const u = urlOf(it);
                const uid = u ? urlUid(u) : null;
                if ((uid && seenU.has(uid)) || seenH.has(normHash(String(textOf(it) || '')))) return false;
                return true;
            });

            // 5f. time filter theo published của collector; published null → GIỮ (ghi debug gộp 1 dòng)
            let noDate = 0;
            cand = cand.filter((it) => {
                const ms = toMs(publishedOf(it));
                if (ms === null) { noDate += 1; return true; }
                if (ms < cutoff) {
                    markSeenDrop(rec, it); // bỏ vì cũ — vẫn đánh dấu seen (B10: kể cả bài bỏ vì cũ)
                    return false;
                }
                return true;
            });
            if (noDate > 0) console.log('[DEBUG] "' + source.name + '": ' + noDate + ' item không có ngày đăng — vẫn giữ theo kế hoạch');

            rec.candidates = cand;
        } catch (err) {
            // GHI ĐÈ 7: SPA → needs_browser thông điệp NGUYÊN VĂN; lỗi khác → lastErrorType
            // do collector gắn ('geoblocked'/'scan_error'/...) — nguồn kế vẫn chạy
            if (isNeedsBrowser(err)) {
                rec.error = { type: 'needs_browser', message: NEEDS_BROWSER_MESSAGE };
            } else {
                rec.error = {
                    type: (err && (err.lastErrorType || err.type)) || 'scan_error',
                    message: String((err && err.message) || err).slice(0, 500),
                };
            }
        }
        rec.durationS = (Date.now() - ts) / 1000;
        if (rec.error) {
            console.log('[' + (i + 1) + '/' + selected.length + '] ⚠️ ' + source.type + ' | ' + source.name + ': ' + rec.error.message + ' (' + rec.durationS.toFixed(1) + 's)');
        } else {
            console.log('[' + (i + 1) + '/' + selected.length + '] ✅ ' + source.type + ' | ' + source.name + ': ' + rec.rawCount + ' item (' + rec.candidates.length + ' mới, ' + rec.durationS.toFixed(1) + 's)');
        }
        return rec;
    })));

    // ===== B6: deep crawl — website + gnews item có URL bài gốc ≠ trang danh sách =====
    // Telegram KHÔNG deep crawl (t.me không có trang bài riêng — pages.py). Vượt cap/nguồn →
    // dùng summary làm manh mối (vẫn ghi bài).
    const crawlLimit = pLimit(config.DEEPCRAWL_CONCURRENCY);
    const crawlJobs = [];
    for (const rec of records) {
        if (rec.error || rec.candidates.length === 0) continue;
        const src = rec.source;
        if (src.type !== 'website' && src.type !== 'gnews') continue;
        let budget = config.MAX_DEEPCRAWL_PER_SOURCE;
        for (const it of rec.candidates) {
            const u = urlOf(it);
            if (!u || u === src.url) continue; // không có URL bài riêng
            if (budget <= 0) continue; // vượt cap → không mở bài, giữ summary làm manh mối
            budget -= 1;
            crawlJobs.push(crawlLimit(async () => {
                try {
                    // hợp đồng website.js: {text, publishedDate: Date|null} | null (KHÔNG phải mảng)
                    const art = await fetchFullContent(u, src.detail_selector, src.exclude_selector);
                    if (art && art.text) {
                        it.__full = {
                            text: art.text,
                            detected_date: (art.publishedDate && typeof art.publishedDate.toISOString === 'function')
                                ? art.publishedDate.toISOString()
                                : null,
                        };
                    }
                } catch (e) {
                    console.log('[DEEPCRAWL] ⚠️ Lỗi mở bài ' + u + ': ' + ((e && e.message) || e));
                }
            }));
        }
    }
    if (crawlJobs.length > 0) {
        console.log('[DEEPCRAWL] Mở ' + crawlJobs.length + ' bài gốc (cap ' + config.MAX_DEEPCRAWL_PER_SOURCE + '/nguồn, concurrency ' + config.DEEPCRAWL_CONCURRENCY + ')...');
        await Promise.all(crawlJobs);
    }
    // Re-check cửa sổ bằng publishedDate GỐC bóc từ trang bài sau deep crawl — MỌI nguồn
    // (thiết kế 5.3 bước 5); gnews là nguồn chính cần vì ngày feed trẻ hơn thật tới 44h
    // (port main.py L190-226); cũ hơn cửa sổ → đánh dấu seen + bỏ
    for (const rec of records) {
        if (rec.error) continue;
        rec.candidates = rec.candidates.filter((it) => {
            const art = it.__full;
            if (!art || !art.detected_date) return true;
            const ms = toMs(art.detected_date);
            if (ms !== null && ms < cutoff) {
                markSeenDrop(rec, it);
                console.log('[DEEPCRAWL] Bỏ bài cũ theo ngày gốc: ' + urlOf(it));
                return false;
            }
            return true;
        });
    }

    // ===== B7: build post docs — schema 2.2 FLAT, đúng tên trường (GHI ĐÈ 4) =====
    const nowIso = new Date().toISOString();
    const posts = []; // {post, sourceId, itemHash} — wrapper giữ field nội bộ, KHÔNG đưa vào doc
    for (const rec of records) {
        if (rec.error) continue;
        const src = rec.source;
        for (const it of rec.candidates) {
            const url = urlOf(it) || src.url;
            const full = it.__full || null;
            const text = String((full && full.text) || textOf(it) || '').trim();
            if (!text) continue; // không có nội dung gì → bỏ, chống doc rỗng
            const lang = await detectLanguage(text, src.id);
            const post = {
                post_id: computePostId(url), // 'web_' + md5(normalizeUrl(url)) — 2.1 (rules/dedup.js)
                text,
                raw_text: text, // runner ghi 2 trường = nội dung gốc (GHI ĐÈ 4)
                title: titleOf(it) || null, // deep crawl chỉ trả text + ngày (không có title)
                url,
                timestamp: (full && full.detected_date) || publishedOf(it) || null, // ISO TỪ NGUỒN — pass-through, KHÔNG +7h
                images: cleanImages(imagesOf(it)),
                author: authorOf(it),
                detected_language: lang,
                translated_en: null, // runner để null — browser/agent lo (GHI ĐÈ 4)
                translated_vi: null, // AI/fallback điền ở B8
                summary: null,
                labels: null,
                priority: null,
                reason: null,
                ai_model: null,
                ai_used: null, // 'gemini' | 'fallback-gtx' | null — điền ở B8
                processingStatus: 'new',
                norm_hash: normHash(text), // sha256(text bỏ khoảng trắng, lowercase) — 2.1
                content_hash: contentHash(text), // sha256(text) — 2.1 (rules/dedup.js)
                source_id: src.id,
                source_name: String(src.name || ''),
                source_url: String(src.url || url),
                platform: src.type, // platform = type nguồn (GHI ĐÈ 4)
                collected_via: 'runner',
                collected_at: nowIso,
                created_at: nowIso,
                updated_at: nowIso,
                // expiresAt (Firestore Timestamp) do writePosts ghi theo ttlDays — runScan không đụng firebase-admin
            };
            // itemHash: hash dạng list (trước deep crawl) — thêm vào seen cho khớp lượt sau quét lại
            posts.push({ post, sourceId: src.id, itemHash: normHash(String(textOf(it) || '')) });
        }
    }

    // ===== B8: AI — gom bài mới CẢ lượt chạy → cap → Gemini batch, bài trượt đi fallback =====
    let kept = posts;
    let cappedCount = 0;
    if (posts.length > config.MAX_NEW_POSTS_PER_RUN) {
        kept = posts.slice(0, config.MAX_NEW_POSTS_PER_RUN);
        cappedCount = posts.length - kept.length;
        console.log('[CAP] ' + posts.length + ' bài mới vượt cap ' + config.MAX_NEW_POSTS_PER_RUN + ' — ' + cappedCount + ' bài KHÔNG ghi & KHÔNG đánh dấu seen (lượt sau quét lại)');
    }
    let aiOk = 0;
    let fallbackCount = 0;

    // enrichFallback(text, lang, timestampIso) TRẢ kết quả (không mutate post) — hợp đồng ai/fallback.js
    const runFallback = async (post) => {
        try {
            // protect (số/tên riêng) đã bọc BÊN TRONG fallback.js — không che 2 lần
            const r = await enrichFallback(post.text, post.detected_language, post.timestamp);
            if (r) {
                if (r.translated_vi != null) post.translated_vi = r.translated_vi;
                if (r.summary != null) post.summary = r.summary;
                if (r.labels != null) post.labels = r.labels;
                if (r.priority != null) post.priority = r.priority;
                if (r.reason != null) post.reason = r.reason;
            }
        } catch (e) {
            console.log('[AI] ⚠️ Fallback gtx lỗi cho ' + post.url + ': ' + ((e && e.message) || e));
        }
        post.ai_used = 'fallback-gtx';
        post.ai_model = null;
    };

    if (!dryRun && kept.length > 0) {
        if (settings.geminiKey) {
            const model = settings.geminiModel || config.GEMINI_MODEL_DEFAULT;
            let results = null;
            try {
                const client = new GeminiClient({ apiKey: settings.geminiKey, model });
                const sysPrompt = buildSystemPrompt(aiRules.promptTemplate, glossary);
                results = await client.analyzeBatch(kept.map((w) => w.post), sysPrompt, Date.now() + config.GEMINI_BUDGET_MS);
            } catch (e) {
                // mất key/quota giữa chừng → cả phần còn lại đi fallback (mục 8.1 thiết kế)
                console.log('[AI] ⚠️ Gemini lỗi (' + ((e && e.message) || e) + ') — cả lượt chuyển fallback Google-gtx');
            }
            for (let i = 0; i < kept.length; i++) {
                const res = pickAiResult(results, i);
                const post = kept[i].post;
                if (res) {
                    if (res.translated_vi != null) post.translated_vi = res.translated_vi;
                    if (res.summary != null) post.summary = res.summary;
                    if (res.labels != null) post.labels = res.labels;
                    if (res.priority != null) post.priority = res.priority;
                    if (res.reason != null) post.reason = res.reason;
                    post.ai_used = 'gemini';
                    post.ai_model = model;
                    aiOk += 1;
                } else {
                    await runFallback(post);
                    fallbackCount += 1;
                }
            }
        } else {
            console.log('[AI] Thiếu geminiKey trong settings/main — toàn bộ bài đi fallback Google-gtx (dịch chuỗi free)');
            for (const w of kept) {
                await runFallback(w.post);
                fallbackCount += 1;
            }
        }
    }

    // ===== B9: dryRun — in bảng ứng viên + tổng kết rồi RETURN (KHÔNG ghi gì) =====
    if (dryRun) {
        console.log('');
        console.log('=== DRY-RUN: ' + kept.length + ' ứng viên (không ghi Firestore, không gọi Gemini) ===');
        for (const w of kept) {
            const p = w.post;
            const title = String(p.title || p.text || '').replace(/\s+/g, ' ').slice(0, 60);
            console.log(p.platform + ' | ' + p.source_name + ' | ' + title + ' | ' + p.url + ' | ' + (p.timestamp || '-') + ' | ✔ mới');
        }
        if (cappedCount > 0) console.log('(thêm ' + cappedCount + ' ứng viên vượt cap ' + config.MAX_NEW_POSTS_PER_RUN + ' — không ghi, không đánh dấu seen)');
        const totalItems = records.reduce((s, r) => s + r.rawCount, 0);
        console.log('Tổng kết dry-run: ' + selected.length + ' nguồn · ' + totalItems + ' item · ' + kept.length + ' ứng viên mới');
        return {
            runId: process.env.GITHUB_RUN_ID || 'local',
            sources: selected.length,
            items: totalItems,
            newPosts: kept.length,
            aiOk: 0,
            fallback: 0,
            errors: records.filter((r) => r.error).map((r) => ({
                source_id: r.source.id, source_name: r.source.name, type: r.error.type, message: r.error.message,
            })),
            durationS: Math.round((Date.now() - t0) / 100) / 10,
            dryRun: true,
        };
    }

    // ===== B10: ghi Firestore — posts TRƯỚC, scan_state SAU (tinh thần 2.5: state chỉ tiến sau khi bài an toàn) =====
    // Kẹp 1–30 theo schema 2.2.4 (web đã validate khi lưu — kẹp phòng settings bị sửa tay qua Console)
    const ttlNum = Number(settings.ttlDays);
    const ttlDays = Number.isFinite(ttlNum) && ttlNum >= 1 ? Math.min(30, ttlNum) : config.TTL_DEFAULT_DAYS;
    if (kept.length > 0) {
        await fb.writePosts(tenantId, kept.map((w) => w.post), ttlDays);
    }
    for (const rec of records) {
        const patch = { lastScanTime: new Date().toISOString() }; // không kèm lastError → firebase.js dọn lastError=null (GHI ĐÈ 3)
        if (rec.anchorPatch) Object.assign(patch, rec.anchorPatch);
        // seen_hashes/seen_urls MỚI dạng [{h|u, t}] — firebase.js applyScanState sẽ union với
        // danh sách cũ, prune > 7 ngày, cap 200/100 (GHI ĐÈ 3). Gồm hash của bài đã ghi
        // (cả dạng list lẫn full-text sau deep crawl) + bài bỏ vì cũ sau re-check ngày gốc.
        const nowState = new Date().toISOString();
        const hashes = new Set();
        const urls = new Set();
        for (const d of rec.seenDrops) {
            if (d.h) hashes.add(d.h);
            if (d.u) urls.add(d.u);
        }
        for (const w of kept) {
            if (w.sourceId !== rec.source.id) continue;
            hashes.add(w.post.norm_hash);
            if (w.itemHash && w.itemHash !== w.post.norm_hash) hashes.add(w.itemHash);
            if (w.post.url) urls.add(urlUid(w.post.url));
        }
        if (hashes.size > 0) patch.seen_hashes = [...hashes].map((h) => ({ h, t: nowState }));
        if (urls.size > 0) patch.seen_urls = [...urls].map((u) => ({ u, t: nowState }));
        if (rec.error) {
            patch.lastError = { type: rec.error.type, message: rec.error.message, timestamp: new Date().toISOString() };
        }
        try {
            await fb.applyScanState(tenantId, rec.source.id, patch);
        } catch (e) {
            // state là lớp phụ — một nguồn fail ghi state không được làm sập lượt chạy
            console.log('[STATE] ⚠️ Lỗi ghi scan_state "' + rec.source.name + '": ' + ((e && e.message) || e));
        }
    }

    // ===== B11: summary + _last_run + GITHUB_STEP_SUMMARY =====
    const durationS = Math.round((Date.now() - t0) / 100) / 10;
    const summary = {
        runId: process.env.GITHUB_RUN_ID || 'local',
        sources: selected.length,
        items: records.reduce((s, r) => s + r.rawCount, 0),
        newPosts: kept.length,
        aiOk,
        fallback: fallbackCount,
        errors: records.filter((r) => r.error).map((r) => ({
            source_id: r.source.id, source_name: r.source.name, type: r.error.type, message: r.error.message,
        })),
        durationS,
        dryRun: false,
    };
    // _last_run theo schema thiet-ke-runner.md mục 6: {run_id, started_at, finished_at,
    // totals, per_source[], duration_s} — web UI đọc doc này hiển thị kết quả lượt chạy.
    await fb.writeLastRun(tenantId, {
        run_id: summary.runId,
        started_at: new Date(t0).toISOString(),
        finished_at: new Date().toISOString(),
        totals: {
            sources: summary.sources,
            items: summary.items,
            newPosts: summary.newPosts,
            aiOk: summary.aiOk,
            fallback: summary.fallback,
            errors: summary.errors.length,
        },
        per_source: records.map((r) => ({
            source_id: r.source.id,
            source_name: String(r.source.name || ''),
            type: r.source.type,
            items: r.rawCount,
            new_posts: r.candidates.length,
            error: r.error ? r.error.type : null,
            duration_s: Math.round(r.durationS * 10) / 10,
        })),
        duration_s: summary.durationS,
    });

    // GitHub Actions: append bảng markdown vào step summary (local thì bỏ qua)
    const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummaryPath) {
        try {
            fs.appendFileSync(stepSummaryPath, [
                '',
                '## OSINT Runner — kết quả lượt quét',
                '',
                '- Tenant: `' + tenantId + '` · Run: `' + summary.runId + '`',
                '',
                '| Chỉ số | Giá trị |',
                '|---|---|',
                '| Nguồn quét | ' + summary.sources + ' |',
                '| Tổng item | ' + summary.items + ' |',
                '| Bài mới ghi | ' + summary.newPosts + ' |',
                '| AI Gemini ok | ' + summary.aiOk + ' |',
                '| Fallback gtx | ' + summary.fallback + ' |',
                '| Nguồn lỗi | ' + summary.errors.length + ' |',
                '| Thời lượng | ' + summary.durationS + 's |',
                '',
            ].join('\n'));
        } catch (e) {
            console.log('[SUMMARY] ⚠️ Không ghi được GITHUB_STEP_SUMMARY: ' + ((e && e.message) || e));
        }
    }

    console.log('[DONE] ' + summary.sources + ' nguồn · ' + summary.items + ' item · ' + summary.newPosts
        + ' bài mới · AI ok ' + summary.aiOk + ' · fallback ' + summary.fallback + ' · lỗi ' + summary.errors.length
        + ' · ' + summary.durationS + 's');
    return summary;
}

module.exports = { runScan };

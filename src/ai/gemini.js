'use strict';

/**
 * GeminiClient — gọi Gemini REST v1beta generateContent (JSON mode) cho runner.
 *
 * Port chính (ghi nguồn từng khối):
 *  - AutoCollectingNews/newsbot/glm.py        : class _Throttle (dòng 22–35),
 *    extract_json (dòng 38–57), vòng retry 429/5xx + backoff 3/6/12/24s (dòng 93–149).
 *  - AutoCollectingNews/newsbot/processor.py  : analyze_articles_batch (dòng 76–136)
 *    + _sanitize (dòng 139–177, thu gọn về 5 trường schema posts mục 2.2).
 *
 * Thiết kế: plans/chitiet/thiet-ke-runner.md mục 8.1 — phần bị kế hoạch chính
 * plans/KE_HOACH_LAM_LAI_ONLINE_FREE.md mục 2.4 ghi đè: throttle 7s, batch 5,
 * ngân sách 6 phút, MỘT settings.geminiModel.
 *
 * An toàn: TUYỆT ĐỐI không log API key (settings.geminiKey) ở bất kỳ đâu.
 */

const cfg = require('../config');

// Hằng số vận hành (bảng mục 5.1 mảnh thiết kế runner; giá trị tại chỗ chỉ là
// phòng thủ khi config.js thiếu tên — nội dung trùng bảng thiết kế)
const GEMINI_MODEL_DEFAULT = cfg.GEMINI_MODEL_DEFAULT || 'gemini-2.5-flash';
const GEMINI_MIN_INTERVAL_MS = cfg.GEMINI_MIN_INTERVAL_MS || 7000; // ~8.5 RPM, dưới ngưỡng free 10 RPM
const GEMINI_TIMEOUT_MS = cfg.GEMINI_TIMEOUT_MS || 60000;          // mỗi request
const GEMINI_MAX_RETRIES = cfg.GEMINI_MAX_RETRIES || 4;            // backoff 3/6/12/24s
const AI_BATCH = cfg.AI_BATCH || 5;                                // bài/lệnh gọi
const MAX_ARTICLE_CHARS = cfg.MAX_ARTICLE_CHARS || 6000;           // cắt nội dung gửi Gemini

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lỗi gọi Gemini sau khi đã retry (tương đương glm.py::GLMError dòng 18–19). */
class GeminiError extends Error {}

/**
 * Giãn cách tối thiểu giữa mọi request Gemini — chống 429 ở tier miễn phí.
 * Port glm.py::_Throttle (dòng 22–35); JS đơn luồng nên không cần lock.
 */
class Throttle {
    constructor(minIntervalMs) {
        this.minIntervalMs = minIntervalMs;
        this._last = 0;
    }

    async wait() {
        const delta = Date.now() - this._last;
        if (delta > 0 && delta < this.minIntervalMs) {
            await sleep(this.minIntervalMs - delta);
        }
        this._last = Date.now();
    }
}

/**
 * Moi JSON object ra khỏi câu trả lời của model (port glm.py::extract_json dòng 38–57):
 * 1) JSON.parse trực tiếp → 2) bỏ markdown fence ```json → 3) regex { ... } ngoài cùng.
 * JSON cắt cụt (hết maxOutputTokens) → throw để caller bỏ ĐÚNG lô đó.
 * @param {string} text
 * @returns {object}
 */
function extractJson(text) {
    const raw = (text || '').trim();
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) { /* thử đường khác */ }

    const unfenced = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    if (unfenced !== raw) {
        try {
            const obj = JSON.parse(unfenced);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        } catch (_) { /* thử đường khác */ }
    }

    const m = unfenced.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            return JSON.parse(m[0]);
        } catch (err) {
            throw new GeminiError(
                `Gemini trả JSON không hợp lệ, có thể bị cắt cụt (${err.message}): ${unfenced.slice(0, 200)}`
            );
        }
    }
    throw new GeminiError(`Gemini trả về không phải JSON hợp lệ: ${unfenced.slice(0, 200)}`);
}

/**
 * Chuẩn hoá 1 kết quả AI về đúng kiểu schema posts mục 2.2
 * (port processor.py::_sanitize dòng 139–177, thu gọn còn 5 trường).
 * Clamp priority 1–5 · labels ≤5 chuỗi · cap translated_vi 2500 / summary 800 / reason 300.
 */
function sanitizeResult(entry) {
    const e = entry || {};
    let priority = parseInt(e.priority, 10);
    if (!Number.isFinite(priority)) priority = 3; // model bỏ trống → mức trung bình
    priority = Math.min(5, Math.max(1, priority));

    const labels = Array.isArray(e.labels)
        ? e.labels
            .filter((l) => typeof l === 'string' && l.trim())
            .map((l) => l.trim().slice(0, 40))
            .slice(0, 5)
        : [];

    const cap = (v, limit) => {
        const s = (v === null || v === undefined) ? '' : String(v).trim();
        return s ? s.slice(0, limit) : null;
    };

    return {
        translated_vi: cap(e.translated_vi, 2500),
        summary: cap(e.summary, 800),
        labels,
        priority,
        reason: cap(e.reason, 300),
    };
}

/** Ngày-giờ Việt Nam dạng 'YYYY-MM-DD HH:MM' (port processor.py dòng 106: now(ZoneInfo('Asia/Ho_Chi_Minh'))). */
function nowViString() {
    // locale sv-SE cho sẵn định dạng ISO-like "2026-09-29 14:05"
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    }).format(new Date());
}

class GeminiClient {
    /**
     * @param {{apiKey: string, model?: string}} opts — apiKey từ settings.geminiKey,
     *        model từ settings.geminiModel (mặc định GEMINI_MODEL_DEFAULT).
     */
    constructor({ apiKey, model } = {}) {
        if (!apiKey) throw new GeminiError('Thiếu Gemini API key (settings.geminiKey)');
        this.apiKey = apiKey;
        this.model = model || GEMINI_MODEL_DEFAULT;
        this.quotaExhausted = false; // 429 RESOURCE_EXHAUSTED ×2 liên tiếp → tắt Gemini cả lượt chạy
        this._consecutive429 = 0;
        this._pending429WaitMs = 0;
        this._throttle = new Throttle(GEMINI_MIN_INTERVAL_MS);
    }

    /** Đọc error.details[].retryDelay ("13s") Google gửi kèm 429 — tôn trọng nhịp an toàn thay vì đoán (tinh thần glm.py dòng 133–140 đọc Retry-After). */
    _retryDelayMs(errBody) {
        try {
            const details = (errBody && errBody.error && errBody.error.details) || [];
            for (const d of details) {
                if (d && typeof d.retryDelay === 'string') {
                    const s = parseInt(d.retryDelay, 10);
                    if (Number.isFinite(s) && s > 0) return Math.min(s, 60) * 1000; // cap 60s như glm.py
                }
            }
        } catch (_) { /* body lạ — bỏ qua */ }
        return 0;
    }

    /**
     * MỘT lệnh gọi generateContent, kèm throttle + retry.
     * Retry CHỈ với HTTP 429/500/502/503/504 (backoff 3/6/12/24s); lỗi khác
     * (400 sai key, 404 sai model...) throw ngay — thử lại vô nghĩa.
     * @param {string} systemPrompt
     * @param {string} userText chuỗi JSON payload user
     * @returns {Promise<string>} văn bản phản hồi của model
     */
    async chat(systemPrompt, userText) {
        const endpoint = `${API_ROOT}/${encodeURIComponent(this.model)}:generateContent`;
        const body = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            generationConfig: {
                temperature: 0.15,
                responseMimeType: 'application/json',
                maxOutputTokens: 8192,
            },
        };

        let lastErr = '';
        for (let attempt = 0; attempt < GEMINI_MAX_RETRIES; attempt++) {
            await this._throttle.wait();
            try {
                const resp = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': this.apiKey, // bí mật — không bao giờ log
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
                });

                if (resp.ok) {
                    this._consecutive429 = 0;
                    const data = await resp.json();
                    const parts = data && data.candidates && data.candidates[0]
                        && data.candidates[0].content && data.candidates[0].content.parts;
                    const text = (parts || []).map((p) => (p && p.text) ? p.text : '').join('');
                    if (text && text.trim()) return text;
                    lastErr = 'phản hồi trống / thiếu candidates';
                } else if ([429, 500, 502, 503, 504].includes(resp.status)) {
                    const errBody = await resp.json().catch(() => null);
                    lastErr = `HTTP ${resp.status}`;
                    if (resp.status === 429) {
                        const status = errBody && errBody.error && errBody.error.status;
                        if (status === 'RESOURCE_EXHAUSTED') {
                            this._consecutive429 += 1;
                            if (this._consecutive429 >= 2) {
                                // 2 lần 429 quota liên tiếp trên 2 request khác nhau —
                                // chết hẳn, thử lại chỉ tốn thời gian (thiết kế 8.1)
                                this.quotaExhausted = true;
                                throw new GeminiError('Gemini hết quota (RESOURCE_EXHAUSTED 2 lần liên tiếp)');
                            }
                        }
                        this._pending429WaitMs = Math.max(this._pending429WaitMs, this._retryDelayMs(errBody));
                    }
                } else {
                    const snippet = await resp.text().catch(() => '');
                    throw new GeminiError(`Gemini HTTP ${resp.status}: ${String(snippet).slice(0, 300)}`);
                }
            } catch (err) {
                if (err instanceof GeminiError) throw err;
                lastErr = `lỗi mạng/timeout: ${err.message}`;
            }

            const backoffMs = Math.min(24000, 3000 * 2 ** attempt); // 3, 6, 12, 24s (glm.py dòng 143)
            const waitMs = Math.max(backoffMs, this._pending429WaitMs);
            this._pending429WaitMs = 0;
            console.warn(`[AI] Gemini thử lại lần ${attempt + 1}/${GEMINI_MAX_RETRIES} sau ${Math.round(waitMs / 1000)}s (${lastErr})`);
            await sleep(waitMs);
        }
        throw new GeminiError(`Gemini thất bại sau ${GEMINI_MAX_RETRIES} lần thử (${lastErr})`);
    }

    /**
     * Phân tích danh sách bài theo lô AI_BATCH bài/lệnh gọi
     * (port processor.py::analyze_articles_batch dòng 76–136).
     *
     * @param {Array<object>} posts bài theo schema thu thập: dùng title, source_name,
     *        url, timestamp, content|raw_text|text|summary
     * @param {string} systemPrompt từ ai/prompts.buildSystemPrompt
     * @param {number} deadlineMs mốc Date.now() hết ngân sách — quá hạn không mở lô mới
     * @returns {Promise<Array<object|null>>} MẢNG cùng chiều dài posts; bài lỗi /
     *          thiếu index trong kết quả → null để caller đưa sang fallback gtx
     */
    async analyzeBatch(posts, systemPrompt, deadlineMs) {
        const results = new Array(posts.length).fill(null);

        for (let start = 0; start < posts.length; start += AI_BATCH) {
            if (deadlineMs && Date.now() > deadlineMs) {
                const left = posts.length - start;
                console.warn(`[AI] Hết ngân sách thời gian Gemini — bỏ phân tích ${left} bài còn lại (chuyển fallback)`);
                break;
            }
            if (this.quotaExhausted) {
                const left = posts.length - start;
                console.warn(`[AI] Gemini hết quota — chuyển fallback Google-gtx cho ${left} bài còn lại`);
                break;
            }

            const chunk = posts.slice(start, start + AI_BATCH);
            const articles = chunk.map((p, i) => ({
                index: i,
                title: p.title || null,
                source: p.source_name || '',
                url: p.url || '',
                published: p.timestamp || null, // ISO từ nguồn — pass-through
                content: String(p.content || p.raw_text || p.text || p.summary || '').slice(0, MAX_ARTICLE_CHARS),
            }));
            const payload = {
                today: nowViString(),
                timezone: '(giờ Việt Nam, GMT+7)',
                articles,
            };

            const batchNo = Math.floor(start / AI_BATCH) + 1;
            try {
                const raw = await this.chat(systemPrompt, JSON.stringify(payload));
                const parsed = extractJson(raw);
                const byIndex = new Map();
                for (const entry of (parsed.results || [])) {
                    const i = parseInt(entry && entry.index, 10);
                    if (Number.isFinite(i) && i >= 0 && i < chunk.length && !byIndex.has(i)) {
                        byIndex.set(i, entry);
                    }
                }
                let got = 0;
                for (let i = 0; i < chunk.length; i++) {
                    if (byIndex.has(i)) {
                        results[start + i] = sanitizeResult(byIndex.get(i));
                        got += 1;
                    }
                }
                console.log(`[AI] Lô ${batchNo}: phân tích thành công ${got}/${chunk.length} bài`);
            } catch (err) {
                console.warn(`[AI] Phân tích lô ${batchNo} lỗi: ${err.message}`);
                if (this.quotaExhausted) {
                    const left = posts.length - start;
                    console.warn(`[AI] Gemini hết quota — chuyển fallback Google-gtx cho ${left} bài còn lại`);
                    break;
                }
            }
        }
        return results;
    }
}

module.exports = { GeminiClient, GeminiError, extractJson };

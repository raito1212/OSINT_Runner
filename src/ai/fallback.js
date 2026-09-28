'use strict';

/**
 * Chuỗi dịch free thay thế khi Gemini chết/hết quota: Google-gtx → MyMemory.
 *
 * Port chính (bỏ nhánh Puppeteer — runner KHÔNG có trình duyệt, thiết kế 8.3):
 *  - OSINT_Web/agent/src/translator/google.js : splitIntoChunks (dòng 36–75),
 *    translateSingleChunk (dòng 77–102), translateWithMyMemory (dòng 108–158),
 *    rate-limit 2.5s (dòng 12–24), backoff 429 5/10/20s (dòng 27–33).
 *  - OSINT_Web/agent/src/translator/manager.js: safeHop (dòng 256–271), bảo vệ
 *    số/tên Latin qua mọi chặng (nhánh th dòng 297–311, km dòng 368–388),
 *    giữ ngắt dòng bằng marker ◈⏎◈ (dòng 251–254, 443–447).
 *  - priority quy tắc: port thu gọn tinh thần processor.py::priority_score
 *    (dòng 234–253) — độ tươi + từ khóa nhạy cảm, không dùng AI.
 *
 * An toàn: không có key gì cả; KHÔNG log nội dung dài (chỉ log độ dài/trạng thái).
 * Một bài fallback lỗi không làm sập lượt chạy — trả văn bản gốc.
 */

const axios = require('axios');
const protect = require('../rules/protect'); // extractNumbers/restoreNumbers + extractLatinNames/restoreLatinNames

const MAX_CHUNK_SIZE = 4500;             // google.js dòng 9
const MYMEMORY_CHUNK = 450;              // google.js dòng 115
const MIN_REQUEST_INTERVAL_MS = 2500;    // google.js dòng 12 — ~24 request/phút
const GTX_TIMEOUT_MS = 30000;
const MYMEMORY_TIMEOUT_MS = 15000;
const MYMEMORY_CHUNK_DELAY_MS = 1200;    // nghỉ giữa các chunk MyMemory (google.js dòng 152–154)
const GTX_RETRIES = 3;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===== Rate-limit dùng chung gtx + MyMemory (port google.js dòng 13–24) =====
let lastRequestTime = 0;

async function enforceRateLimit() {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed > 0 && elapsed < MIN_REQUEST_INTERVAL_MS) {
        await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    lastRequestTime = Date.now();
}

/** Lùi 5/10/20s sau 429/302 rồi đặt lại đồng hồ rate-limit (port google.js dòng 27–33). */
async function backoff429(attempt) {
    const delay = 5000 * 2 ** attempt;
    console.warn(`[Fallback] gtx bị chặn (429/302) — chờ lùi ${delay / 1000}s (lần ${attempt + 1})`);
    await sleep(delay);
    lastRequestTime = 0;
}

/**
 * Chia văn bản thành chunk ≤ maxSize, ưu tiên ngắt tại dấu câu/khoảng trắng
 * (port NGUYÊN google.js::splitIntoChunks dòng 36–75; "។" là dấu câu Khmer).
 */
function splitIntoChunks(text, maxSize = MAX_CHUNK_SIZE) {
    if (!text || text.length <= maxSize) return [text];

    const chunks = [];
    const sentences = text.split(/([.!?।\n]+)/);
    let currentChunk = '';

    for (const sentence of sentences) {
        if ((currentChunk + sentence).length <= maxSize) {
            currentChunk += sentence;
        } else {
            if (currentChunk.trim()) chunks.push(currentChunk);
            // Câu đơn quá dài → tách theo từ
            if (sentence.length > maxSize) {
                const words = sentence.split(/\s+/);
                let wordChunk = '';
                for (const word of words) {
                    if ((wordChunk + ' ' + word).length <= maxSize) {
                        wordChunk = (wordChunk ? wordChunk + ' ' : '') + word;
                    } else {
                        if (wordChunk) chunks.push(wordChunk);
                        wordChunk = word;
                    }
                }
                currentChunk = wordChunk || '';
            } else {
                currentChunk = sentence;
            }
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk);

    return chunks.filter((c) => c && c.trim());
}

/**
 * Dịch MỘT chunk qua endpoint gtx không chính thức.
 * Dùng POST cho văn bản non-Latin (Khmer/Thai) — đáng tin hơn GET (google.js dòng 77–102).
 */
async function translateSingleChunk(chunk, targetLang, sourceLang = 'auto') {
    await enforceRateLimit();
    const url = 'https://translate.googleapis.com/translate_a/single';
    const { data } = await axios.post(url, new URLSearchParams({
        client: 'gtx',
        sl: sourceLang,
        tl: targetLang,
        dt: 't',
        q: chunk,
    }), {
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: GTX_TIMEOUT_MS,
    });
    // Định dạng phản hồi: [[["bản dịch", "văn gốc", ...]]]
    if (data && data[0]) {
        return data[0].map((item) => item[0]).join('');
    }
    return chunk;
}

/**
 * MyMemory — dự phòng cuối, free không cần key (port google.js::translateWithMyMemory
 * dòng 108–158): chunk 450 ký tự, phát hiện trả HOA-toàn-tục (API không dịch được).
 */
async function translateWithMyMemory(text, sourceLang = 'auto', targetLang = 'vi') {
    if (!text || !text.trim()) return text;
    const langPair = `${sourceLang === 'auto' ? 'autodetect' : sourceLang}|${targetLang}`;
    const url = 'https://api.mymemory.translated.net/get';

    const chunks = splitIntoChunks(text, MYMEMORY_CHUNK);
    const translations = [];

    for (const chunk of chunks) {
        try {
            await enforceRateLimit();
            const { data } = await axios.get(url, {
                params: { q: chunk, langpair: langPair },
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                timeout: MYMEMORY_TIMEOUT_MS,
            });

            if (data && data.responseData && data.responseData.translatedText) {
                const translated = data.responseData.translatedText;
                // MyMemory trả HOA-toàn-tục khi không dịch được — giữ nguyên văn (google.js dòng 133–138)
                if (translated !== translated.toUpperCase() || chunk.length < 10) {
                    translations.push(translated);
                } else {
                    translations.push(chunk);
                }
            } else {
                translations.push(chunk);
            }
        } catch (error) {
            console.warn(`[Fallback] MyMemory lỗi chunk (${error.message})`);
            if (error.response && error.response.status === 429) {
                await backoff429(0);
            }
            translations.push(chunk);
        }
        if (chunks.length > 1) {
            await sleep(MYMEMORY_CHUNK_DELAY_MS);
        }
    }
    return translations.join('');
}

/**
 * Dịch cả văn bản qua gtx: chunk hóa + retry. Chunk lỗi sau GTX_RETRIES lần
 * → throw để safeHop bắt rồi chuyển MyMemory (thay nhánh Puppeteer đã bỏ).
 * Port google.js::translateWithGoogle (dòng 247–306) + backoff 429/302 5/10/20s.
 */
async function translateWithGoogle(text, targetLang, retryCount = GTX_RETRIES, sourceLang = 'auto') {
    if (!text || !text.trim()) return text;
    const chunks = splitIntoChunks(text);
    const translations = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let translated = null;
        let lastError = null;

        for (let attempt = 0; attempt < retryCount; attempt++) {
            try {
                translated = await translateSingleChunk(chunk, targetLang, sourceLang);
                break;
            } catch (error) {
                lastError = error;
                const status = error.response ? error.response.status : 0;
                if (attempt === retryCount - 1) break;
                if (status === 429 || status === 302) {
                    await backoff429(attempt); // 5/10/20s
                } else {
                    console.warn(`[Fallback] gtx chunk ${i + 1} lỗi (${error.message}) — thử lại`);
                    await sleep(1000 * 2 ** attempt);
                }
            }
        }

        if (!translated) {
            throw lastError || new Error('gtx thất bại sau các lần thử');
        }
        translations.push(translated);
    }
    return translations.join('');
}

/**
 * MỘT chặng dịch với chuỗi dự phòng: gtx → MyMemory (port manager.js::safeTranslate dòng 256–271).
 * @returns {Promise<string|null>} null khi cả hai cùng chết
 */
async function safeHop(text, targetLang, srcLang) {
    try {
        const result = await translateWithGoogle(text, targetLang, GTX_RETRIES, srcLang || 'auto');
        if (result && result !== text) return result;
    } catch (e) {
        console.warn(`[Fallback] Google-gtx lỗi chặng ${srcLang || 'auto'}→${targetLang}: ${e.message}`);
    }
    try {
        const result = await translateWithMyMemory(text, srcLang || 'auto', targetLang);
        if (result && result !== text) return result;
    } catch (e) {
        console.warn(`[Fallback] MyMemory lỗi chặng ${srcLang || 'auto'}→${targetLang}: ${e.message}`);
    }
    return null;
}

/**
 * Dịch văn bản sang tiếng Việt theo chuỗi gtx (thiết kế 8.3):
 * vi → bỏ qua · en → en→vi · th → th→en→vi · km → km→en→vi · auto → auto→vi.
 *
 * MỌI chặng bọc rules/protect.js: che số (N<idx>) + tên Latin (Q<idx>) MỘT lần
 * trước chặng đầu, trả lại SAU chặng cuối — Google làm rơi số đuôi và hỏng tên
 * riêng khi dịch văn bản non-Latin (port manager.js dòng 297–311, 368–388).
 *
 * @param {string} text văn bản gốc
 * @param {string} lang mã ngôn ngữ phát hiện ('vi'|'en'|'th'|'km'|'auto'|...)
 * @returns {Promise<string>} bản dịch; nguyên văn nếu cả chuỗi chết
 */
async function translateVi(text, lang) {
    if (!text || !text.trim()) return text;
    const src = (lang || 'auto').toLowerCase();
    if (src === 'vi') return text; // đã là tiếng Việt — bỏ qua

    // Giữ ngắt dòng qua các chặng dịch (port manager.js dòng 251–254, 443–447)
    const NL_MARKER = ' ◈⏎◈ ';
    const marked = text.replace(/\r?\n/g, NL_MARKER);

    const { text: numProt, numbers } = protect.extractNumbers(marked);
    const { text: prot, names } = protect.extractLatinNames(numProt);

    let vi = null;
    if (src === 'th' || src === 'km') {
        // Chặng 2 bước qua tiếng Anh (manager.js: nhánh th dòng 297–311, km fallback dòng 368–388)
        const en = await safeHop(prot, 'en', src);
        if (en && /[a-zA-Z]{10,}/.test(en)) {
            // `en` còn nguyên placeholder N/Q — chặng 2 không cần che lại
            vi = await safeHop(en, 'vi', 'en');
        }
    } else {
        // en, auto và ngôn ngữ lạ khác → gtx trực tiếp sang VI
        vi = await safeHop(prot, 'vi', src === 'en' ? 'en' : 'auto');
    }

    if (!vi) {
        console.warn(`[Fallback] Dịch ${src}→vi thất bại toàn chuỗi — giữ nguyên văn (${text.length} ký tự)`);
        return text;
    }

    const restored = protect.restoreLatinNames(protect.restoreNumbers(vi, numbers), names);
    return restored.replace(/\s*◈⏎◈\s*/g, '\n');
}

// ===== Phần enrich quy tắc thuần (không AI) =====

// Từ khóa nhạy cảm cho chấm priority — port thu gọn PROCUREMENT_BONUS_WORDS +
// WATCH_BONUS_WORDS của AutoCollectingNews/newsbot/processor.py (dòng 18–23)
const SENSITIVE_KEYWORDS = [
    // EN
    'military', 'army', 'navy', 'air force', 'defense', 'defence', 'border', 'checkpoint',
    'troops', 'exercise', 'drone', 'uav', 'missile', 'submarine', 'frigate', 'warship',
    'arrest', 'deport', 'clash', 'shooting', 'explosion', 'coup', 'landmine', 'minefield',
    // VI
    'quân sự', 'quốc phòng', 'biên giới', 'cửa khẩu', 'diễn tập', 'vũ khí', 'tên lửa',
    'tàu ngầm', 'bắt giữ', 'trục xuất', 'giao tranh', 'nổ súng', 'cháy nổ', 'đảo chính',
    'phân giới', 'cắm mốc', 'an ninh',
];

/** Tuổi của bài (giờ) tính từ timestamp ISO nguồn; null khi không parse được. */
function ageHours(timestampIso) {
    if (!timestampIso) return null;
    const t = Date.parse(timestampIso);
    if (!Number.isFinite(t)) return null;
    return (Date.now() - t) / 3600000;
}

/**
 * Chấm priority 1–5 bằng quy tắc thuần (1 = quan trọng nhất):
 * từ khóa nhạy cảm tăng ưu tiên, tin cũ hạ ưu tiên — port thu gọn tinh thần
 * processor.py::priority_score (dòng 234–253: freshness bonus + keyword bonus).
 */
function rulePriority(text, timestampIso) {
    const lower = ` ${text || ''} `.toLowerCase();
    let hits = 0;
    for (const w of SENSITIVE_KEYWORDS) {
        if (lower.includes(w)) hits += 1;
    }

    let score = 3; // mức nền trung bình
    if (hits >= 3) score -= 2;
    else if (hits >= 1) score -= 1;

    const ageH = ageHours(timestampIso);
    if (ageH !== null) {
        if (ageH < 1) score -= 1; // vừa phát hành — ưu tiên mạnh nhất (processor.py dòng 245–246)
        else if (ageH > 48) score += 1; // tin cũ — hạ ưu tiên
    }
    return Math.min(5, Math.max(1, score));
}

/** 2 câu đầu tách theo [.!?।] — gồm cả dấu câu Khmer (thiết kế 8.3), cap 800 ký tự. */
function firstTwoSentences(text) {
    if (!text) return text;
    const sentences = String(text)
        .split(/(?<=[.!?।])/)
        .map((s) => s.trim())
        .filter(Boolean);
    const picked = sentences.slice(0, 2).join(' ');
    return (picked || String(text)).slice(0, 800);
}

/**
 * Enrich 1 bài bằng chuỗi free + quy tắc thuần khi không dùng được Gemini.
 * @param {string} text văn bản gốc bài
 * @param {string} lang ngôn ngữ phát hiện (detector.js)
 * @param {string|null} [timestampIso] timestamp nguồn — dùng chấm độ tươi
 * @returns {Promise<{translated_vi: string, summary: string, labels: string[], priority: number, reason: string}>}
 */
async function enrichFallback(text, lang, timestampIso = null) {
    const translatedVi = await translateVi(text, lang);
    return {
        translated_vi: translatedVi,
        summary: firstTwoSentences(translatedVi),
        labels: [],
        priority: rulePriority(text, timestampIso),
        reason: 'fallback_gtx',
    };
}

module.exports = { translateVi, enrichFallback, splitIntoChunks };

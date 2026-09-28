'use strict';

/**
 * Nhận diện ngôn ngữ miễn phí — port NGUYÊN OSINT_Web/agent/src/language/detector.js.
 *
 * Thứ tự: (1) fast-path regex script không tốn mạng — Thai/Khmer là hệ chữ riêng,
 * tiếng Việt có dấu trong vùng Latin mở rộng; (2) cache theo nguồn 30 phút (cùng
 * nguồn thường cùng ngôn ngữ); (3) chỉ khi fast-path không chốt mới gọi gtx-detect.
 * Latin không dấu → 'en'. (thiết kế runner mục 8.4)
 *
 * An toàn: chỉ log mã ngôn ngữ — không log nội dung bài.
 */

const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Cache ngôn ngữ theo source_id để tránh gọi lặp (port detector.js dòng 8–25)
const langCache = new Map();
const LANG_CACHE_TTL = 30 * 60 * 1000; // 30 phút
const DETECT_RETRIES = 2;

const hasThai = /[฀-๿]/;
const hasKhmer = /[ក-៿]/;
const hasVietDiacritics = /[À-ỹ]/; // dấu tiếng Việt trong vùng Latin

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getCachedLang = (sourceId) => {
    if (!sourceId) return null;
    const cached = langCache.get(sourceId);
    if (cached && Date.now() - cached.ts < LANG_CACHE_TTL) {
        return cached.lang;
    }
    return null;
};

const setCachedLang = (sourceId, lang) => {
    if (!sourceId || !lang) return;
    langCache.set(sourceId, { lang, ts: Date.now() });
};

/**
 * Fast-path không tốn mạng (port detector.js dòng 31–34).
 * @returns {'th'|'km'|'vi'|null} null = không chốt được (Latin không dấu...)
 */
function fastPathDetect(text) {
    if (hasThai.test(text)) return 'th';
    if (hasKhmer.test(text)) return 'km';
    if (hasVietDiacritics.test(text)) return 'vi';
    return null;
}

/**
 * Gọi gtx-detect: data[2] của phản hồi là mã ngôn ngữ phát hiện
 * (port detector.js dòng 43–65 — GET translate_a/single, tl cố định đủ dùng).
 */
async function gtxDetect(text) {
    const { data } = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: {
            client: 'gtx',
            sl: 'auto',
            tl: 'en',
            dt: 't',
            q: text.slice(0, 1000), // cắt ngắn cho nhanh
        },
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000,
    });
    if (data && data[2]) return String(data[2]);
    return null;
}

/**
 * Nhận diện ngôn ngữ của văn bản.
 * @param {string} text nội dung bài
 * @param {string|null} [sourceId] id nguồn — dùng làm khóa cache 30 phút
 * @returns {Promise<string>} mã ngôn ngữ ('vi'|'en'|'th'|'km'|...); không xác định → 'en'
 */
async function detectLanguage(text, sourceId = null) {
    if (!text || !text.trim()) return 'en';

    // 1) Fast-path script — chốt ngay, không tốn request
    const fast = fastPathDetect(text);
    if (fast) return fast;

    // 2) Cache theo nguồn
    const cached = getCachedLang(sourceId);
    if (cached) {
        console.log(`[Lang] dùng cache "${cached}" cho nguồn ${sourceId}`);
        return cached;
    }

    // 3) gtx-detect (chỉ khi fast-path không chốt) — retry 2 lần, nghỉ 1s
    for (let attempt = 0; attempt < DETECT_RETRIES; attempt++) {
        try {
            const detected = await gtxDetect(text);
            if (detected) {
                console.log(`[Lang] gtx-detect → "${detected}"`);
                setCachedLang(sourceId, detected);
                return detected;
            }
            return 'en'; // cấu trúc phản hồi lạ — Latin không dấu mặc định 'en'
        } catch (error) {
            if (attempt === DETECT_RETRIES - 1) {
                console.warn(`[Lang] gtx-detect lỗi (${error.message}) — mặc định 'en'`);
                return 'en';
            }
            await sleep(1000);
        }
    }
    return 'en';
}

module.exports = { detectLanguage };

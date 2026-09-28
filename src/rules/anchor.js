// ============================================================
// rules/anchor.js — anchor mode cho nguồn website (ngày chỉ có ngày-tháng
// hoặc không có giờ → lọc theo MỐC "bài đã thấy" thay vì theo thời gian).
//
// Nguồn port: OSINT_Web/agent/src/pipeline/pipeline.service.js
//   - anchorHashEq                          : L25–36
//   - hasTimeComponent / shouldUseAnchorMode: L86–111
//   - khối áp anchor (quét đầu/quét sau)    : L816–884
//
// Đổi lớp vận chuyển (duy nhất): KHÔNG ghi Firestore ở đây — applyAnchor trả
// patch {use_anchor, anchor_text_hash, anchor_timestamp} để orchestrator ghi
// scan_state theo schema 2.2.3 (tên field chuẩn là anchor_timestamp; bản cũ
// của agent dùng anchor_set_at — guard "anchor chỉ tiến" phía web đọc
// anchor_timestamp, bản ghi 2.2.3 tại plans/KE_HOACH L97).
//
// Hash anchor = normHash (dedup.js) của TIỀN TỐ 80 ký tự đầu text.
// CommonJS, chỉ phụ thuộc './dedup' (node:crypto bên trong).
// ============================================================
const { normHash } = require('./dedup');

const ANCHOR_PREFIX_LEN = 80;  // so tiền tố tới min(80, lenA, lenB) — port L31–36
const ANCHOR_MIN_MATCH = 20;   // floor 20: chống khớp nhầm hai bài khác header
const ANCHOR_SAMPLE_SIZE = 10; // mẫu 10 item đầu khi tự phát hiện — port L96
const SAFE_LIMIT = 3;          // anchor không tìm thấy → giữ 3 item mới nhất — port L862

// So khớp anchor bền với khác biệt render: so TIỀN TỐ tới min(80, lenA, lenB)
// thay vì substring(0,80) cố định. Hash-vs-hash (hai sha256 cùng 64 ký tự) →
// n = 64 = so toàn bộ, tương đương ===.
const anchorHashEq = (a, b) => {
    if (!a || !b) return false;
    const x = String(a);
    const y = String(b);
    const n = Math.min(ANCHOR_PREFIX_LEN, x.length, y.length);
    return n >= ANCHOR_MIN_MATCH && x.substring(0, n) === y.substring(0, n);
};

// Hash anchor = normHash của 80 ký tự đầu: hai lần render khác nhau SAU ký tự
// 80 vẫn cùng mốc (spec P2 runner; agent cũ hash toàn văn — nguồn website của
// runner chỉ runner quét nên không cần tương thích chéo giá trị hash).
const computeAnchorHash = (text) => normHash(String(text || '').slice(0, ANCHOR_PREFIX_LEN));

// Text hiện tại có trùng anchor đã lưu không?
const anchorMatches = (text, anchorHash) => anchorHashEq(computeAnchorHash(text), anchorHash);

// Chuỗi ngày có đủ giờ-phút HH:MM không? — port L87–90.
const hasTimeComponent = (dateStr) => {
    if (!dateStr) return false;
    return /\d{1,2}:\d{2}/.test(dateStr);
};

// Lấy chuỗi ngày THÔ của item — port L100 (metadata.post_timestamp/detected_date/
// published_date/date), mở cho field phẳng cùng tên của item runner. Chỉ xét
// CHUỖI: Date object không xét (nguyên bản chỉ xem ngày thô bóc từ trang;
// item không có ngày chuỗi → coi như không ngày → anchor mode, đúng chú thích
// L93 "items lack dates entirely" của bản gốc).
const itemDateString = (item) => {
    const m = item && item.metadata ? item.metadata : {};
    const s = m.post_timestamp || m.detected_date || m.published_date || m.date
        || item.detected_date || item.published_date || item.post_timestamp
        || item.date || item.timestamp;
    return typeof s === 'string' ? s : null;
};

// Tự phát hiện: mẫu 10 item đầu — chỉ MỘT item có ngày đủ giờ-phút là lọc theo
// thời gian được → KHÔNG cần anchor. Ngày chỉ ngày-tháng hoặc không ngày →
// anchor mode. — port L94–111.
const shouldUseAnchorMode = (items) => {
    if (!items || items.length === 0) return false;
    const sample = items.slice(0, ANCHOR_SAMPLE_SIZE);
    let hasFullDatetime = false;
    for (const item of sample) {
        const dateStr = itemDateString(item);
        if (dateStr && hasTimeComponent(dateStr)) {
            hasFullDatetime = true;
            break;
        }
    }
    return !hasFullDatetime;
};

// Áp anchor lên danh sách item (mới nhất ĐẦU danh sách) của MỘT nguồn website.
// state = { use_anchor, anchor_text_hash } đọc từ scan_state — port L816–884.
// Trả { items, useAnchor, anchorFound, anchor }:
//   - quét đầu (chưa có anchor): đặt mốc = item[0], BỎ TOÀN BỘ item (chỉ đặt mốc);
//   - quét sau: giữ item TRƯỚC anchor; anchor mất (trang trôi) → SAFE_LIMIT item
//     mới nhất; có item mới → TIẾN anchor lên item đầu (anchor !== null là patch
//     để ghi, null = giữ anchor cũ; guard "chỉ tiến" phía firebase.js/web lo).
const applyAnchor = (items, state = {}) => {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
        return { items: [], useAnchor: false, anchorFound: false, anchor: null };
    }
    // port L823: use_anchor đã bật từ lượt trước HOẶC tự phát hiện lần này
    const useAnchor = state.use_anchor === true || shouldUseAnchorMode(list);
    if (!useAnchor) {
        return { items: list, useAnchor: false, anchorFound: false, anchor: null };
    }

    const anchorHash = state.anchor_text_hash || null;
    const nowIso = new Date().toISOString();

    if (!anchorHash) {
        // port L829–848: QUÉT ĐẦU — lưu anchor = item mới nhất, bỏ hết item
        return {
            items: [],
            useAnchor: true,
            anchorFound: false,
            anchor: {
                use_anchor: true,
                anchor_text_hash: computeAnchorHash(list[0].text),
                anchor_timestamp: nowIso,
            },
        };
    }

    // port L850–865: QUÉT SAU — tìm anchor trong danh sách hiện tại
    const anchorIdx = list.findIndex((item) => anchorMatches(item.text, anchorHash));
    let keptItems;
    if (anchorIdx !== -1) {
        keptItems = list.slice(0, anchorIdx); // mọi item sau anchor đều cũ
    } else {
        keptItems = list.slice(0, SAFE_LIMIT); // trang đã trôi — giới hạn an toàn
    }

    // port L867–881: có item mới → tiến anchor lên item mới nhất vừa giữ lại
    let anchor = null;
    if (keptItems.length > 0) {
        anchor = {
            anchor_text_hash: computeAnchorHash(keptItems[0].text),
            anchor_timestamp: nowIso,
        };
    }
    return { items: keptItems, useAnchor: true, anchorFound: anchorIdx !== -1, anchor };
};

module.exports = {
    ANCHOR_PREFIX_LEN,
    ANCHOR_MIN_MATCH,
    SAFE_LIMIT,
    anchorHashEq,
    computeAnchorHash,
    anchorMatches,
    hasTimeComponent,
    shouldUseAnchorMode,
    applyAnchor,
};

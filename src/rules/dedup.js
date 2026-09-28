// ============================================================
// rules/dedup.js — chuẩn hoá URL + bộ hash MỘT CÔNG THỨC (PLAN 2.1)
// + gộp trùng prefix trong lô quét.
//
// Nguồn port (PORT CÓ KIỂM SOÁT — giữ nguyên thuật toán, chỉ đổi lớp vận chuyển):
//   - normalizeUrl/urlUid : AutoCollectingNews/newsbot/state.py L22–L37
//     (normalize_url / url_uid), lấy theo BẢN CHUẨN P0 đã triển khai ở
//     OSINT_Web/web/src/utils/postsFirestore.js L22–L52 + L62–L64. Runner
//     phải ra CHÍNH XÁC cùng chuỗi với browser để postId/seen_urls khớp nhau
//     trên cả 3 lớp web–runner–agent (PLAN 2.1: "MỘT công thức cho cả 3 nơi").
//     Khác state.py nguyên thuỷ: key tracking khớp CHÍNH XÁC (ref/source) chứ
//     không theo tiền tố — đây là điều chỉnh đã chuẩn hoá ở P0, giữ nguyên.
//   - titleHash           : state.py L40–L42 (title_hash) — \W của Python coi
//     chữ Unicode là "word" nên port bằng [^\p{L}\p{N}_] (Khmer/tiếng Việt giữ nguyên).
//   - normHash/contentHash: PLAN 2.1 + pipeline.service.js L1185–L1187
//     (generateHash của agent src/utils/crypto.js = sha256 hex 64).
//   - computePostId       : PLAN 2.1 (GHI ĐÈ P2 #6) — 'web_' + md5(normalizeUrl(url))
//     cho MỌI bài runner.
//   - prefixMerge         : pipeline.service.js L919–L967.
//   - dedupeBatch         : theo urlUid + normHash (thiết kế runner mục 7.6;
//     tinh thần dedup-cache L1189–L1204 của agent).
//
// CommonJS, chỉ phụ thuộc node:crypto — mọi hash đều SYNC.
// ============================================================
const crypto = require('crypto');

const sha = (algorithm, value) => crypto.createHash(algorithm).update(String(value)).digest('hex');

// ---- 1. Chuẩn hoá URL (trùng khớp tuyệt đối với postsFirestore.js của P0) ----
// Bỏ query tracking (utm_*/mc_* tiền tố + fbclid/gclid/ref/source/spm/igshid
// chính xác), bỏ fragment, bỏ '/' cuối path, lowercase scheme+host; path &
// query còn lại giữ nguyên vẹn. URL parse lỗi → trả nguyên chuỗi.
const TRACKING_QUERY_EXACT = new Set(['fbclid', 'gclid', 'ref', 'source', 'spm', 'igshid']);
const TRACKING_QUERY_PREFIXES = ['utm_', 'mc_'];

function normalizeUrl(rawUrl) {
    const raw = String(rawUrl || '');
    try {
        const u = new URL(raw);
        const kept = u.search.replace(/^\?/, '').split('&')
            .filter(Boolean)
            .filter((pair) => {
                const key = decodeURIComponent(pair.split('=')[0].replace(/\+/g, ' '));
                return !TRACKING_QUERY_EXACT.has(key)
                    && !TRACKING_QUERY_PREFIXES.some((p) => key.startsWith(p));
            });
        const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
        return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${kept.length ? `?${kept.join('&')}` : ''}`;
    } catch {
        return raw;
    }
}

// ---- 2. Bộ hash (PLAN 2.1) ----

// norm_hash = sha256 hex64 của text đã bỏ mọi khoảng trắng + lowercase —
// khớp pipeline.service.js L1187 → runner và agent so hash thấy nhau.
const normHash = (text) => sha('sha256', String(text || '').replace(/\s+/g, '').toLowerCase());

// content_hash = sha256 hex64 của text thô.
const contentHash = (text) => sha('sha256', String(text || ''));

// urlUid = sha1(normalizeUrl)[:20] — dùng trong scan_state.seen_urls.
const urlUid = (url) => sha('sha1', normalizeUrl(url)).slice(0, 20);

// titleHash = sha1(100 ký tự đầu của tiêu đề đã chuẩn hoá)[:20] (state.py L40–42):
// lowercase, thay mọi cụm không-phải-chữ/số/gạch-dưới bằng 1 dấu cách, strip.
const titleHash = (title) => {
    const normalized = String(title || '').toLowerCase()
        .replace(/[^\p{L}\p{N}_]+/gu, ' ')
        .trim()
        .slice(0, 100);
    return sha('sha1', normalized).slice(0, 20);
};

// postId deterministic cho MỌI bài runner (PLAN 2.1 + GHI ĐÈ P2 #6):
// 'web_' + md5(normalizeUrl(url)). Browser luôn ưu tiên post_id collector trả
// về — runner tự tính vì mọi nguồn HTTP-thuần đều có URL ổn định
// (t.me/<slug>/<id> là duy nhất, rss/gnews decode ra URL bài gốc).
const computePostId = (url) => `web_${sha('md5', normalizeUrl(url))}`;

// ---- 3. Gộp trùng prefix trong lô (port pipeline.service.js L919–L967) ----
// Cùng một bài bị bóc 2 lần trong 1 lượt quét (vd bài share: 1 bản cắt cụt từ
// card danh sách + 1 bản đầy đủ) — norm-hash dedup trượt vì 2 text khác nhau.
// Gộp item mà text (đã bỏ đuôi "…"/"See more") là tiền tố ký tự của item kia:
// giữ bản DÀI hơn và UNION ảnh (lọc rác rsrc.php/static.xx/emoji, cap 12).
// Đổi lớp vận chuyển duy nhất: agent đọc/ghi ảnh ở it.metadata.images
// (L948–949) — runner đọc images FLAT (schema 2.2) với metadata là fallback,
// ghi kết quả gộp về images FLAT.

const stripTail = (s) => String(s || '')
    .replace(/[\s.…·]+$/g, '')
    .replace(/\s*(see more|xem thêm|show more|view more|hiển thị thêm|xem toàn văn)\s*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const unionImages = (a, b) => [...new Set([...(a || []), ...(b || [])])]
    .filter((img) => typeof img === 'string' && !img.includes('rsrc.php')
        && !img.includes('static.xx') && !img.includes('emoji'))
    .slice(0, 12);

const itemImages = (it) => {
    if (Array.isArray(it && it.images)) return it.images;
    if (it && it.metadata && Array.isArray(it.metadata.images)) return it.metadata.images;
    return [];
};

const prefixMerge = (items) => {
    const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it === 'object');
    if (list.length < 2) return list;
    const kept = [];
    for (const it of list) {
        const norm = stripTail(it.text);
        let pidx = -1;
        if (norm.length >= 20) {
            pidx = kept.findIndex((k) => k.norm.length >= 20
                && (k.norm.startsWith(norm) || norm.startsWith(k.norm))
                && Math.min(norm.length, k.norm.length) / Math.max(norm.length, k.norm.length) >= 0.4);
        }
        if (pidx === -1) {
            kept.push({ it, norm });
        } else {
            const partner = kept[pidx];
            const pi = itemImages(partner.it);
            const ci = itemImages(it);
            if (norm.length > partner.norm.length) {
                it.images = unionImages(ci, pi);
                kept[pidx] = { it, norm };
            } else {
                partner.it.images = unionImages(pi, ci);
            }
            console.log(`[Rules] Prefix-merge: gộp bài trùng (giữ ${Math.max(norm.length, partner.norm.length)} ký tự, bỏ ${Math.min(norm.length, partner.norm.length)} ký tự)`);
        }
    }
    const out = kept.map((k) => k.it);
    if (out.length < list.length) {
        console.log(`[Rules] Prefix-merge: ${list.length} → ${out.length} item`);
    }
    return out;
};

// ---- 4. Dedup trong lô theo urlUid + normHash (thiết kế runner 7.6) ----
// Giữ bản ĐẦU TIÊN của mỗi URL-chuẩn-hoá và mỗi nội-dung-chuẩn-hoá; bản sau
// trùng key nào thì bỏ (item thiếu url/text chỉ theo key có sẵn).
const dedupeBatch = (items) => {
    const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it === 'object');
    const seenUrl = new Set();
    const seenHash = new Set();
    const out = [];
    let dropped = 0;
    for (const it of list) {
        const u = it.url ? urlUid(it.url) : null;
        const h = it.text ? normHash(it.text) : null;
        if ((u && seenUrl.has(u)) || (h && seenHash.has(h))) {
            dropped += 1;
            continue;
        }
        if (u) seenUrl.add(u);
        if (h) seenHash.add(h);
        out.push(it);
    }
    if (dropped > 0) {
        console.log(`[Rules] Dedup trong lô: bỏ ${dropped} item trùng (urlUid/normHash)`);
    }
    return out;
};

module.exports = {
    normalizeUrl,
    urlUid,
    titleHash,
    normHash,
    contentHash,
    computePostId,
    prefixMerge,
    dedupeBatch,
};

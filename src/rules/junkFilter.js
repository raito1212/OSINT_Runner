// ============================================================
// rules/junkFilter.js — lọc item rác/UI-label cho nguồn HTTP-thuần.
// Port GENERIC (dùng cho website/rss/gnews/telegram) từ collector Facebook:
//   (1) UI-label prefix      : facebook.js L4431
//   (2) "Ý nghĩa" quá ngắn   : facebook.js L4433–4435
//   (3) Share-header cắt cụt : facebook.js L6413–L6443 (đo trên 173 bài thật:
//       bỏ đúng 3 mảnh rác, 0 bài thật bị bắt — nhận diện HẸP, an toàn cho web)
//
// Lưu ý cho caller: sàn 30 ký tự ở quy tắc (2) có thể bỏ cả headline tin rất
// ngắn — nguồn rss/gnews nên nối title + summary thành text trước khi lọc.
//
// CommonJS, không phụ thuộc ngoài.
// ============================================================

// (1) Nhãn UI đầu bài (bản dịch tự động của Facebook, ô bình luận...)
const UI_LABEL_PREFIX_RE = /^(Được dịch từ|Translated from|Xem bản dịch|Bình luận|Viết bình luận)/i;

// (2) Đo "phần có nghĩa": bỏ nhãn Facebook/Like/Share/Comment + token
// base64/mã-hoá-dài (>=15 ký tự a-z0-9) rồi còn < 30 ký tự → toàn là rác UI.
const meaningfulText = (text) => String(text || '')
    .replace(/\b(Facebook|Like|Share|Comment)\b/gi, '')
    .replace(/[a-z0-9]{15,}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

// (3) Cụm tag-list UI mà mảnh header share bị cắt NGAY GIỮA — đầy đủ 3 ngôn ngữ
// + biến thể đếm "và N người khác" / "and N others" (facebook.js L6428–6431).
const SHARE_TAG_LISTS = ['và những người khác', 'and others', 'និងអ្នកផ្សេងទៀត'];
for (let i = 1; i <= 20; i++) {
    SHARE_TAG_LISTS.push(`và ${i} người khác`, `and ${i} others`);
}

// Mảnh header share ("X và Y và những người khác đã chia sẻ") bị cắt cụt giữa
// cụm tag-list. Phải thỏa CẢ BA: (a) chuẩn hoá whitespace xong DÀI < 60 ký tự;
// (b) kết thúc bằng dấu cắt cụt "..." / "…"; (c) phần lõi (bỏ dấu cắt) kết thúc
// bằng MỘT TIỀN TỐ >=6 ký tự của chuỗi tag-list UI. Bài thật chứa nguyên cụm
// (không cắt) KHÔNG khớp tiền tố này.
const isTruncatedShareHeader = (t) => {
    const s = (t || '').replace(/\s+/g, ' ').trim();
    if (s.length >= 60) return false;
    if (!/\.{3}\s*$/.test(s) && !/…\s*$/.test(s)) return false;
    const core = s.replace(/\.{3}\s*$|…\s*$/, '').trim();
    for (const ui of SHARE_TAG_LISTS) {
        for (let n = ui.length; n >= 6; n--) {
            if (core.endsWith(ui.slice(0, n))) return true;
        }
    }
    return false;
};

// Item có phải rác không — trả true để caller BỎ item (một item rác không làm
// sập nguồn: caller loop try/catch quanh từng item như quy ước P2).
const isJunkItem = (text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    // (1) UI-label ngắn
    if (UI_LABEL_PREFIX_RE.test(t) && t.length < 60) return true;
    // (2) gần như không còn nội dung có nghĩa
    if (meaningfulText(t).length < 30) return true;
    // (3) mảnh header share cắt cụt
    if (isTruncatedShareHeader(t)) return true;
    return false;
};

module.exports = { isJunkItem, isTruncatedShareHeader };

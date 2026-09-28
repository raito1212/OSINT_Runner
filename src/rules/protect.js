// ============================================================
// rules/protect.js — bảo vệ SỐ và TÊN RIÊNG Latin qua các chặng dịch.
//
// Port NGUYÊN OSINT_Web/agent/src/translator/manager.js:
//   - extractNumbers / restoreNumbers       : L90–109
//   - extractLatinNames / restoreLatinNames : L127–147
//
// Lý do (chứng minh thật trong manager.js): Google thỉnh thoảng RƠI chữ số
// khi dịch văn bản non-Latin dài ("070 206 746" → "070 206") và LÀM HỎNG tên
// Latin nhúng trong văn bản Khmer ("(Huione Pay)" → "Huye Pay"). Che bằng
// placeholder trước khi gửi, trả nguyên văn sau khi nhận.
//
// Áp cho MỌI chặng dịch (Gemini lẫn fallback gtx) — đúng thứ tự gọi như
// manager.js L371–372 (che số TRƯỚC, che tên SAU) và L381–384 (trả số
// TRƯỚC, trả tên SAU): protectText trước khi gửi, restoreText sau khi nhận.
//
// CommonJS, không phụ thuộc ngoài.
// ============================================================

/**
 * Che chuỗi số (>= 2 chữ số, cho phép khoảng trắng/dấu . - / bên trong như
 * số điện thoại "070 206 746") bằng placeholder N<idx>. Số đơn lẻ giữ nguyên.
 */
const extractNumbers = (text) => {
    if (!text) return { text, numbers: [] };
    const numbers = [];
    const numRe = /\d[\d\s.\-/]{0,}\d/g;
    const cleaned = text.replace(numRe, (match) => {
        if ((match.match(/\d/g) || []).length < 2) return match; // bỏ số đơn lẻ
        const idx = numbers.length;
        numbers.push(match);
        return `N${idx}`;
    });
    return { text: cleaned, numbers };
};

/** Đưa lại chuỗi số gốc vào vị trí placeholder N<idx>. */
const restoreNumbers = (text, numbers) => {
    if (!text || !numbers || numbers.length === 0) return text;
    return text.replace(/N(\d+)/g, (m, i) => {
        const original = numbers[Number(i)];
        return original !== undefined ? original : m;
    });
};

/**
 * Che TÊN RIÊNG Latin bằng placeholder Q<idx> — chỉ 2 lớp token HẸP, cố tình
 * bảo thủ để từ thường ("Cambodia" → "Campuchia") vẫn dịch bình thường:
 *   (a) chuỗi Latin trong ngoặc CÓ chữ hoa — gloss tên riêng do tác giả bài
 *       ghi, vd "(Huione Pay)"; ngoặc toàn chữ thường ("(photo)") vẫn dịch;
 *   (b) token ALLCAPS >= 3 chữ cái — acronym (ICJ, GCYN), không bao giờ dịch.
 */
const extractLatinNames = (text) => {
    if (!text) return { text, names: [] };
    const names = [];
    const nameRe = /\((?=[^)]*[A-Z])[A-Za-z][A-Za-z0-9&.,'’\- ]{1,40}\)|\b[A-Z]{3,}\b/g;
    const cleaned = text.replace(nameRe, (match) => {
        // Bỏ qua nếu trùng placeholder số sẵn có ("N12") — không bảo vệ 2 lần
        if (/^N\d+$/.test(match)) return match;
        const idx = names.length;
        names.push(match);
        return `Q${idx}`;
    });
    return { text: cleaned, names };
};

/** Đưa lại tên riêng gốc vào vị trí placeholder Q<idx>. */
const restoreLatinNames = (text, names) => {
    if (!text || !names || names.length === 0) return text;
    return text.replace(/Q(\d+)/g, (m, i) => {
        const original = names[Number(i)];
        return original !== undefined ? original : m;
    });
};

/** Che một lượt cả số lẫn tên — thứ tự như manager.js L371–372. */
const protectText = (text) => {
    const { text: t1, numbers } = extractNumbers(text);
    const { text: t2, names } = extractLatinNames(t1);
    return { text: t2, numbers, names };
};

/** Trả lại cả số lẫn tên — thứ tự như manager.js L381–384. */
const restoreText = (text, prot) => restoreLatinNames(
    restoreNumbers(text, prot && prot.numbers),
    prot && prot.names,
);

module.exports = {
    extractNumbers,
    restoreNumbers,
    extractLatinNames,
    restoreLatinNames,
    protectText,
    restoreText,
};

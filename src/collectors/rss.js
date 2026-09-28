/**
 * Collector RSS/Atom — runner GitHub Actions (Node 20, CommonJS).
 *
 * Port từ (CHỈ ĐỌC — không sửa nguồn):
 *   - AutoCollectingNews/newsbot/collector.py: fetch_rss (dòng 66-109),
 *     _entry_datetime (dòng 34-55) + _DATE_FORMATS (dòng 30-31),
 *     _strip_html (dòng 58-63), headers SESSION (dòng 20-25)
 *   - AutoCollectingNews/newsbot/config.py: USER_AGENT (dòng 67-70),
 *     HTTP_TIMEOUT_FEED (dòng 71), MAX_FEED_ENTRIES (dòng 74)
 *   - Thiết kế: plans/chitiet/thiet-ke-runner.md mục 7.2 + plans/KE_HOACH_LAM_LAI_ONLINE_FREE.md 2.2.5
 *
 * Hợp đồng item chuẩn (chung cho MỌI collector HTTP-thuần):
 *   { title: string, url: string, published: string|null (ISO TỪ NGUỒN — pass-through),
 *     summary: string }
 * Trả về: { items, debug }.
 * Nguồn hỏng → throw Error có .lastErrorType ('scan_error' | 'geoblocked') —
 * orchestrator bắt và ghi scan_state.lastError (schema 2.2.3), không làm sập lượt chạy.
 *
 * File này cũng xuất vài công cụ dùng chung cho gnews.js / telegram.js
 * (stripHtml, unescapeHtml, entryDatetimeIso, sourceError, toSourceError, parseFeed).
 */
'use strict';

const Parser = require('rss-parser');

// Hằng số mặc định khớp bảng 5.1 thiet-ke-runner.md / newsbot/config.py.
// Require mềm để file chạy được độc lập khi ghép repo song song — giá trị mặc định
// chính là giá trị thiết kế nên không đổi hành vi khi config.js có mặt.
let cfg = {};
try { cfg = require('../config'); } catch (_) { cfg = {}; }

const HTTP_TIMEOUT_FEED_MS = Number(cfg.HTTP_TIMEOUT_FEED_MS) > 0 ? cfg.HTTP_TIMEOUT_FEED_MS : 25000;
const MAX_FEED_ENTRIES = Number(cfg.MAX_FEED_ENTRIES) > 0 ? cfg.MAX_FEED_ENTRIES : 40;

// UA Chrome — port nguyên newsbot/config.py::USER_AGENT (dòng 67-70)
const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ============================== Lỗi nguồn ==============================

// Tạo Error gắn lastErrorType để orchestrator ghi scan_state.lastError (schema 2.2.3)
function sourceError(type, message, cause) {
  const err = new Error(message);
  err.lastErrorType = type; // 'scan_error' | 'geoblocked'
  if (cause) err.cause = cause;
  return err;
}

// Rút mã HTTP từ lỗi axios (err.response.status) hoặc rss-parser ("Status code 403")
function httpStatusOf(err) {
  const code =
    (err && err.response && err.response.status) ||
    (err && err.status) ||
    (err && err.statusCode) ||
    null;
  if (code) return Number(code) || null;
  const m = /status code (\d{3})/i.exec(String((err && err.message) || ''));
  return m ? Number(m[1]) : null;
}

// Bọc lỗi thô thành lỗi nguồn có lastErrorType; 403/451 = bị chặn khu vực
function toSourceError(err, prefix) {
  const code = httpStatusOf(err);
  const type = code === 403 || code === 451 ? 'geoblocked' : 'scan_error';
  const detail = err && err.message ? err.message : String(err);
  return sourceError(type, `${prefix}: ${detail}`, err);
}

// ============================== HTML → chữ ==============================

// Bản đồ entity thường gặp của nguồn khu vực (đủ cho title/summary RSS + attr HTML)
const _NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  laquo: '«', raquo: '»'
};

// Tương đương html.unescape của Python cho tập entity hay gặp + mọi dạng số (#123 / #x1F)
function unescapeHtml(s) {
  return String(s || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(_NAMED_ENTITIES, body) ? _NAMED_ENTITIES[body] : all;
  });
}

// Port _strip_html — collector.py dòng 58-63: bỏ tag → unescape → gộp khoảng trắng
function stripHtml(raw) {
  return unescapeHtml(String(raw || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ============================== Ngày đăng ==============================

const TZ_OFFSET_HOURS = 7; // Asia/Ho_Chi_Minh (newsbot/config.py::TIMEZONE_NAME) — không có DST

// Che các định dạng lệch chuẩn của _DATE_FORMATS (collector.py dòng 30-31):
// '9/24/2026 1:48:00 PM', '9/24/2026 14:05', '24/9/2026 14:05'... (kèm AM/PM tuỳ chọn)
const _NONSTD_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([APap])\.?[Mm]?\.?)?$/;

/**
 * Thời gian đăng bài (ISO UTC string) từ entry RSS; trả null nếu không có.
 * Port _entry_datetime — collector.py dòng 34-55.
 * 1) rss-parser đã dịch được ngày (item.isoDate ≈ published_parsed của feedparser).
 * 2) Fallback chuỗi sai chuẩn '9/24/2026 1:48:00 PM' (Tuổi Trẻ, Báo Chính phủ VN) —
 *    nguồn trong nước ghi giờ Việt Nam nên gắn múi giờ +7 (giữ nguyên tinh thần
 *    "ISO TỪ NGUỒN": đây là cách đọc ngày nguồn ghi, không phải tự cộng thêm +7).
 */
function entryDatetimeIso(entry) {
  if (entry && entry.isoDate) {
    const d = new Date(entry.isoDate);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Thay khoảng cách U+202F (narrow nbsp) và U+00A0 trước AM/PM bằng dấu cách thường
  const raw = String((entry && (entry.pubDate || entry.updated)) || '')
    .replace(/[  ]/g, ' ')
    .trim();
  if (!raw) return null;
  const m = _NONSTD_DATE.exec(raw);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = Number(m[3]);
  const hh = Number(m[4]);
  const mi = Number(m[5]);
  const ss = m[6] ? Number(m[6]) : 0;
  const ap = m[7] ? m[7].toUpperCase() : null;
  // Thử %m/%d/%Y trước rồi mới %d/%m/%Y — đúng thứ tự _DATE_FORMATS collector.py dòng 30-31
  const pairs = a <= 12 && b <= 31 ? [[a, b], [b, a]] : [[b, a], [a, b]];
  for (const [mo, dd] of pairs) {
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31) continue;
    let hour = hh;
    if (ap) {
      if (hour < 1 || hour > 12) continue; // giờ 12-h trong _DATE_FORMATS %I
      if (hour === 12) hour = 0;
      if (ap === 'P') hour += 12;
    } else if (hour > 23) {
      continue;
    }
    const d = new Date(Date.UTC(y, mo - 1, dd, hour - TZ_OFFSET_HOURS, mi, ss));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

// ============================== rss-parser ==============================

let _parser = null;

// Parser dựng MỘT lần tái dùng cả lượt quét (tinh thần SESSION của collector.py dòng 20-25)
function getParser() {
  if (!_parser) {
    _parser = new Parser({
      timeout: HTTP_TIMEOUT_FEED_MS,
      headers: {
        'User-Agent': UA_CHROME,
        Accept: 'application/rss+xml, application/xml, application/atom+xml, text/xml, */*',
        'Accept-Language': 'en,vi;q=0.8,th;q=0.6,km;q=0.4'
      },
      // Thẻ <source> của Google News RSS = tên báo gốc (dùng bởi gnews.js)
      customFields: { item: ['source'] }
    });
  }
  return _parser;
}

// Tải + parse feed thô (rss-parser); lỗi mạng/XML sẽ ném ra — caller tự bọc toSourceError
async function parseFeed(url) {
  return getParser().parseURL(url);
}

// ============================== Collector chính ==============================

/**
 * Quét một nguồn RSS/Atom.
 * @param {{name?: string, url: string}} source doc nguồn (tenants/{t}/sources/{id})
 * @returns {Promise<{items: Array<{title,url,published,summary}>, debug: object}>}
 */
async function fetchRss(source) {
  const name = (source && source.name) || '';
  const url = String((source && source.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw sourceError('scan_error', `Nguồn RSS "${name}" URL không hợp lệ: ${url || '(trống)'}`);
  }
  let feed;
  try {
    feed = await parseFeed(url);
  } catch (err) {
    throw toSourceError(err, `Nguồn RSS "${name}" lỗi khi tải/paste feed`);
  }

  const items = [];
  for (const entry of ((feed && feed.items) || []).slice(0, MAX_FEED_ENTRIES)) {
    const title = stripHtml(entry.title);
    const link = String(entry.link || '').trim();
    if (!title || !link) continue; // port collector.py dòng 80-82: thiếu tiêu đề/link → bỏ
    items.push({
      title,
      url: link,
      published: entryDatetimeIso(entry),
      // contentSnippet ≈ description đã strip; content là bản đầy đủ — strip lại cho chắc
      summary: stripHtml(entry.contentSnippet || entry.content || '').slice(0, 500)
    });
  }
  return { items, debug: { url, total: items.length } };
}

module.exports = {
  fetchRss,
  // dùng chung cho các collector khác trong src/collectors/
  parseFeed,
  stripHtml,
  unescapeHtml,
  entryDatetimeIso,
  sourceError,
  toSourceError,
  httpStatusOf,
  UA_CHROME,
  HTTP_TIMEOUT_FEED_MS,
  MAX_FEED_ENTRIES
};

/**
 * Collector Google News RSS — runner GitHub Actions (Node 20, CommonJS).
 *
 * Port từ (CHỈ ĐỌC — không sửa nguồn):
 *   - AutoCollectingNews/newsbot/collector.py::fetch_rss nhánh origin 'gn' (dòng 84-93):
 *     tách thẻ <source> = tên báo gốc, bỏ đuôi " - Tên báo" khỏi tiêu đề
 *   - AutoCollectingNews/newsbot/fetcher.py: _GOOGLE_HOST_MARKS/_ASSET_EXT/_is_asset_or_google
 *     (dòng 24-41), _decode_with_library (dòng 47-66), resolve_google_news (dòng 69-97)
 *   - npm google-news-url-decoder v1.2.2 (port JS của googlenewsdecoder):
 *     const { GoogleDecoder } = require('google-news-url-decoder');
 *     new GoogleDecoder().decode(url) / .decodeBatch(urls) → { status, decoded_url, message }
 *   - Thiết kế: plans/chitiet/thiet-ke-runner.md mục 7.3 + KE_HOACH_LAM_LAI_ONLINE_FREE.md 2.2.5
 *
 * Hợp đồng item chuẩn + trường riêng của gnews:
 *   { title, url, published (ISO|null), summary (cap 500), origin_name: string|null }
 *   - url: link bài gốc sau khi decode; decode thất bại → GIỮ link Google News làm manh mối
 *     (KHÔNG ghi field metadata — đã bỏ khỏi schema posts 2.2)
 *   - origin_name: tên báo gốc từ thẻ <source> (feeder dùng để strip đuôi tiêu đề;
 *     orchestrator có thể dùng làm author/source phụ, hoặc bỏ qua)
 * Trả về: { items, debug }. Nguồn hỏng → throw Error có .lastErrorType.
 *
 * THỰC TẾ ĐO ĐƯỢC (fetcher.py + ghi chú vận hành): ngày Google News TRẺ hơn ngày thật
 * tới ~44h — collector vẫn trả published như feed (pass-through), kèm xuất
 * GN_DATE_MAX_SKEW_HOURS + gnewsDateSuspect() để orchestrator re-check cửa sổ
 * thời gian sau deep crawl bằng ngày gốc.
 */
'use strict';

const axios = require('axios');

let cfg = {};
try { cfg = require('../config'); } catch (_) { cfg = {}; }

const {
  parseFeed,
  stripHtml,
  unescapeHtml,
  entryDatetimeIso,
  sourceError,
  toSourceError,
  UA_CHROME,
  MAX_FEED_ENTRIES
} = require('./rss');

const HTTP_TIMEOUT_ARTICLE_MS = Number(cfg.HTTP_TIMEOUT_ARTICLE_MS) > 0 ? cfg.HTTP_TIMEOUT_ARTICLE_MS : 20000;

// Độ lệch ngày tối đa đã đo giữa ngày Google News và ngày đăng thật (giờ)
const GN_DATE_MAX_SKEW_HOURS = 44;

// ============================== Phòng link nhảm ==============================

// Port nguyên _GOOGLE_HOST_MARKS + _ASSET_EXT — fetcher.py dòng 24-28.
// TUYỆT ĐỐI không nhặt link thuộc hệ Google/CDN ảnh (đặc biệt lh3.googleusercontent.com)
const GOOGLE_HOST_MARKS = [
  'google.', 'googleusercontent.com', 'gstatic.com', 'googleapis.com',
  'youtube.com', 'youtu.be', 'blogger.com', 'googleusercontent'
];
const ASSET_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.ico', '.css', '.js'];

/** Port nguyên _is_asset_or_google — fetcher.py dòng 31-41.
 * True nếu url là ảnh/tài nguyên tĩnh hoặc nằm trên hệ máy chủ của Google. */
function isAssetOrGoogle(url) {
  let parts;
  try {
    // Python: urlparse(unquote(url)) — decode phần trăm rồi mới bóc
    parts = new URL(decodeURIComponent(String(url)));
  } catch (_) {
    return true; // URL hỏng → coi như không dùng được (đúng Python ValueError → True)
  }
  const host = (parts.hostname || '').toLowerCase();
  const path = (parts.pathname || '').toLowerCase();
  if (!host || GOOGLE_HOST_MARKS.some((mark) => host.includes(mark))) return true;
  return ASSET_EXT.some((ext) => path.endsWith(ext));
}

// Giá trị decode chỉ nhận khi là http(s) và KHÔNG thuộc hệ Google/CDN ảnh
// (port _decode_with_library — fetcher.py dòng 62-65)
function isValidDecoded(got) {
  return typeof got === 'string' && /^https?:\/\//i.test(got) && !isAssetOrGoogle(got);
}

function hostOf(url) {
  try {
    return (new URL(String(url)).hostname || '').toLowerCase();
  } catch (_) {
    return '';
  }
}

// Link thuộc news.google.com? (so substring như resolve_google_news fetcher.py dòng 82)
function isGnewsUrl(url) {
  return /news\.google\.com/i.test(hostOf(url));
}

// ============================== Giải mã link Google News ==============================

// GoogleDecoder dựng một lần, tái dùng cho cả lượt quét (port _DECODER — fetcher.py dòng 44)
let _decoder;
function getDecoder() {
  if (_decoder !== undefined) return _decoder;
  try {
    const mod = require('google-news-url-decoder');
    const GoogleDecoder = mod.GoogleDecoder || mod.default || mod;
    _decoder = typeof GoogleDecoder === 'function' ? new GoogleDecoder() : null;
  } catch (err) {
    console.log(`[collectors/gnews] không nạp được google-news-url-decoder (${err && err.message}) — chỉ dùng fallback scrape`);
    _decoder = null;
  }
  return _decoder;
}

/**
 * Fallback từng URL — port resolve_google_news (fetcher.py dòng 69-97):
 * (0) nếu decodeBatch chết cả lô, cho thư viện cơ hội decode LẺ;
 * (1) GET follow redirect → url cuối không thuộc news.google.com → trả về
 *     (nhưng nếu là CDN ảnh/Google → coi như không giải được);
 * (2) attr data-n-au="..." trong HTML;
 * (3) href đầu tiên trỏ tới báo thật (bỏ mọi host hệ Google + link tài nguyên tĩnh).
 * Thất bại hết → null (bài vẫn giữ link GN làm manh mối).
 */
async function resolveGnewsUrl(url, decoder, tryLibraryDecode) {
  if (tryLibraryDecode && decoder && typeof decoder.decode === 'function') {
    try {
      const r = await decoder.decode(url);
      const got = r && (r.decoded_url || r.decodedUrl);
      if (r && r.status && isValidDecoded(got)) return got;
    } catch (_) { /* thư viện lỗi — rơi xuống scrape */ }
  }
  try {
    const resp = await axios.get(url, {
      timeout: HTTP_TIMEOUT_ARTICLE_MS, // Python resolve dùng timeout 15s ≈ HTTP_TIMEOUT_ARTICLE
      maxRedirects: 10,
      headers: {
        'User-Agent': UA_CHROME,
        Accept: 'text/html,application/xhtml+xml,*/*'
      }
    });
    const html = typeof resp.data === 'string' ? resp.data : '';
    // url cuối sau chuỗi redirect (requests: resp.url)
    const finalUrl =
      (resp.request && resp.request._redirectable && resp.request._redirectable._currentUrl) ||
      (resp.request && resp.request.res && resp.request.res.responseUrl) ||
      url;
    if (!isGnewsUrl(finalUrl)) {
      // redirect vào CDN ảnh của Google → không giải được (fetcher.py dòng 83-85)
      return isAssetOrGoogle(finalUrl) ? null : finalUrl;
    }
    const m = /data-n-au="([^"]+)"/.exec(html);
    if (m) {
      const got = unescapeHtml(m[1]);
      if (/^https?:\/\//i.test(got) && !isAssetOrGoogle(got)) return got;
    }
    // href đầu tiên trỏ tới báo thật (fetcher.py dòng 90-94)
    for (const h of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
      const cand = unescapeHtml(h[1]);
      if (!isAssetOrGoogle(cand)) return cand;
    }
  } catch (_) { /* mạng/HTTP lỗi — trả null, đúng tinh thần fetcher.py dòng 95-96 */ }
  return null;
}

/**
 * Giải mã hàng loạt link Google News → Map<gnUrl, urlGốc>.
 * (1) decodeBatch gom nhiều URL trong 1 lệnh gọi (endpoint batchexecute nội bộ).
 * (2) decodeBatch lỗi cả lô → fallback TỪNG URL (kèm decode lẻ của thư viện + scrape).
 * (3) link fail trong lô tốt → fallback scrape per-URL.
 * Chết hết → map rỗng, caller giữ link GN làm manh mối.
 */
async function decodeGnewsUrls(urls) {
  const map = new Map();
  const decoder = getDecoder();
  let batchThrew = false;
  if (!urls.length) return map;
  if (decoder) {
    try {
      const results = await decoder.decodeBatch(urls);
      const arr = Array.isArray(results)
        ? results
        : results && Array.isArray(results.results) ? results.results : null;
      if (!arr) throw new Error('decodeBatch trả định dạng không như tài liệu');
      urls.forEach((u, i) => {
        const r = arr[i];
        const got = r && (r.decoded_url || r.decodedUrl);
        if (r && r.status && isValidDecoded(got)) map.set(u, got);
      });
    } catch (err) {
      batchThrew = true;
      console.log(`[collectors/gnews] decodeBatch lỗi cả lô (${err && err.message}) — chuyển fallback từng URL`);
    }
  }
  for (const u of urls) {
    if (map.has(u)) continue;
    const got = await resolveGnewsUrl(u, decoder, batchThrew);
    if (got) map.set(u, got);
  }
  if (map.size || urls.length) {
    console.log(`[collectors/gnews] decode ${map.size}/${urls.length} link Google News`);
  }
  return map;
}

// ============================== Đánh dấu nghi ngờ ngày ==============================

/**
 * Đánh dấu debug bài cần re-check cửa sổ thời gian sau deep crawl.
 * Ngày GN có thể TRẺ hơn thật tới GN_DATE_MAX_SKEW_HOURS → bài "tươi" theo feed
 * vẫn có thể cũ hơn cửa sổ. Trả true khi:
 *   - không có ngày (chưa lọc được — phải chờ ngày gốc), HOẶC
 *   - ngày feed nằm trong khoảng cửa sổ + độ lệch (có thể thực tế đã cũ hơn cửa sổ).
 * @param {string|null} publishedIso ISO từ feed (pass-through)
 * @param {number} windowHours cửa sổ lastHours của lượt chạy
 */
function gnewsDateSuspect(publishedIso, windowHours) {
  if (!publishedIso) return true;
  const t = new Date(publishedIso).getTime();
  if (isNaN(t)) return true;
  const windowMs = (Number(windowHours) > 0 ? Number(windowHours) : 26) * 3600000;
  return Date.now() - t <= windowMs + GN_DATE_MAX_SKEW_HOURS * 3600000;
}

// ============================== Tách <source> ==============================

// customFields {item: ['source']} của rss-parser thường trả chuỗi; phòng khi là object
function readOutletName(entry) {
  const src = entry && entry.source;
  if (!src) return '';
  if (typeof src === 'string') return src.trim();
  if (typeof src === 'object') {
    const text = src._text || src['#text'] || src.text;
    return typeof text === 'string' ? text.trim() : '';
  }
  return '';
}

// ============================== Collector chính ==============================

/**
 * Quét một nguồn Google News RSS (URL nguồn đã được web chuẩn hoá dạng
 * https://news.google.com/rss/search?q=...&hl=..&gl=..&ceid=..).
 * @param {{name?: string, url: string}} source doc nguồn
 * @returns {Promise<{items: Array<{title,url,published,summary,origin_name}>, debug: object}>}
 */
async function fetchGnews(source) {
  const name = (source && source.name) || '';
  const url = String((source && source.url) || '').trim();
  if (!/^https?:\/\/news\.google\.com\/rss\//i.test(url)) {
    throw sourceError(
      'scan_error',
      `Nguồn gnews "${name}" URL phải dạng https://news.google.com/rss/search?... (nhận: ${url || '(trống)'})`
    );
  }

  let feed;
  try {
    feed = await parseFeed(url);
  } catch (err) {
    throw toSourceError(err, `Nguồn gnews "${name}" lỗi khi tải feed`);
  }

  const items = [];
  for (const entry of ((feed && feed.items) || []).slice(0, MAX_FEED_ENTRIES)) {
    let title = stripHtml(entry.title);
    const link = String(entry.link || '').trim();
    const outlet = stripHtml(readOutletName(entry));
    if (!title || !link) continue;
    // Port collector.py dòng 88-93: tiêu đề GN lặp đuôi " - Tên báo" → bỏ cho gọn
    const suffix = outlet ? ` - ${outlet}` : '';
    if (suffix && title.endsWith(suffix)) title = title.slice(0, title.length - suffix.length).trim();
    items.push({
      title,
      url: link,
      published: entryDatetimeIso(entry),
      summary: stripHtml(entry.contentSnippet || entry.content || '').slice(0, 500),
      origin_name: outlet || null
    });
  }

  // Giải mã link Google News → url bài gốc (link trùng lặp gom 1 lần gọi decodeBatch)
  const gnUrls = [...new Set(items.map((it) => it.url).filter((u) => isGnewsUrl(u)))];
  const decoded = await decodeGnewsUrls(gnUrls);
  let unresolved = 0;
  for (const item of items) {
    if (!isGnewsUrl(item.url)) continue;
    const got = decoded.get(item.url);
    if (got) {
      item.url = got;
    } else {
      unresolved++; // giữ link Google News làm manh mối (không ghi field metadata)
    }
  }

  const debug = {
    url,
    total: items.length,
    decoded: decoded.size,
    unresolved,
    gnDateMaxSkewHours: GN_DATE_MAX_SKEW_HOURS,
    note:
      unresolved > 0
        ? `${unresolved} link chưa giải mã được — giữ link Google News làm manh mối. Ngày GN có thể trẻ hơn thật tới ~${GN_DATE_MAX_SKEW_HOURS}h — re-check cửa sổ sau deep crawl bằng ngày gốc`
        : `Ngày GN có thể trẻ hơn thật tới ~${GN_DATE_MAX_SKEW_HOURS}h — re-check cửa sổ sau deep crawl bằng ngày gốc`
  };
  return { items, debug };
}

module.exports = {
  fetchGnews,
  decodeGnewsUrls,
  resolveGnewsUrl,
  gnewsDateSuspect,
  isAssetOrGoogle,
  GN_DATE_MAX_SKEW_HOURS
};

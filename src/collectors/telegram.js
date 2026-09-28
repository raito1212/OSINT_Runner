/**
 * Collector kênh Telegram công khai — runner GitHub Actions (Node 20, CommonJS).
 *
 * Port NGUYÊN từ AutoCollectingNews/newsbot/pages.py::fetch_telegram_channel (dòng 94-146)
 * + regex _TG_TEXT/_TG_TIME (dòng 97-98) + headers SESSION (dòng 25-30).
 * Đối chiếu newsbot/telegram.py: file đó chỉ là Bot API GỬI tin (send_message) —
 * không dính tới việc bóc kênh, nên pages.py là bản chuẩn duy nhất.
 *
 * Cơ chế: mỗi bài đăng trên trang xem trước công khai https://t.me/s/<slug> là 1 khối
 * mở đầu bằng data-post="slug/12345"; chữ nằm trong
 * <div class="tgme_widget_message_text">; ngày giờ trong <time datetime="ISO8601">.
 * Không cần tài khoản, không cần Puppeteer.
 *
 * Hợp đồng item chuẩn (như mọi collector HTTP-thuần):
 *   { title, url, published (ISO|null từ <time datetime>), summary }
 *   - title   = 150 ký tự đầu bài đăng (kênh Telegram không có tiêu đề riêng)
 *   - url     = https://t.me/<slug>/<id>
 *   - summary = 1500 ký tự đầu — TOÀN VĂN bài đăng dùng làm content cho AI,
 *               KHÔNG deep crawl (t.me không có trang bài riêng) — đúng pages.py dòng 132
 * Trả về: { items, debug }. Nguồn hỏng → throw Error có .lastErrorType
 * ('scan_error' | 'geoblocked').
 */
'use strict';

const axios = require('axios');

let cfg = {};
try { cfg = require('../config'); } catch (_) { cfg = {}; }

const { stripHtml, sourceError, toSourceError, UA_CHROME, HTTP_TIMEOUT_FEED_MS } = require('./rss');

const MAX_FEED_ENTRIES = Number(cfg.MAX_FEED_ENTRIES) > 0 ? cfg.MAX_FEED_ENTRIES : 40;

// Port nguyên pages.py dòng 97-98
const TG_TEXT = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const TG_TIME = /<time[^>]+datetime="([^"]+)"/i;

/**
 * Chuẩn hoá URL nguồn về slug kênh: t.me/x, t.me/s/x, https://t.me/s/x,
 * telegram.me/x → 'x'. Trả null nếu không nhận diện được.
 * (Web đã chuẩn hoá thành https://t.me/s/<slug> khi lưu — đây là lớp phòng thủ runner.)
 */
function normalizeTelegramSlug(raw) {
  const url = String(raw || '').trim();
  const m = /(?:^|\/\/|\.)(?:t\.me|telegram\.me)\/(?:s\/)?@?([A-Za-z0-9_]{3,64})(?:[/?#]|$)/i.exec(url);
  return m ? m[1] : null;
}

/**
 * Chuyển <time datetime> của t.me sang ISO UTC string; trả null nếu sai định dạng.
 * Port pages.py dòng 120-125: chuỗi không kèm múi giờ → coi theo UTC
 * (t.me thực tế luôn kèm sẵn Z hoặc +00:00).
 */
function isoFromTelegramTime(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!/(z|[+-]\d{2}:?\d{2})$/i.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Đọc một kênh Telegram công khai qua trang xem trước.
 * @param {{name?: string, url: string}} source doc nguồn (url dạng t.me/... đã chuẩn hoá)
 * @returns {Promise<{items: Array<{title,url,published,summary}>, debug: object}>}
 */
async function fetchTelegram(source) {
  const name = (source && source.name) || '';
  const slug = normalizeTelegramSlug(source && source.url);
  if (!slug) {
    throw sourceError(
      'scan_error',
      `Nguồn Telegram "${name}" không nhận diện được slug kênh từ URL: ${String((source && source.url) || '(trống)')}`
    );
  }

  let html;
  try {
    const resp = await axios.get(`https://t.me/s/${slug}`, {
      timeout: HTTP_TIMEOUT_FEED_MS, // pages.py dùng HTTP_TIMEOUT_FEED cho t.me
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': UA_CHROME,
        Accept: 'text/html,application/xhtml+xml,application/xml,*/*', // port pages.py dòng 28
        'Accept-Language': 'en,vi;q=0.8,th;q=0.6,km;q=0.4' // port pages.py dòng 29
      }
    });
    html = typeof resp.data === 'string' ? resp.data : '';
  } catch (err) {
    throw toSourceError(err, `Kênh Telegram "${name}" lỗi tải trang xem trước`);
  }

  const items = [];
  // Mỗi khối bắt đầu bằng data-post="slug/12345" (pages.py dòng 110-111)
  for (const chunk of html.split('data-post="').slice(1)) {
    const postId = chunk.split('"')[0]; // 'slug/12345'
    if (!postId || postId.indexOf('/') === -1) continue;
    const mText = TG_TEXT.exec(chunk);
    const mTime = TG_TIME.exec(chunk);
    if (!mText || !mTime) continue; // bài chỉ có ảnh/video, không có chữ (pages.py dòng 112-114)
    // <br> ngăn dòng TRƯỚC khi strip tag để chữ hai dòng không dính vào nhau (pages.py dòng 115-116)
    const raw = mText[1].replace(/<br\s*\/?>/gi, ' ');
    const text = stripHtml(raw);
    if (text.length < 30) continue; // sticker/quảng cáo quá ngắn (pages.py dòng 117-119)
    items.push({
      title: text.slice(0, 150).replace(/\s+$/, ''), // rstrip như pages.py dòng 128
      url: `https://t.me/${postId}`,
      published: isoFromTelegramTime(mTime[1]),
      summary: text.slice(0, 1500) // toàn văn bài đăng — dùng làm content, không deep crawl
    });
  }

  // DOM xếp cũ → mới: giữ N bài mới nhất (pages.py dòng 138-139)
  const kept = items.length > MAX_FEED_ENTRIES ? items.slice(items.length - MAX_FEED_ENTRIES) : items;

  const debug = { channel: `t.me/s/${slug}`, total: kept.length };
  if (!kept.length) {
    debug.note = 'Không bóc được bài nào — kênh trống, chỉ có ảnh/video, hoặc trang đổi cấu trúc';
  }
  return { items: kept, debug };
}

module.exports = { fetchTelegram, normalizeTelegramSlug };

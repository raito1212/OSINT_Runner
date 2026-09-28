/**
 * Collector website (HTTP thuần — axios + cheerio, KHÔNG Puppeteer).
 *
 * Port NGUYÊN từ agent: D:/IT_Project/OSINT_Web/agent/src/collector/website.js
 * (dòng 1–808 — phần Puppeteer 810–1016 KHÔNG port: runner không có trình duyệt).
 *
 * Khác biệt duy nhất so với bản agent (theo thiet-ke-runner.md mục 7.1 + GHI ĐÈ 7):
 *   1. Nhánh "thử lại bằng Puppeteer" khi gặp SPA → throw NeedsBrowserError
 *      (thông điệp đúng nguyên văn KE_HOACH mục 2.2.5) để runScan ghi
 *      scan_state.lastError {type:'needs_browser', ...} cho web UI hiển thị badge.
 *   2. Item trả về theo ITEM CHUẨN HỢP ĐỒNG của runner:
 *        { text, title|null, url, images[], published: ISO string|null }
 *      (text = nội dung mục bóc từ trang danh sách; published pass-through từ
 *      nguồn — KHÔNG tự +7h, ngày trần không múi giờ được gắn +7 như
 *      newsbot/collector.py::_entry_datetime + fetcher.py::_page_date).
 *   3. fetchFullContent trả { text, publishedDate: Date|null } | null thay vì
 *      mảng kết quả (deep-crawl chỉ cần nội dung + ngày gốc).
 *
 * Export hợp đồng: collectWebsite(source), fetchFullContent(url, detailSelector,
 * excludeSelector), NeedsBrowserError. KHÔNG đụng file nào khác.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { HTTP_TIMEOUT_ARTICLE_MS, TZ_OFFSET_MS } = require('../config');

/** Thông điệp GHI ĐÈ 7 / KE_HOACH mục 2.2.5 — giữ đúng nguyên văn. */
const SPA_NEEDS_BROWSER_MESSAGE =
    'Nguồn SPA cần trình duyệt — chưa hỗ trợ. Hãy dùng RSS của trang hoặc nguồn social_generic';

/**
 * Lỗi "nguồn cần trình duyệt": runScan bắt instanceof NeedsBrowserError
 * → ghi scan_state.lastError {type:'needs_browser', message, timestamp}.
 */
class NeedsBrowserError extends Error {
    constructor(message = SPA_NEEDS_BROWSER_MESSAGE) {
        super(message);
        this.name = 'NeedsBrowserError';
        this.type = 'needs_browser';
    }
}

/**
 * Gọi HTTP chung cho mọi lượt tải của collector này:
 * timeout HTTP_TIMEOUT_ARTICLE_MS · maxRedirects 5 · nhận status < 400
 * · axios tự giải nén gzip (decompress mặc định) — header Accept-Encoding
 * để máy chủ biết có thể trả gzip.
 */
const fetchHtml = async (url) => {
    const { data } = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate'
        },
        timeout: HTTP_TIMEOUT_ARTICLE_MS,
        maxRedirects: 5,
        validateStatus: (status) => status < 400,
        decompress: true
    });
    return data;
};

/**
 * Escape dấu hai chấm kiểu Tailwind trong CSS selector.
 * VD: "hover:bg-gray-50" -> "hover\:bg-gray-50".
 * Port nguyên từ agent website.js dòng 12–47.
 */
const escapeSelector = (selector) => {
    if (!selector) return selector;

    const validPseudoClasses = [
        'first-child', 'last-child', 'nth-child', 'nth-of-type', 'first-of-type', 'last-of-type',
        'only-child', 'empty', 'not', 'has', 'contains', 'root', 'hover', 'active', 'focus',
        'visited', 'checked', 'disabled', 'enabled', 'selected', 'before', 'after',
        'first-letter', 'first-line', 'lang', 'target', 'is', 'where'
    ];

    let result = selector;
    const colonPositions = [];

    for (let i = 0; i < result.length; i++) {
        if (result[i] === ':') colonPositions.push(i);
    }

    for (let i = colonPositions.length - 1; i >= 0; i--) {
        const pos = colonPositions[i];
        // Bỏ qua colon đã escape sẵn (vd "hover\:bg-gray-50" từ CSS.escape ở frontend).
        // Escape tiếp sẽ thành double-escape ("hover\\:...") mà cheerio báo lỗi pseudo-class.
        if (pos > 0 && result[pos - 1] === '\\') continue;
        const afterColon = result.substring(pos + 1);

        const isValidPseudo = validPseudoClasses.some(pc => {
            const pattern = new RegExp(`^${pc}(\\(|[^a-zA-Z-]|$)`);
            return pattern.test(afterColon);
        });

        if (!isValidPseudo) {
            result = result.substring(0, pos) + '\\:' + result.substring(pos + 1);
        }
    }

    return result;
};

/**
 * Selector bài viết phổ biến theo nhóm CMS/quốc gia.
 * Port nguyên từ agent website.js dòng 52–122.
 */
const COMMON_ARTICLE_SELECTORS = {
    // HTML5 chung
    generic: ['article', 'main article', '[role="article"]'],

    // Báo kiểu bảng/danh sách (kiểu Fresh News Cambodia)
    tableList: [
        'tr.list-title', 'table tbody tr', 'table tr',
        '.news-list-item', '.article-list-item', '.post-list-item',
        'ul.news-list > li', 'ul.article-list > li'
    ],

    // WordPress
    wordpress: [
        'article.post', 'article.type-post', '.post-entry', '.entry-content',
        '.hentry', 'article.hentry', '.post-article', '.single-post'
    ],

    // Bootstrap
    bootstrap: [
        '.card', '.card-body', '.media', '.list-group-item',
        '.news-item', '.blog-post', '.card-article'
    ],

    // Tailwind CSS
    tailwind: [
        '.prose', '[class*="article"]', '[class*="post-"]',
        '[class*="news-item"]', '[class*="blog-"]'
    ],

    // React/Next.js
    react: [
        '[data-testid="article"]', '[data-article]', '[data-post]',
        '[class*="ArticleCard"]', '[class*="PostCard"]', '[class*="NewsCard"]'
    ],

    // Báo Việt Nam
    vietnamese: {
        vnexpress: ['article.item-news', 'article.item-news-common', '.title-news', '.thumb-art'],
        thanhnien: ['.article-item', '.news-item', '.story'],
        tuoitre: ['.news-item', '.article-content', '.story'],
        dantri: ['.news-item', '.article-item', '.eplitem'],
        vnn: ['.article-item', '.news-item'],
        laodong: ['.article-item', '.news-item', '.item-news'],
        vietnamnet: ['.article-item', '.news-item', '.item']
    },

    // Báo Campuchia
    cambodian: {
        freshnews: ['tr.list-title', 'table tbody tr', 'tr.hover\\:bg-gray-50'],
        thmeythmey: ['.article-item', '.news-item', 'article'],
        kohsantepheap: ['.news-item', '.article-item', 'article'],
        kampucheathmey: ['.news-item', '.article-item']
    },

    // Báo Thái Lan
    thai: {
        thaipbs: ['.news-item', '.article-item', 'article'],
        khaosod: ['.news-item', '.article-item', 'article'],
        bangkokpost: ['.article-item', '.news-item', 'article'],
        nationthailand: ['.news-item', '.article-item']
    },

    // Quốc tế
    international: {
        bbc: ['article', '[data-component="card"]', '.media-item'],
        cnn: ['article', '.container__item', '.card'],
        reuters: ['article', '[data-testid="Heading"]', '.story-card'],
        aljazeera: ['article', '.gc__item', '.post-item'],
        guardian: ['article', '.fc-item', '.dcr-uwjhh1']
    }
};

/**
 * Nhận diện loại site từ URL — port nguyên từ agent website.js dòng 127–162.
 */
const detectSiteType = (url) => {
    const hostname = (() => {
        try { return new URL(url).hostname.toLowerCase(); }
        catch { return ''; }
    })();

    // Báo Việt Nam
    if (/vnexpress\.net$/i.test(hostname)) return { type: 'vnexpress', category: 'vietnamese' };
    if (/thanhnien\.vn$/i.test(hostname)) return { type: 'thanhnien', category: 'vietnamese' };
    if (/tuoitre\.vn$/i.test(hostname)) return { type: 'tuoitre', category: 'vietnamese' };
    if (/dantri\.com\.vn$/i.test(hostname)) return { type: 'dantri', category: 'vietnamese' };
    if (/vietnamnet\.vn$/i.test(hostname)) return { type: 'vietnamnet', category: 'vietnamese' };
    if (/laodong\.vn$/i.test(hostname)) return { type: 'laodong', category: 'vietnamese' };
    if (/nld\.com\.vn$/i.test(hostname)) return { type: 'laodong', category: 'vietnamese' };

    // Báo Campuchia
    if (/freshnews\.com\.kh$/i.test(hostname)) return { type: 'freshnews', category: 'cambodian' };
    if (/thmeythmey\.com$/i.test(hostname)) return { type: 'thmeythmey', category: 'cambodian' };
    if (/kohsantepheapdaily\.com\.kh$/i.test(hostname)) return { type: 'kohsantepheap', category: 'cambodian' };
    if (/kampucheathmey\.com$/i.test(hostname)) return { type: 'kampucheathmey', category: 'cambodian' };

    // Báo Thái Lan
    if (/thaipbs\.or\.th$/i.test(hostname)) return { type: 'thaipbs', category: 'thai' };
    if (/khaosod\.co\.th$/i.test(hostname)) return { type: 'khaosod', category: 'thai' };
    if (/bangkokpost\.com$/i.test(hostname)) return { type: 'bangkokpost', category: 'thai' };
    if (/nationthailand\.com$/i.test(hostname)) return { type: 'nationthailand', category: 'thai' };

    // Quốc tế
    if (/bbc\.com$/i.test(hostname)) return { type: 'bbc', category: 'international' };
    if (/cnn\.com$/i.test(hostname)) return { type: 'cnn', category: 'international' };
    if (/reuters\.com$/i.test(hostname)) return { type: 'reuters', category: 'international' };
    if (/aljazeera\.com$/i.test(hostname)) return { type: 'aljazeera', category: 'international' };
    if (/theguardian\.com$/i.test(hostname)) return { type: 'guardian', category: 'international' };

    return { type: 'generic', category: 'generic' };
};

/**
 * Danh sách selector fallback thông minh theo loại site.
 * Port nguyên từ agent website.js dòng 167–187.
 */
const getSmartFallbacks = (siteType) => {
    const fallbacks = [];

    // Selector riêng của site đứng trước
    if (siteType.category && COMMON_ARTICLE_SELECTORS[siteType.category]) {
        const categorySelectors = COMMON_ARTICLE_SELECTORS[siteType.category];
        if (categorySelectors[siteType.type]) {
            fallbacks.push(...categorySelectors[siteType.type]);
        }
    }

    // Sau đó là các selector generic
    fallbacks.push(...COMMON_ARTICLE_SELECTORS.generic);
    fallbacks.push(...COMMON_ARTICLE_SELECTORS.tableList);
    fallbacks.push(...COMMON_ARTICLE_SELECTORS.wordpress);
    fallbacks.push(...COMMON_ARTICLE_SELECTORS.bootstrap);
    fallbacks.push(...COMMON_ARTICLE_SELECTORS.tailwind);
    fallbacks.push(...COMMON_ARTICLE_SELECTORS.react);

    return [...new Set(fallbacks)];
};

// ============================================================================
// Parse ngày phát hiện được (meta/JSON-LD/text pattern) → Date | ISO string.
// Port tinh thần AutoCollectingNews/newsbot/collector.py::_entry_datetime
// (dòng 34–56) + fetcher.py::_page_date (dòng 121–136):
//   - Ngày CÓ múi giờ (Z / +07:00) → giữ nguyên instant (pass-through).
//   - Ngày TRẦN không múi giờ → gắn múi giờ +7 (nguồn khu vực VN/KH/TH/LO
//     đều GMT+7; lệch vài giờ chỉ ảnh hưởng lân cận biên cửa sổ).
//   - Không parse được (Khmer/Thai chữ, rác) → null.
// ============================================================================

const MONTHS_EN = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
];

/** ISO đầy đủ kèm múi giờ: 2026-04-22T07:17:28[.123](Z|+07:00|+0700) */
const RE_ISO_WITH_TZ = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
/** ISO trần (không múi giờ), có thể chỉ ngày: 2026-04-22[T07:17[:28]] */
const RE_BARE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
/** Dạng số: 24/09/2026 10:30 · 9/24/2026 1:48 PM không giữ AM/PM → chỉ phần 24h */
const RE_NUM_DATE = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** "March 12, 2024" / "March 12 2024" */
const RE_MONTH_FIRST = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/;
/** "12 March 2024" */
const RE_DAY_FIRST = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/;

/** Đổi chuỗi múi giờ (Z | +07:00 | -0700) sang phút; không hợp lệ → null. */
const parseTzOffsetMinutes = (tz) => {
    if (tz === 'Z') return 0;
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
};

/** dựng Date từ thành phần + độ lệch múi giờ (phút); kiểm tra khoảng hợp lệ. */
const buildInstant = (y, mo, d, hh, mi, ss, offsetMinutes) => {
    if (!(y >= 1990 && y <= 2100)) return null;
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    if (!(hh >= 0 && hh <= 23 && mi >= 0 && mi <= 59 && ss >= 0 && ss <= 59)) return null;
    return new Date(Date.UTC(y, mo - 1, d, hh, mi, ss) - offsetMinutes * 60000);
};

/** Năm 2 chữ số → 20XX (dòng 294–295 agent quét dạng DD/MM/YY). */
const expandYear = (y) => (y < 100 ? 2000 + y : y);

/**
 * Chuỗi ngày phát hiện được từ trang → Date | null.
 * Xử lý cả 2 thứ tự ngày/tháng của RE_NUM_DATE: số đầu > 12 → ngày-trước,
 * số sau > 12 → tháng-trước, không phân biệt nổi → mặc định ngày-trước
 * (quy ước khu vực VN/KH/TH).
 */
const detectedDateToDate = (raw) => {
    if (!raw) return null;
    const text = String(raw).replace(/\u00a0/g, ' ').trim();
    if (!text || text.length > 100) return null;

    let m = RE_ISO_WITH_TZ.exec(text);
    if (m) {
        const offset = parseTzOffsetMinutes(m[7]);
        if (offset === null) return null;
        return buildInstant(
            parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10),
            parseInt(m[4], 10), parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0,
            offset
        );
    }

    m = RE_BARE_DATETIME.exec(text);
    if (m) {
        // Trần không múi giờ → gắn +7 (TZ_OFFSET_MS của config.js)
        return buildInstant(
            parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10),
            m[4] ? parseInt(m[4], 10) : 0, m[5] ? parseInt(m[5], 10) : 0,
            m[6] ? parseInt(m[6], 10) : 0,
            TZ_OFFSET_MS / 60000
        );
    }

    m = RE_NUM_DATE.exec(text);
    if (m) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        const y = expandYear(parseInt(m[3], 10));
        const hh = m[4] ? parseInt(m[4], 10) : 0;
        const mi = m[5] ? parseInt(m[5], 10) : 0;
        const ss = m[6] ? parseInt(m[6], 10) : 0;
        // Phân biệt ngày-trước / tháng-trước theo giá trị > 12
        const dayFirst = b > 12 ? false : true; // a>12 ⇒ ngày-trước; b>12 ⇒ tháng-trước
        let inst = dayFirst
            ? buildInstant(y, b, a, hh, mi, ss, TZ_OFFSET_MS / 60000)
            : buildInstant(y, a, b, hh, mi, ss, TZ_OFFSET_MS / 60000);
        if (!inst) {
            // Thứ tự chọn mặc định ra ngoài lẻ (vd 31 làm tháng) → thử thứ tự kia
            inst = dayFirst
                ? buildInstant(y, a, b, hh, mi, ss, TZ_OFFSET_MS / 60000)
                : buildInstant(y, b, a, hh, mi, ss, TZ_OFFSET_MS / 60000);
        }
        return inst;
    }

    m = RE_MONTH_FIRST.exec(text);
    if (m) {
        const mo = MONTHS_EN.indexOf(m[1].toLowerCase()) + 1;
        if (mo > 0) {
            return buildInstant(parseInt(m[3], 10), mo, parseInt(m[2], 10), 0, 0, 0, TZ_OFFSET_MS / 60000);
        }
        return null;
    }

    m = RE_DAY_FIRST.exec(text);
    if (m) {
        const mo = MONTHS_EN.indexOf(m[2].toLowerCase()) + 1;
        if (mo > 0) {
            return buildInstant(parseInt(m[3], 10), mo, parseInt(m[1], 10), 0, 0, 0, TZ_OFFSET_MS / 60000);
        }
        return null;
    }

    // Ngày chữ Khmer/Thai và các dạng lạ → null (không đoán)
    return null;
};

/** Chuỗi ngày phát hiện được → ISO string | null (cho item.published). */
const parseDetectedDate = (raw) => {
    const dt = detectedDateToDate(raw);
    return dt && !isNaN(dt.getTime()) ? dt.toISOString() : null;
};

/**
 * Bóc dữ liệu 1 mục từ element danh sách.
 * Port nguyên từ agent website.js dòng 192–332 — CHỈ đổi đầu ra:
 * thay vì {text, metadata:{...}} trả ITEM CHUẨN HỢP ĐỒNG runner
 * {text, title, url, images, published} (published = ISO|null đã parse).
 */
const extractArticleFromElement = ($, element, url, pageTitle, selectorUsed, dateSelector = '') => {
    const el = $(element);

    // Bỏ element phi nội dung
    if (el.find('nav, footer, header, .sidebar, .menu, .navigation, .advertisement, .ads').length > 0) {
        return null;
    }

    // Bóc tiêu đề — thử nhiều selector
    const titleSelectors = [
        'h1', 'h2', 'h3', 'h4',
        '.title', '.entry-title', '.post-title', '.article-title',
        'a[title]', '.headline', '.news-title',
        'td a', 'a' // layout kiểu bảng
    ];

    let itemTitle = '';
    for (const sel of titleSelectors) {
        const titleEl = el.find(sel).first();
        if (titleEl.length && titleEl.text().trim().length > 10) {
            itemTitle = titleEl.text().trim();
            break;
        }
    }

    // Bóc nội dung chữ
    let itemText = el.text()
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (itemText.length < 20) return null;

    // Bóc link
    let bestUrl = url;
    const linkSelectors = [
        'h1 a[href]', 'h2 a[href]', 'h3 a[href]',
        'a[title][href]', 'a[href*=".html"]',
        'a[href]:not([href*="javascript"])', 'a'
    ];

    for (const sel of linkSelectors) {
        const linkEl = el.find(sel).first();
        if (linkEl.length) {
            const href = linkEl.attr('href');
            if (href && !href.startsWith('javascript') && !href.startsWith('#')) {
                try {
                    bestUrl = new URL(href, url).href;
                    // Bỏ link chia sẻ mạng xã hội
                    if (!/facebook\.com\/sharer|twitter\.com\/intent|linkedin\.com\/share/i.test(bestUrl)) {
                        break;
                    }
                } catch (e) { }
            }
        }
    }

    // Bóc ảnh
    const images = [];
    el.find('img').each((_, img) => {
        const src = $(img).attr('src') ||
                    $(img).attr('data-src') ||
                    $(img).attr('data-lazy-src') ||
                    $(img).attr('data-original');
        if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
            try {
                images.push(new URL(src, url).href);
            } catch (e) {
                images.push(src);
            }
        }
    });

    // Bóc ngày — selector người dùng ưu tiên hơn mặc định
    let detectedDate = null;
    const dateSelectors = dateSelector
        ? [dateSelector, 'time[datetime]', 'time', '.date', '.post-date', '.publish-date',
           '.entry-date', '.article-date', '.timestamp', '[datetime]',
           'td:last-child', 'td:nth-child(2)', '.meta-date', '.news-date']
        : ['time[datetime]', 'time', '.date', '.post-date', '.publish-date',
           '.entry-date', '.article-date', '.timestamp', '[datetime]',
           'td:last-child', 'td:nth-child(2)', '.meta-date', '.news-date'];

    for (const sel of dateSelectors) {
        const dateEl = el.find(sel).first();
        if (dateEl.length) {
            const dt = dateEl.attr('datetime') || dateEl.attr('content') || dateEl.text().trim();
            if (dt && dt.length > 4 && dt.length < 50) {
                detectedDate = dt;
                break;
            }
        }
    }

    // Dự phòng: quét pattern ngày trong text mục khi CSS selector bỏ sót
    if (!detectedDate) {
        const textToScan = itemText.slice(0, 500);
        const datePatterns = [
            /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\s+\d{1,2}:\d{2}/,          // DD/MM/YYYY HH:MM
            /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2}\s+\d{1,2}:\d{2}/,           // DD/MM/YY HH:MM
            /\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\s+\d{1,2}:\d{2}/,           // YYYY-MM-DD HH:MM
            /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/,                            // DD/MM/YYYY
            /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2}/,                            // DD/MM/YY
            /[០-៩]{1,2}\s+[ក-អ]+\s+[០-៩]{4}/,                              // ngày Khmer
            /\d{1,2}\s+[ก-ฮ]+\s+\d{4}/,                                    // ngày Thái
            /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
            /\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i
        ];
        for (const pattern of datePatterns) {
            const match = textToScan.match(pattern);
            if (match) {
                detectedDate = match[0];
                break;
            }
        }
    }

    // Dự phòng: ngày từ slug URL (vd /425331-2026-04-22-07-17-28)
    if (!detectedDate && bestUrl !== url) {
        const urlDateMatch = bestUrl.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
        if (urlDateMatch) {
            detectedDate = `${urlDateMatch[1]}-${urlDateMatch[2]}-${urlDateMatch[3]}T${urlDateMatch[4]}:${urlDateMatch[5]}:00`;
        }
    }

    // ITEM CHUẨN HỢP ĐỒNG runner — published là ISO pass-through hoặc null
    return {
        text: itemText,
        title: itemTitle || pageTitle || null,
        url: bestUrl,
        images: [...new Set(images)].slice(0, 5),
        published: parseDetectedDate(detectedDate)
    };
};

/**
 * Quét trang danh sách (axios + cheerio).
 * Port nguyên từ agent website.js dòng 337–477, thay đổi:
 *   - SPA + 0 item → throw NeedsBrowserError (bỏ nhánh Puppeteer);
 *   - item là ITEM CHUẨN HỢP ĐỒNG runner.
 */
const collectFromWebsite = async (url, selector = 'article', dateSelector = '') => {
    try {
        console.log(`[website] Đang tải trang danh sách ${url} với selector "${selector}"`);

        const data = await fetchHtml(url);

        const $ = cheerio.load(data);
        const items = [];
        const debug = { url, requested_selector: selector };

        const pageTitle = $('title').text().trim();
        const pageDescription = $('meta[name="description"]').attr('content') || '';

        // Nhận diện loại site để có fallback thông minh
        const siteType = detectSiteType(url);
        console.log(`[website] Loại site: ${siteType.type} (${siteType.category})`);
        debug.site_type = siteType;

        // Xóa element nhiễu
        $('script, style, noscript, iframe, svg, .ads, .advertisement, .social-share, .comments').remove();

        // Thử selector người dùng trước
        let elements = $();
        const selectorList = selector.split(',').map(s => s.trim()).filter(s => s);
        const usedSelectors = [];

        for (const singleSelector of selectorList) {
            const safeSelector = escapeSelector(singleSelector);
            try {
                const found = $(safeSelector);
                if (found.length > 0) {
                    elements = elements.add(found);
                    usedSelectors.push(singleSelector);
                    console.log(`[website] Selector "${singleSelector}" khớp ${found.length} element`);
                }
            } catch (e) {
                console.warn(`[website] Selector không hợp lệ "${singleSelector}": ${e.message}`);
            }
        }

        debug.matched_selectors = usedSelectors;
        debug.matched_counts = {};
        usedSelectors.forEach(s => {
            try {
                debug.matched_counts[s] = $(escapeSelector(s)).length;
            } catch (e) { }
        });

        // Bóc bài từ các element khớp
        elements.each((i, el) => {
            const article = extractArticleFromElement($, el, url, pageTitle, usedSelectors.join(', '), dateSelector);
            if (article) items.push(article);
        });

        // Chưa đủ item → thử các fallback thông minh
        if (items.length < 3) {
            console.log(`[website] Chỉ được ${items.length} item — thử fallback thông minh...`);
            const fallbacks = getSmartFallbacks(siteType);

            for (const fb of fallbacks) {
                if (usedSelectors.includes(fb)) continue;

                const safeFb = escapeSelector(fb);
                try {
                    const fbEls = $(safeFb);
                    if (fbEls.length > 2) {
                        const fbItems = [];
                        fbEls.each((i, el) => {
                            const article = extractArticleFromElement($, el, url, pageTitle, fb, dateSelector);
                            if (article) fbItems.push(article);
                        });

                        if (fbItems.length > items.length) {
                            items.length = 0;
                            items.push(...fbItems);
                            debug.used_fallback = fb;
                            console.log(`[website] Fallback "${fb}" được ${fbItems.length} item`);
                            if (items.length >= 10) break;
                        }
                    }
                } catch (e) { }
            }
        }

        // Khử trùng lặp theo nội dung / URL
        const uniqueItems = items.filter((item, index, self) =>
            index === self.findIndex((t) =>
                t.text === item.text ||
                (t.url && t.url === item.url && t.url !== url)
            )
        );

        // Hết đường bóc mục: kiểm tra SPA → throw NeedsBrowserError
        // (THAY cho nhánh Puppeteer của agent — runner không có trình duyệt)
        if (uniqueItems.length === 0) {
            if (isSPASignature(data, $)) {
                console.warn(`[website] Phát hiện SPA — nguồn cần trình duyệt, bỏ qua: ${url}`);
                debug.spa_detected = true;
                throw new NeedsBrowserError();
            }

            // Fallback cuối: bóc text body
            console.log(`[website] Không bóc được item nào — fallback text body`);
            const bodyText = $('main').text() || $('#content').text() || $('.content').text() || $('body').text();
            const cleanedText = bodyText.replace(/\s+/g, ' ').trim().slice(0, 3000);
            if (cleanedText.length > 100) {
                uniqueItems.push({
                    text: cleanedText,
                    title: pageTitle || null,
                    url: url,
                    images: [],
                    published: null
                });
            }
        }

        console.log(`[website] Trả về ${uniqueItems.length} item từ ${url}`);
        return { items: uniqueItems, debug };

    } catch (error) {
        if (error instanceof NeedsBrowserError) throw error; // để runScan ghi needs_browser
        console.error(`[website] Lỗi quét trang (${url}): ${error.message}`);
        throw error;
    }
};

/**
 * Kiểm tra HTML có phải SPA (app render phía client) không.
 * Port nguyên từ agent website.js dòng 775–808.
 * Phân biệt:
 *   - Site thường 0 bài mới (vẫn có cấu trúc DOM thật: header, nav, div...)
 *   - SPA chưa render (gần như rỗng: chỉ <div id="root">)
 */
const isSPASignature = (html, $) => {
    const bodyText = $('body').text().trim();
    const bodyChars = bodyText.replace(/\s/g, '').length;

    // Đếm element DOM thật trong <body> (trừ script/style)
    const realElements = $('body').find('*').not('script, style, noscript, link, meta').length;

    // Site thường luôn có nhiều DOM (header, nav, footer...) dù 0 bài;
    // SPA chưa render JS thì rất ít.
    if (realElements > 30 && bodyChars > 500) {
        console.log(`[SPA] Site thường — ${realElements} element, ${bodyChars} ký tự → KHÔNG phải SPA`);
        return false;
    }

    // Dấu hiệu SPA: body gần rỗng (chỉ điểm mount như <div id="root">)
    if (bodyChars < 200 && realElements < 15) {
        console.log(`[SPA] Body rỗng — ${realElements} element, ${bodyChars} ký tự → khả năng SPA`);
        return true;
    }

    // Dấu hiệu framework SPA + nội dung render tối thiểu
    const headHtml = $('head').html() || '';
    const hasSPAFramework =
        /__NEXT_DATA__|__NUXT__|ng-app|ng-version|react-root|react-app|_reactRootContainer/i.test(headHtml) ||
        /webpack|vite|chunk\.js|app\.[a-f0-9]+\.js/i.test(headHtml);

    if (hasSPAFramework && bodyChars < 500) {
        console.log(`[SPA] Có marker framework + nội dung ít (${bodyChars} ký tự) → khả năng SPA`);
        return true;
    }

    console.log(`[SPA] Không kết luận được — ${realElements} element, ${bodyChars} ký tự → không phải SPA`);
    return false;
};

/**
 * Deep crawl nội dung đầy đủ 1 trang bài + ngày đăng gốc.
 * Port nguyên từ agent website.js dòng 482–767 (bestElement 2 pha: selector
 * người dùng → fallback; bóc ngày meta/JSON-LD/selector/pattern; strip nhiễu
 * đầu bài). THAY ĐỔI: trả {text, publishedDate: Date|null} | null — bỏ
 * images/title khỏi đầu ra (deep crawl chỉ cần text + ngày), bỏ nhánh
 * Puppeteer (fetchFullContentPuppeteer dòng 918–1014 không port).
 *
 * @param {string} url URL trang bài
 * @param {string} [selector] CSS selector vùng nội dung (detail_selector của nguồn)
 * @param {string} [excludeSelector] CSS selector phần cần bỏ
 * @returns {Promise<{text: string, publishedDate: Date|null}|null>}
 */
const fetchFullContent = async (url, selector = 'article, .content, .post-body, .entry-content, main', excludeSelector = '') => {
    try {
        console.log(`[website] Deep crawl bài: ${url}`);

        const data = await fetchHtml(url);
        const $ = cheerio.load(data);

        // Xóa nhiễu
        $('script, style, nav, footer, header, iframe, .ads, .advertisement, .sidebar, .related-post, .comment, .share, .social').remove();

        // Xóa phần người dùng yêu cầu bỏ
        if (excludeSelector) {
            const excludeList = excludeSelector.split(',').map(s => s.trim()).filter(s => s);
            for (const excl of excludeList) {
                try { $(excl).remove(); } catch (e) { }
            }
        }

        const pageTitle = $('title').text().trim();

        // Tách selector người dùng + fallback
        const userSelectors = selector.split(',').map(s => s.trim()).filter(s => s);
        const fallbackSelectors = [
            'article', '.article-content', '.post-content', '.entry-content',
            '.content', 'main', '.main-content', '#content', '.post', '.single-content',
            '[itemprop="articleBody"]', '.text-content', '.news-content'
        ];

        let bestElement = null;
        let bestLength = 0;
        let usedFallback = false;

        // Pha 1: selector người dùng — ưu tiên container cha bọc trọn nội dung
        for (const sel of userSelectors) {
            if (!sel) continue;
            const safeSel = escapeSelector(sel.trim());
            try {
                const matched = $(safeSel);
                if (matched.length === 0) continue;

                if (matched.length === 1) {
                    // 1 element duy nhất — dùng luôn
                    const text = matched.text().trim();
                    if (text.length > bestLength) {
                        bestLength = text.length;
                        bestElement = matched;
                    }
                } else {
                    // Nhiều element (vd nhiều <p>) — tìm cha chung
                    // Giữ cấu trúc đoạn văn và lấy TOÀN BỘ nội dung
                    const firstEl = matched.get(0);
                    const parent = firstEl.parent;
                    if (parent) {
                        const parentText = $(parent).text().trim();
                        // Chỉ dùng cha nếu không to quá (không phải container cấp trang)
                        const matchedTotal = matched.toArray().reduce((sum, el) => sum + $(el).text().trim().length, 0);
                        if (parentText.length < matchedTotal * 2.5) {
                            // Cha bọc khít các element khớp — dùng cha
                            if (parentText.length > bestLength) {
                                bestLength = parentText.length;
                                bestElement = $(parent);
                            }
                        } else {
                            // Cha to quá — gộp các element khớp vào wrapper ảo
                            const wrapper = $('<div></div>');
                            matched.each((_, el) => { wrapper.append($(el).clone()); });
                            const wrapperText = wrapper.text().trim();
                            if (wrapperText.length > bestLength) {
                                bestLength = wrapperText.length;
                                bestElement = wrapper;
                            }
                        }
                    }
                }
            } catch (e) { }
        }

        // Pha 2: fallback — chỉ khi selector người dùng chưa đủ
        if (bestLength < 100) {
            for (const sel of fallbackSelectors) {
                if (!sel) continue;
                const safeSel = escapeSelector(sel.trim());
                try {
                    $(safeSel).each((i, el) => {
                        const text = $(el).text().trim();
                        if (text.length > bestLength) {
                            bestLength = text.length;
                            bestElement = $(el);
                            usedFallback = true;
                        }
                    });
                } catch (e) { }
            }
        }

        if (bestElement && bestLength >= 50) {
            // Clone để trích text có cấu trúc
            const clonedElement = bestElement.clone();

            // Xóa quảng cáo/nhiễu bên trong vùng nội dung
            clonedElement.find('.ads, .advertisement, .ad-banner, .banner, [class*="advert"], [id*="advert"], [class*="sponsor"], .related-post, .share, .social-sharing, .comments').remove();

            clonedElement.find('br').replaceWith('\n');
            clonedElement.find('p, div, h1, h2, h3, h4, h5, h6, li, blockquote').each((_, el) => {
                $(el).prepend('\n').append('\n');
            });
            clonedElement.find('li').prepend('• ');

            let text = clonedElement.text()
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            // Bỏ nhiễu đầu bài: dòng ngắn mở đầu (quảng cáo, branding)
            // vd "Fresh AI" theo sau là nhiều dòng trống
            const lines = text.split('\n');
            let startIdx = 0;
            for (let i = 0; i < Math.min(lines.length, 10); i++) {
                const line = lines[i].trim();
                // Bỏ dòng trống và branding rất ngắn (dưới 30 ký tự)
                if (line.length === 0 || (line.length < 30 && !/[.!?。]/.test(line))) {
                    startIdx = i + 1;
                } else {
                    break;
                }
            }
            if (startIdx > 0) {
                text = lines.slice(startIdx).join('\n').trim();
            }

            // Bóc ngày — meta trước (tin cậy nhất)
            let detectedDate = null;
            const metaDateSelectors = [
                'meta[property="article:published_time"]',
                'meta[property="og:article:published_time"]',
                'meta[name="date"]',
                'meta[name="publish-date"]',
                'meta[name="publication_date"]',
                'meta[name="article:published"]',
                'meta[itemprop="datePublished"]',
                'meta[name="cXenseParse:Publishtime"]',
                'meta[name="publish_time"]',
                'meta[name="DC.date"]',
                'meta[name="dc.date"]'
            ];

            for (const sel of metaDateSelectors) {
                const content = $(sel).attr('content');
                if (content && content.length > 4) {
                    detectedDate = content;
                    console.log(`[website] Deep crawl: ngày từ meta "${sel}": ${detectedDate}`);
                    break;
                }
            }

            // JSON-LD structured data
            if (!detectedDate) {
                $('script[type="application/ld+json"]').each((_, script) => {
                    if (detectedDate) return;
                    try {
                        const json = JSON.parse($(script).html() || '{}');
                        const datePublished = json.datePublished ||
                                            json.dateCreated ||
                                            (json['@type'] === 'NewsArticle' && json.datePublished);
                        if (datePublished) {
                            detectedDate = datePublished;
                            console.log(`[website] Deep crawl: ngày từ JSON-LD: ${detectedDate}`);
                        }
                    } catch (e) { }
                });
            }

            // Selector ngày trong HTML
            if (!detectedDate) {
                const dateSelectors = [
                    'time[datetime]', 'time[pubdate]', 'time',
                    '.date', '.publish-date', '.post-date', '.published-date',
                    '[datetime]', '.article-date', '.entry-date', '.meta-date',
                    '.post__date', '.article__date', '.news-date', '.story-date',
                    'span.date', 'span.time', '.timestamp', '.post-time',
                    '[class*="date"]', '[class*="time"]', '[class*="published"]'
                ];

                for (const ds of dateSelectors) {
                    const dateEl = $(ds).first();
                    if (dateEl.length) {
                        const dt = dateEl.attr('datetime') ||
                                   dateEl.attr('content') ||
                                   dateEl.attr('data-date') ||
                                   dateEl.attr('data-pubdate') ||
                                   dateEl.text().trim();
                        if (dt && dt.length > 4 && dt.length < 100) {
                            detectedDate = dt;
                            console.log(`[website] Deep crawl: ngày từ "${ds}": ${detectedDate}`);
                            break;
                        }
                    }
                }
            }

            // Tìm ngày trong nội dung chữ (site không có element ngày đúng chuẩn)
            if (!detectedDate) {
                const datePatterns = [
                    // ISO: 2024-03-12T10:30:00
                    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
                    // DD/MM/YYYY hoặc DD-MM-YYYY
                    /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/,
                    // Month DD, YYYY (March 12, 2024)
                    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
                    // DD Month YYYY (12 March 2024)
                    /\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i,
                    // Khmer: ១២ មីនា ២០២៤
                    /[០-៩]{1,2}\s+[ក-អ]+\s+[០-៩]{4}/,
                    // Thái: 12 มีนาคม 2567
                    /\d{1,2}\s+[ก-ฮ]+\s+\d{4}/
                ];

                const textToSearch = bestElement.text().slice(0, 2000);
                // Quét cả element cha và body (khi bestElement chỉ là 1 mục con)
                const parentText = bestElement.parent().text().slice(0, 3000);
                const pageText = $('body').text().slice(0, 5000);
                const searchTargets = [textToSearch, parentText, pageText];

                for (const target of searchTargets) {
                    for (const pattern of datePatterns) {
                        const match = target.match(pattern);
                        if (match) {
                            detectedDate = match[0];
                            console.log(`[website] Deep crawl: ngày từ pattern: ${detectedDate}`);
                            break;
                        }
                    }
                    if (detectedDate) break;
                }
            }

            const publishedDate = detectedDateToDate(detectedDate);
            if (usedFallback) {
                console.log(`[website] Deep crawl: dùng selector fallback cho ${url}`);
            }
            console.log(`[website] Deep crawl: trích ${text.length} ký tự từ ${url}`);

            return { text, publishedDate: publishedDate && !isNaN(publishedDate.getTime()) ? publishedDate : null };
        }

        // Fallback: text body
        const body = $('body');
        body.find('script, style').remove();
        const bodyText = body.text().replace(/\s+/g, ' ').trim().slice(0, 10000);
        if (bodyText.length >= 100) {
            return { text: bodyText, publishedDate: null };
        }

        return null;
    } catch (error) {
        // Deep crawl hỏng không làm sập lượt chạy — trả null, item giữ nội dung danh sách
        console.warn(`[website] Deep crawl thất bại ${url}: ${error.message}`);
        return null;
    }
};

/**
 * Điểm vào hợp đồng cho runScan — quét 1 nguồn website.
 *
 * @param {object} source doc Firestore tenants/{t}/sources/{id}
 *   ({ id, name, type:'website', url, selector?, date_selector?, ... })
 * @returns {Promise<{items: Array, debug: object, lastError: object|null}>}
 *   items: ITEM CHUẨN HỢP ĐỒNG {text, title|null, url, images[], published ISO|null}
 *   lastError: {type, message, timestamp} theo schema 2.2.3 hoặc null.
 *   NGOẠI LỆ: NeedsBrowserError (nguồn SPA) — re-throw để runScan ghi
 *   scan_state.lastError {type:'needs_browser'} đúng thiết kế 5.3 bước 3.
 *   Một nguồn hỏng KHÔNG làm sập lượt chạy: mọi lỗi khác thành lastError.
 */
const collectWebsite = async (source) => {
    const url = (source && source.url) || '';
    const debug = { url, source_id: (source && source.id) || null };

    if (!url) {
        return {
            items: [],
            debug,
            lastError: { type: 'error', message: 'Nguồn website thiếu URL', timestamp: new Date().toISOString() }
        };
    }

    try {
        const selector = source.selector || 'article';
        const dateSelector = source.date_selector || '';
        const result = await collectFromWebsite(url, selector, dateSelector);
        return { items: result.items, debug: result.debug, lastError: null };
    } catch (err) {
        // SPA → để runScan xử lý (thiết kế: throw NeedsBrowserError → needs_browser)
        if (err instanceof NeedsBrowserError) throw err;

        // Lỗi tải/parsing → lastError, không sập lượt chạy
        const message = err && err.message ? err.message : 'Lỗi không xác định khi quét website';
        let type = 'error';
        if (err && err.code === 'ECONNABORTED') type = 'scan_error';
        else if (err && (err.response || err.request)) type = 'scan_error';
        console.error(`[website] Nguồn hỏng (${url}): ${message}`);
        return { items: [], debug, lastError: { type, message, timestamp: new Date().toISOString() } };
    }
};

module.exports = { collectWebsite, fetchFullContent, NeedsBrowserError };

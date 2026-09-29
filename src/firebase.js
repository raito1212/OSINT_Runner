'use strict';

// ============================================================
// src/firebase.js — CỔNG FIRESTORE DUY NHẤT của runner
// Không file nào khác trong repo được require('firebase-admin') trực tiếp.
// Mọi đường dẫn đều ép prefix tenants/{tenantId}/ qua tpath() nội bộ +
// assertTenantId() phòng thủ sâu (scan.js đã validate — đây là lớp 2, mục 2.6).
//
// Đường dẫn & schema theo KE_HOACH_LAM_LAI_ONLINE_FREE.md mục 2 (GHI ĐÈ
// thiet-ke-runner.md mục 6):
//   tenants/{t}/settings/main      — geminiKey, geminiModel, githubPat, githubOwner,
//                                    githubRepo, dispatchToken, ttlDays (2.2.4)
//   tenants/{t}/ai_rules/main      — promptTemplate (quy tắc thuần, KHÔNG biến {{...}})
//   tenants/{t}/dictionary/{id}    — {from: EN, to: VN} — glossary prompt
//   tenants/{t}/sources/{id}       — query active == true (field `active` —
//                                    trùng schema web SourceManager + agent)
//   tenants/{t}/posts/{postId}     — schema FLAT 2.2, upsert MERGE (chỉ giữ 'done')
//   tenants/{t}/scan_state/{srcId} — schema 2.2.3 (seen mảng {h|u,t} cap 200/100)
//   tenants/{t}/scan_state/_last_run — tóm tắt lượt chạy
//
// TUYỆT ĐỐI KHÔNG log nội dung service account / geminiKey / dispatchToken.
// ============================================================

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const {
    TTL_DEFAULT_DAYS,
    SEEN_PRUNE_DAYS,
    SEEN_HASH_CAP,
    SEEN_URL_CAP,
    DICTIONARY_READ_CAP,
} = require('./config');

let db = null;        // instance Firestore — KHÔNG export ra ngoài module
let Timestamp = null; // admin.firestore.Timestamp — KHÔNG export

// Regex tenantId trùng validate của scan.js (thiet-ke-runner.md mục 5.2):
// 4–64 ký tự [a-zA-Z0-9_-], ký tự đầu là chữ/số — doc id Firestore không chứa '/'.
const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{3,63}$/;

// Doc id an toàn cho path (postId chuẩn 2.1 luôn là web_<md5hex> / fb_<sanitized>).
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Field đã BỎ khỏi schema chuẩn 2.2 (GHI ĐÈ 4: CẤM ghi) — strip trước khi ghi.
// Đối chiếu DROPPED_FIELDS trong web/src/utils/postsFirestore.js.
const DROPPED_POST_FIELDS = [
    'metadata', 'isProcessed', 'ai_processed', 'user_id',
    'saved_at', 'scanned_by', 'run_id', 'collectedBy', 'id',
];

// Khi MERGE bài tồn tại: bản mới rỗng field nào thì giữ field cũ (GHI ĐÈ 5) —
// dịch + AI enrich + ảnh: quét lại không được xóa công sức đã có.
// Giống hệt KEEP_IF_EMPTY trong web/src/utils/postsFirestore.js (dòng ~100–104).
const KEEP_IF_EMPTY = [
    'translated_en', 'translated_vi',
    'summary', 'labels', 'priority', 'reason', 'ai_model', 'ai_used',
    'title', 'author', 'timestamp', 'detected_language', 'images',
];

// ------------------------- Khởi tạo -------------------------

/**
 * Khởi tạo firebase-admin đúng 1 lần (flag module).
 * Ưu tiên FIREBASE_SERVICE_ACCOUNT (chuỗi JSON inline — GitHub secret);
 * nếu rỗng thì đọc FIREBASE_SERVICE_ACCOUNT_FILE (đường dẫn file — local debug).
 * Pattern init: OSINT_Web/agent/src/utils/db.js — db.settings({ignoreUndefinedProperties:true}).
 * Không bao giờ log nội dung key.
 */
function initFirebase() {
    if (db) return; // đã init rồi — bỏ qua

    const inline = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
    const file = String(process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '').trim();
    let raw;
    if (inline) {
        raw = inline;
    } else if (file) {
        const filePath = path.resolve(file);
        try {
            raw = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                throw new Error(
                    `[firebase] Chưa có file key tại ${filePath} — local dry-run cần file này: `
                    + 'Firebase Console → Project settings → Service accounts → Generate new private key, '
                    + 'lưu đè lên đường dẫn trên (file đã bị .gitignore loại khỏi commit). '
                    + 'Xem .env.example'
                );
            }
            throw e;
        }
    } else {
        throw new Error('[firebase] Thiếu FIREBASE_SERVICE_ACCOUNT (JSON inline) hoặc FIREBASE_SERVICE_ACCOUNT_FILE (đường dẫn file) — xem .env.example');
    }

    let account;
    try {
        account = JSON.parse(raw);
    } catch (e) {
        // KHÔNG kèm nội dung file/key vào thông báo lỗi
        throw new Error('[firebase] Service account không phải JSON hợp lệ — kiểm tra lại secret/file');
    }

    admin.initializeApp({ credential: admin.credential.cert(account) });
    db = admin.firestore();
    Timestamp = admin.firestore.Timestamp;
    db.settings({ ignoreUndefinedProperties: true });
    console.log('[firebase] Đã khởi tạo Firestore (service account hợp lệ)');
}

function requireDb() {
    if (!db) throw new Error('[firebase] Phải gọi initFirebase() trước khi truy cập Firestore');
    return db;
}

// ------------------------- Ép tenant path -------------------------

// Phòng thủ sâu: tenantId đã được scan.js validate — đây là lớp chặn cuối
// trước khi build đường dẫn (SA Admin SDK bypass rules, mục 2.6).
function assertTenantId(tenantId) {
    if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
        throw new Error(`[firebase] tenantId không hợp lệ: "${tenantId}" — chặn ghi ngoài tenants/`);
    }
}

// MỌI đường dẫn Firestore trong module đều build qua đây — ép prefix tenants/{t}/.
function tpath(tenantId, ...parts) {
    assertTenantId(tenantId);
    return 'tenants/' + tenantId + '/' + parts.join('/');
}

// ------------------------- Đọc cấu hình tenant -------------------------

/** tenants/{t}/settings/main (2.2.4) — doc chưa tồn tại trả {} để caller check mềm.
 *  Lưu ý: githubPat chỉ web dùng — runner KHÔNG đọc/triển khai nó (GHI ĐÈ 2);
 *  dispatchToken do runScan so với env DISPATCH_TOKEN, không thực hiện ở module này. */
async function readSettings(tenantId) {
    const snap = await requireDb().doc(tpath(tenantId, 'settings', 'main')).get();
    return snap.exists ? snap.data() : {};
}

/** tenants/{t}/ai_rules/main — {promptTemplate: văn bản quy tắc thuần, KHÔNG biến {{...}}}. */
async function readAiRules(tenantId) {
    const snap = await requireDb().doc(tpath(tenantId, 'ai_rules', 'main')).get();
    return snap.exists ? snap.data() : {};
}

/** Toàn bộ cặp từ điển {from: EN, to: VN} làm glossary — cap DICTIONARY_READ_CAP. */
async function readDictionary(tenantId, cap) {
    const limitN = Number.isFinite(Number(cap)) && Number(cap) > 0
        ? Math.floor(Number(cap)) : DICTIONARY_READ_CAP;
    const snap = await requireDb().collection(tpath(tenantId, 'dictionary')).limit(limitN).get();
    return snap.docs.map((d) => d.data());
}

/** Mọi nguồn đang bật (active == true) — kèm id doc; lọc theo type là việc runScan.
 *  Field `active` theo schema web (firestore.js addSource/import) + agent — KHÔNG phải `is_active`. */
async function listActiveSources(tenantId) {
    const snap = await requireDb()
        .collection(tpath(tenantId, 'sources'))
        .where('active', '==', true)
        .get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

/** Đọc TOÀN collection scan_state 1 lần → {[sourceId]: data} (kèm khóa _last_run). */
async function getScanStates(tenantId) {
    const snap = await requireDb().collection(tpath(tenantId, 'scan_state')).get();
    const out = {};
    snap.forEach((d) => { out[d.id] = d.data(); });
    return out;
}

// ------------------------- TTL -------------------------

// expiresAt = now + ttlDays ngày (tối thiểu 1 ngày) — Timestamp bắt buộc cho
// TTL policy (2.7). Đối chiếu makeExpiry trong web/src/utils/postsFirestore.js (~dòng 78).
function makeExpiry(ttlDays) {
    const n = Number.isFinite(Number(ttlDays)) ? Number(ttlDays) : TTL_DEFAULT_DAYS;
    return Timestamp.fromMillis(Date.now() + Math.max(1, n) * 86400000);
}

// Chỉ tiến không lùi: giữ Timestamp LỚN HƠN giữa hiện có và makeExpiry(ttlDays)
// — quét lại = gia hạn TTL, không bao giờ co ngắn. Đối chiếu maxExpiry
// trong web/src/utils/postsFirestore.js (~dòng 85).
function maxExpiry(currentExpiresAt, ttlDays) {
    const next = makeExpiry(ttlDays);
    const cur = (currentExpiresAt && typeof currentExpiresAt.toMillis === 'function')
        ? currentExpiresAt.toMillis() : NaN;
    return Number.isFinite(cur) && cur > next.toMillis() ? currentExpiresAt : next;
}

// ------------------------- Ghi posts -------------------------

/**
 * Ghi danh sách bài theo upsert MERGE — KHÔNG skip (GHI ĐÈ 4/5, KE_HOACH 2.2):
 * - doc id = post.post_id (runner đã tính sẵn theo 2.1: web_<md5(normalizeUrl(url))>;
 *   norm_hash/content_hash cũng đã tính sẵn — module này KHÔNG tính lại, chỉ ghi);
 * - doc tồn tại: KEEP_IF_EMPTY giữ giá trị cũ khi bản mới rỗng; giữ
 *   processingStatus == 'done' + processed_by/processed_at (CHỈ 'done'); giữ
 *   collected_at/created_at cũ; expiresAt LUÔN refresh = max(cũ, now + ttlDays);
 * - một bài hỏng (thiếu/sai post_id) bị bỏ qua + cảnh báo, KHÔNG làm sập lượt chạy.
 * Trả { inserted, updated }. Merge semantics đối chiếu upsertPostsBatch trong
 * web/src/utils/postsFirestore.js (~dòng 130–239) — viết lại CommonJS, không copy ESM.
 */
async function writePosts(tenantId, posts, ttlDays) {
    const database = requireDb();
    assertTenantId(tenantId);
    const list = (Array.isArray(posts) ? posts : []).filter((p) => p && typeof p === 'object');
    if (!list.length) return { inserted: 0, updated: 0 };

    let inserted = 0;
    let updated = 0;
    const nowIso = new Date().toISOString();

    for (const post of list) {
        const postId = String(post.post_id || '').trim();
        if (!DOC_ID_RE.test(postId)) {
            // Bài sai định dạng id (thiếu post_id / chứa ký tự lạ) — bỏ, không sập lượt chạy
            console.warn('[firebase] Bỏ qua bài thiếu/sai post_id (runner phải tính theo mục 2.1)');
            continue;
        }
        const ref = database.doc(tpath(tenantId, 'posts', postId));
        const snap = await ref.get();
        const existing = snap.exists ? snap.data() : null;

        const data = { ...post };
        DROPPED_POST_FIELDS.forEach((f) => delete data[f]);

        // text + raw_text đều là nội dung gốc (GHI ĐÈ 4) — bảo đảm đủ cả 2 trường
        data.raw_text = data.raw_text ?? data.text ?? '';
        data.text = data.text ?? data.raw_text ?? '';
        if (!data.norm_hash || !data.content_hash) {
            console.warn(`[firebase] Bài ${postId} thiếu norm_hash/content_hash (runner phải tính sẵn theo 2.1)`);
        }

        // Chuẩn hóa field nullable theo schema FLAT 2.2
        data.title = data.title ?? null;
        data.url = data.url ?? null;
        data.timestamp = data.timestamp ?? null; // ISO từ nguồn — pass-through, không tự +7h
        data.images = Array.isArray(data.images) ? data.images : [];
        data.author = data.author ?? null;
        data.detected_language = data.detected_language ?? null;
        data.translated_en = data.translated_en ?? null; // runner để null
        data.translated_vi = data.translated_vi ?? null;
        data.summary = data.summary ?? null;
        data.labels = data.labels ?? null;
        data.priority = data.priority ?? null;
        data.reason = data.reason ?? null;
        data.ai_model = data.ai_model ?? null;
        data.ai_used = data.ai_used ?? null; // 'gemini' | 'fallback-gtx' | null
        data.source_id = data.source_id ?? null;
        data.source_name = data.source_name ?? null;
        data.source_url = data.source_url ?? null;
        data.platform = data.platform ?? null; // = type nguồn
        data.processed_by = data.processed_by ?? null;
        data.processed_at = data.processed_at ?? null;
        data.processingStatus = data.processingStatus || 'new';
        data.collected_via = data.collected_via || 'runner';
        data.post_id = postId;
        data.updated_at = nowIso;

        if (existing) {
            // Bản mới rỗng field nào thì giữ field cũ (dịch/AI/ảnh đã có công sức)
            KEEP_IF_EMPTY.forEach((f) => {
                const nv = data[f];
                const ov = existing[f];
                const newEmpty = nv == null || (Array.isArray(nv) && nv.length === 0);
                const oldHas = ov != null && !(Array.isArray(ov) && ov.length === 0);
                if (newEmpty && oldHas) data[f] = ov;
            });
            if (existing.processingStatus === 'done') {
                // KHÔNG reset bài Hoàn thành (CHỈ 'done' — không còn saved/archived)
                data.processingStatus = 'done';
                data.processed_by = existing.processed_by ?? null;
                data.processed_at = existing.processed_at ?? null;
            }
            data.collected_at = existing.collected_at || data.collected_at || nowIso; // mốc thu lần đầu
            data.created_at = existing.created_at || nowIso;
            data.expiresAt = maxExpiry(existing.expiresAt, ttlDays); // chỉ tiến không lùi
            updated += 1;
        } else {
            data.collected_at = data.collected_at || nowIso;
            data.created_at = nowIso;
            data.expiresAt = makeExpiry(ttlDays);
            inserted += 1;
        }
        await ref.set(data, { merge: true });
    }
    console.log(`[firebase] Ghi ${list.length} bài: ${inserted} mới, ${updated} cập nhật`);
    return { inserted, updated };
}

// ------------------------- scan_state -------------------------

// Chuẩn hoá mảng seen về dạng [{h|u, t}] — chấp nhận phần tử chuỗi trần
// (bọc thêm t = now). Đối chiếu toSeenEntries trong web/src/utils/postsFirestore.js (~dòng 508).
function toSeenEntries(list, keyField) {
    return (Array.isArray(list) ? list : []).map((e) => (
        (e && typeof e === 'object') ? e : { [keyField]: e, t: new Date().toISOString() }
    ));
}

// Union theo key duy nhất + bỏ mục cũ hơn SEEN_PRUNE_DAYS ngày + giữ `cap` mục
// mới nhất theo t. Port mergeSeen trong web/src/utils/postsFirestore.js (~dòng 487–506).
function mergeSeen(existingList, addList, keyField, cap) {
    const cutoff = Date.now() - SEEN_PRUNE_DAYS * 86400000;
    const byKey = new Map();
    const consider = (entry) => {
        if (!entry || entry[keyField] == null) return;
        const prev = byKey.get(entry[keyField]);
        if (!prev || String(entry.t || '') >= String(prev.t || '')) byKey.set(entry[keyField], entry);
    };
    (Array.isArray(existingList) ? existingList : []).forEach(consider);
    (Array.isArray(addList) ? addList : []).forEach(consider);
    let list = [...byKey.values()].filter((e) => {
        const t = Date.parse(e.t);
        return Number.isFinite(t) && t >= cutoff;
    });
    if (list.length > cap) {
        list.sort((a, b) => Date.parse(b.t || '') - Date.parse(a.t || ''));
        list = list.slice(0, cap);
    }
    return list;
}

/**
 * Cập nhật scan_state/{sourceId} theo patch — semantics read-merge-write như
 * OSINT_Web/agent/src/services/sourceScanState.js::patchState (dòng 16–28) cộng
 * guard của applyScanStateUpdates trong web/src/utils/postsFirestore.js (~dòng 515–554):
 * - anchor_* null trong patch → KHÔNG đè giá trị cũ (bỏ field khỏi patch, 2.2.3);
 * - anchor_timestamp mới ≤ hiện có → bỏ CẢ CỤM anchor_* (anchor chỉ tiến);
 * - seen_hashes/seen_urls union theo key h/u + prune > 7 ngày + cap 200/100;
 * - patch có lastScanTime mà KHÔNG có lastError → lastError = null (dọn cờ lỗi);
 * - luôn ghi updated_at. Ghi bằng set merge.
 */
async function applyScanState(tenantId, sourceId, patch) {
    const database = requireDb();
    if (typeof sourceId !== 'string' || !DOC_ID_RE.test(sourceId)) {
        throw new Error('[firebase] sourceId không hợp lệ (chỉ [A-Za-z0-9_-], tối đa 128 ký tự)');
    }
    const ref = database.doc(tpath(tenantId, 'scan_state', sourceId));
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : {};

    const p = { ...(patch || {}) };

    // Tách mảng seen khỏi patch để union riêng — KHÔNG ghi đè mất danh sách cũ
    const addHashes = toSeenEntries(p.seen_hashes, 'h');
    delete p.seen_hashes;
    const addUrls = toSeenEntries(p.seen_urls, 'u');
    delete p.seen_urls;

    // anchor_* null → bỏ field, giữ nguyên giá trị cũ trong doc
    Object.keys(p).forEach((k) => {
        if (k.startsWith('anchor_') && p[k] == null) delete p[k];
    });
    // GUARD chỉ tiến: anchor mới KHÔNG mới hơn anchor hiện có → bỏ cả cụm anchor_*
    if (p.anchor_timestamp && existing.anchor_timestamp
        && String(p.anchor_timestamp) <= String(existing.anchor_timestamp)) {
        Object.keys(p).forEach((k) => { if (k.startsWith('anchor_')) delete p[k]; });
    }
    // Có lastScanTime mà không có lastError → quét thành công → dọn cờ lỗi cũ
    if ('lastScanTime' in p && !('lastError' in p)) p.lastError = null;

    await ref.set({
        ...p,
        source_id: existing.source_id || sourceId,
        seen_hashes: mergeSeen(existing.seen_hashes, addHashes, 'h', SEEN_HASH_CAP),
        seen_urls: mergeSeen(existing.seen_urls, addUrls, 'u', SEEN_URL_CAP),
        updated_at: new Date().toISOString(),
    }, { merge: true });
}

// ------------------------- Tóm tắt lượt chạy -------------------------

/** Ghi tenants/{t}/scan_state/_last_run = {run_id, started_at, finished_at,
 *  totals, per_source, duration_s} — set thay thế, mỗi lượt chỉ giữ bản mới nhất. */
async function writeLastRun(tenantId, summary) {
    const database = requireDb();
    assertTenantId(tenantId);
    await database.doc(tpath(tenantId, 'scan_state', '_last_run')).set(summary || {});
}

// Chỉ export hàm hợp đồng — KHÔNG export raw db/admin/Timestamp.
module.exports = {
    initFirebase,
    readSettings,
    readAiRules,
    readDictionary,
    listActiveSources,
    getScanStates,
    writePosts,
    applyScanState,
    writeLastRun,
};

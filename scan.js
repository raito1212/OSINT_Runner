/**
 * scan.js — điểm vào của runner (port thiet-ke-runner.md mục 5.2 + GHI ĐÈ 2.6 của
 * plans/KE_HOACH_LAM_LAI_ONLINE_FREE.md; tinh thần --dry-run của AutoCollectingNews/main.py dòng 36-37).
 *
 * Trách nhiệm DUY NHẤT: đọc env + cờ --dry-run → validate → gọi src/runScan.runScan() → exit code.
 * KHÔNG require firebase-admin tại đây (chỉ src/firebase.js được require — xem README).
 *
 * Chạy local:  node --env-file=.env scan.js --dry-run
 * Trên GitHub Actions: env do scan.yml truyền vào.
 */
'use strict';

// Đọc toàn bộ input từ env + argv. dryRun bật khi DRY_RUN==='true' HOẶC có cờ --dry-run
// (cờ CLI tiện cho lần thử local nhanh không cần sửa .env).
function parseInputs() {
  const argv = process.argv.slice(2);
  return {
    tenantId: (process.env.TENANT_ID || '').trim(),
    sourceIds: (process.env.SOURCE_IDS || '"all"').trim(),
    lastHours: (process.env.LAST_HOURS || '26').trim(),
    dispatchToken: process.env.DISPATCH_TOKEN || '',
    dryRun: process.env.DRY_RUN === 'true' || argv.includes('--dry-run'),
  };
}

// Firestore doc id không chứa "/": ký tự đầu là chữ/số, tổng 4-64 ký tự [a-zA-Z0-9_-].
function validateTenantId(t) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{3,63}$/.test(t);
}

// '"all"' (chuỗi có nháy như workflow truyền) hoặc 'all' (dotenv .env bóc nháy) → quét mọi nguồn;
// ngược lại phải là JSON array chuỗi, 1-50 phần tử, mỗi id khớp ^[a-zA-Z0-9_-]{1,64}$.
// Trả về 'all' | string[] | null (null = sai định dạng).
function parseSourceIds(s) {
  if (s === '"all"' || s === 'all') return 'all';
  try {
    const arr = JSON.parse(s);
    if (
      Array.isArray(arr) && arr.length >= 1 && arr.length <= 50 &&
      arr.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id))
    ) {
      return arr;
    }
  } catch (_) {
    // JSON hỏng → rơi xuống trả null bên dưới
  }
  return null;
}

// Số nguyên 1-336 giờ (336 = 2 tuần — đủ rộng cho mọi cửa sổ nhìn lại thực tế).
// Trả số hoặc null.
function parseLastHours(s) {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 336 ? n : null;
}

function main() {
  const inputs = parseInputs();
  if (!validateTenantId(inputs.tenantId)) {
    console.error('[INPUT] tenantId không hợp lệ (phải khớp ^[a-zA-Z0-9][a-zA-Z0-9_-]{3,63}$, không chứa "/")');
    process.exit(2);
  }
  const sourceIds = parseSourceIds(inputs.sourceIds);
  if (!sourceIds) {
    console.error('[INPUT] sourceIds không hợp lệ: phải là "all" hoặc JSON array 1-50 id, mỗi id khớp ^[a-zA-Z0-9_-]{1,64}$');
    process.exit(2);
  }
  const lastHours = parseLastHours(inputs.lastHours);
  if (!lastHours) {
    console.error('[INPUT] lastHours không hợp lệ: phải là số nguyên 1-336');
    process.exit(2);
  }

  // Require SAU khi validate để input xấu thoát ngay không chạm module nặng.
  const { runScan } = require('./src/runScan');
  runScan({
    tenantId: inputs.tenantId,
    sourceIds, // 'all' | string[]
    lastHours,
    dryRun: inputs.dryRun,
    dispatchToken: inputs.dispatchToken,
  })
    .then((summary) => {
      // Chạy xong — KỂ CẢ 0 bài mới — vẫn là thành công (exit 0).
      console.log('[SCAN] Hoàn tất:', typeof summary === 'string' ? summary : 'xong');
      process.exit(0);
    })
    .catch((err) => {
      // runScan ném {exitCode: 2} cho token sai / tenant bị khóa runner — phân biệt với lỗi hệ thống.
      if (err && err.exitCode === 2) {
        console.error('[SCAN] Từ chối chạy:', err.message || 'điều kiện tiền kiểm tra không đạt');
        process.exit(2);
      }
      console.error('[SCAN] Lỗi chạy quét:', err && err.message ? err.message : err);
      process.exit(1);
    });
}

main();

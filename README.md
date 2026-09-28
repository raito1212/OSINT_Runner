# OSINT Runner

Runner quét nguồn OSINT **HTTP-thuần** (`rss` / `gnews` / `telegram` / `website`) chạy on-demand trên **GitHub Actions** (chỉ `workflow_dispatch`, KHÔNG cron). Mỗi lượt chạy: đọc cấu hình + nguồn + từ điển của tenant trên Firestore → quét → lọc quy tắc thuần → dịch/phân tích Gemini (fallback Google-gtx) → ghi bài tạm (`posts`, TTL) + trạng thái quét (`scan_state`) về đúng `tenants/{tenantId}/...`.

Nguồn cần trình duyệt (`facebook` / `twitter` / `social_generic`) là việc của **agent trên máy user** — runner không có browser (không puppeteer).

## Input của lượt quét (workflow_dispatch)

| Input | Bắt buộc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `tenantId` | có | — | ID tenant — mọi đường dẫn Firestore ép vào `tenants/{tenantId}/` |
| `sourceIds` | không | `"all"` | `"all"` = mọi nguồn HTTP-thuần active; hoặc JSON array id, vd `["s1","s2"]` (tối đa 50) |
| `lastHours` | không | `"26"` | Cửa sổ thời gian nhìn lại (1–336 giờ) |
| `dryRun` (boolean) | không | `false` | `true` = chỉ quét + in ứng viên: **bỏ kiểm tra token, không ghi Firestore, không gọi Gemini** |
| `dispatchToken` | có | — | Chống dispatch chéo tenant: runner so với `settings.dispatchToken` của tenant đích → sai/rỗng → exit 2 |

## Chạy thử local (dry-run)

```bash
npm ci
# copy .env.example thành .env, sửa TENANT_ID/SOURCE_IDS; đặt serviceAccount.json cạnh repo
node --env-file=.env scan.js --dry-run
```

Dry-run đọc local (settings/sources/scan_state) để in ứng viên — không ghi gì, không tốn quota Gemini. Local dry-run **không cần** `DISPATCH_TOKEN`.

## Dispatch từ GitHub

```bash
gh workflow run scan.yml \
  -f tenantId=tenant-demo \
  -f sourceIds='["s1"]' \
  -f dryRun=true \
  -f dispatchToken=<token đã sinh ở trang Cài đặt nhóm>
```

Web app (nút Quét) tự dispatch bằng PAT với đúng bộ input này — không gửi input ngoài 5 input đã khai báo.

## Mã exit

| Exit | Ý nghĩa |
|---|---|
| `0` | Chạy xong — kể cả khi 0 bài mới |
| `1` | Lỗi cấu hình / kết nối Firebase / lỗi hệ thống |
| `2` | Input xấu (tenantId/sourceIds/lastHours sai định dạng) **hoặc** dispatchToken sai/thiếu |

## Runbook deploy (làm 1 lần)

> Đầy đủ ở `OSINT_Web/plans/chitiet/thiet-ke-runner.md` mục 9 — tóm tắt thao tác Console:

1. **Tạo Service Account** `osint-runner` (GCP Console → IAM & Admin → Service Accounts). **KHÔNG gán role project** — đặc biệt không dùng nút "Create service account" của Firebase Console vì nó gán Editor.
2. **Tạo custom role** IAM → Roles → Create role `OSINTRunnerFirestore` với **đúng 4 permission**:
   ```
   datastore.entities.get   datastore.entities.list
   datastore.entities.create  datastore.entities.update
   ```
   **KHÔNG có `datastore.entities.delete`** — runner không bao giờ xóa; TTL policy lo dọn bài hết hạn. Không role admin/index.
3. **Grant** role đó cho SA (IAM → Grant access). *(Nếu client library đòi thêm khi chạy thật: bổ sung `serviceusage.services.use` — chỉ thêm khi có lỗi.)*
4. **Key JSON**: SA → Keys → Add key → JSON.
5. **GitHub secret**: repo Settings → Secrets and variables → Actions → `FIREBASE_SERVICE_ACCOUNT` = toàn bộ chuỗi JSON key. Đây là **secret duy nhất** của repo — key Gemini nằm trong `settings` doc trên Firestore (admin dán qua web), không đặt ở đây.
6. **PAT fine-grained** (để WEB dispatch): chỉ select đúng repo runner này, permission **Actions: Read and write** — dán vào trang `/tenant-settings` của web app (Firestore settings). **KHÔNG đặt PAT ở repo này.**
7. Push repo lên GitHub (private), tạo TTL policy `posts.expiresAt` theo runbook P0, rồi dispatch dry-run để nghiệm thu.

## Lưu ý kỹ thuật quan trọng

- **Chỉ `src/firebase.js` được require `firebase-admin`** — mọi truy cập Firestore đi qua đúng 1 module, ép prefix `tenants/{tenantId}/` + validate input regex. Review checklist: không file nào khác được thêm `require('firebase-admin')`.
- **TTL**: `expiresAt` bắt buộc là **Firestore Timestamp** (string ISO = doc không bao giờ tự xóa). TTL xóa best-effort **trễ tối đa ~24h**, nên mọi query phía web **luôn** kèm `where('expiresAt', '>', now)`; ghi lại `expiresAt` tương lai = gia hạn bài (cơ chế hủy xóa treo).
- State quét nằm trên Firestore (`scan_state`), **không commit lại git** — workflow chỉ cần `permissions: contents: read`.
- Concurrency theo tenant (`scan-${tenantId}`, không cancel) — 2 tenant chạy song song, cùng tenant xếp hàng.
- Timeout 10 phút/run; repo private Free = 2000 phút Actions/tháng, on-demand nên dư giáp.

## Cấu trúc repo

```
.github/workflows/scan.yml   # workflow duy nhất (workflow_dispatch, 5 input)
scan.js                      # entry: parse env + validate + exit code
package.json / package-lock.json   # lock PHẢI commit (npm ci + cache: npm)
.env.example                 # bản mẫu chạy local
src/                         # orchestrator + collectors + rules + ai (xem thiết kế)
```

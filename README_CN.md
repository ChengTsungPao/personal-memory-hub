# Personal Memory Hub

**給 AI coding agent 用的私有、自架長期記憶伺服器。**

Agent 每開一個新 session 就忘光。這個專案在它旁邊跑一台記憶伺服器,讓它不用
重來:對話會被萃取成分層、可搜尋的記憶,而你用的每個 agent —— 跨編輯器、跨
CLI、跨機器 —— 讀寫的都是同一份。

設計上就是自架的。資料存在你自己跑的資料庫裡。

[安裝](#安裝) · [它做什麼](#它做什麼) · [記憶怎麼分層](#記憶怎麼分層) · [儲存後端](#儲存後端) · [開發](#開發)

---

## 它做什麼

- **記住人和脈絡** —— 偏好、限制、做過的決定以及背後的理由,帶進之後每一次對話。
- **累積技能** —— 從完成的工作裡萃取可重用的做法,不只是零散事實。
- **索引文件與程式碼** —— 文件變成可搜尋的頁面,repo 變成檔案 / 符號 / 呼叫關係的圖,需要時才查,不整包塞進 context。
- **跨 agent 共用** —— 一台記憶伺服器,多個前端。換工具不等於從頭來過。
- **人類保有控制權** —— 資產明確綁定到 agent 並有權限層,團隊可以共享經驗而不必共享全部。

## 安裝

完整部署流程(memory core、hub、proxy)見 [INSTALL.md](./INSTALL.md)。

## 記憶怎麼分層

原始對話存起來便宜、搜尋起來昂貴,所以有一條非同步管線把它逐層提煉成更粗的顆粒:

| 層 | 存什麼 | 主要用途 |
| :--- | :--- | :--- |
| **L0 Conversation** | 帶完整脈絡的原始對話 | 查證確切用字、時間戳與來源 |
| **L1 Atom** | 從對話萃取的事實、偏好、限制、事件 | 精準回想可行動的資訊 |
| **L2 Scenario** | 以專案或情境為單位組織的知識塊 | 快速還原工作脈絡 |
| **L3 Core / Persona** | 長期輪廓、穩定模式、高層認知 | 讓 agent 快速進入你的脈絡 |

檢索也是分層的。平常用 L2/L3 便宜地建立脈絡;需要具體事實時,再用 BM25 +
向量檢索 + RRF 融合回頭查 L1/L0。結果還會受筆數、字元預算、逾時三重上限約束,
避免記憶淹沒 context window。

## 儲存後端

儲存層是一個介面(`IMemoryStore`),底下是可替換的實作,由 config 的
`storeBackend` 選擇:

| 後端 | 引擎 | 說明 |
| :--- | :--- | :--- |
| `sqlite` | SQLite + `sqlite-vec` + FTS5 | 預設。零設定、單一檔案、純本地。 |
| `postgres` | PostgreSQL + `pgvector` + `tsvector` | **開發中** —— 見下方設計文件。向量、全文、關聯式共用一個引擎。 |
| `mongodb` | MongoDB | 伺服器端文字搜尋。 |
| `tcvdb` | 騰訊雲向量資料庫 | 上游帶來的廠商託管向量庫。 |

中文在寫入時就用 jieba 斷好詞、以空白接起來儲存,所以每個後端都只需要一個單純
的空白分詞器,誰都不用重新斷詞。

### Postgres 後端

這個 fork 的主線工作:讓單一 PostgreSQL 實例涵蓋整個 `IMemoryStore` 介面 ——
向量搜尋、全文搜尋、混合搜尋、profile rows —— 不必另外再跑一套向量資料庫。

- 設計:[`docs/superpowers/specs/2026-09-22-postgres-store-backend-design.md`](./docs/superpowers/specs/2026-09-22-postgres-store-backend-design.md)
- 階段 1 計畫:[`docs/superpowers/plans/2026-09-22-postgres-store-backend-phase1.md`](./docs/superpowers/plans/2026-09-22-postgres-store-backend-phase1.md)

## 開發

```bash
cd MemoryCore
npm install
npm test
```

後端測試跑真的資料庫而不是 mock —— 向量索引、全文行為、排序融合這些東西一
mock 就全失去意義。Postgres 測試用 Docker Compose 起
`pgvector/pgvector:pg17`,每次執行隔離在自己的 schema 裡。

## 相關文件

- [安裝指南](./INSTALL.md)
- [貢獻指南](./CONTRIBUTING_CN.md)
- [Roadmap](./ROADMAP_CN.md)
- API 文件:[Memory Core v3](./MemoryCore/v3-api-memorycore-doc.md) ·
  [Memory Knowledge v3](./MemoryKnowledge/v3-api-memoryknowledge-doc.md) ·
  [Memory Proxy v3](./MemoryProxy/v3-api-memoryproxy-doc.md) ·
  [Memory Panel](./MemoryPanel/panel-api-doc.md)

## 注意事項

- Wiki 與 code graph 資產是非同步建立的,要等它變成 `ready`。
- 程式碼索引以公開 HTTPS repo 為優先,私有 repo 與 SSH 憑證仍在完善中。
- 資產綁定目前是手動的,全自動記憶路由還沒做完。

## 授權

MIT,見 [LICENSE](./LICENSE)。

---

## 出處

基於 Tencent 的 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
(MIT)。本專案獨立維護,與 Tencent 無隸屬關係、亦未獲其背書。原始著作權聲明
依 MIT 條款保留於 [LICENSE](./LICENSE)。

**Fork 自** commit
[`5017e2b`](https://github.com/TencentCloud/TencentDB-Agent-Memory/commit/5017e2bb927c65bd8302af2d984b04db46303f1b)
—— `fix(memory-core): enforce caller-scoped ACL on asset/get and asset/list (#1464)`,
2026-09-21,取自上游預設分支 `feat/server_team`。

該 commit 之前的歷史不收錄在本 repo,仍保留在上游。要比對的話:

```bash
git remote add upstream https://github.com/TencentCloud/TencentDB-Agent-Memory.git
git fetch upstream
git diff 5017e2b HEAD
```

---
name: memory-hub-recall
description: "從 Personal Memory Hub 讀出某個 repo 或主題的歷史記憶（之前的決定、進度、待辦、踩過的坑）。觸發：使用者問「之前做到哪」「你記得 X 嗎」「讀一下記憶」「這個 repo 有什麼記憶」「接著上次做」，或 memory_search 回「no memory blocks for this folder's repos yet」。"
---

# Memory Hub 讀記憶

記憶分三層，都透過 `memorycore` MCP 的唯讀工具讀取（在 Claude Code 中是 deferred tool，先用
ToolSearch `select:mcp__memorycore__agent_list,mcp__memorycore__memory_search,mcp__memorycore__scenario_list,mcp__memorycore__scenario_read,mcp__memorycore__core_read` 載入）：

| 層 | 工具 | 內容 |
|---|---|---|
| L3 | `core_read` | 使用者長期的偏好與工作方式 |
| L2 | `scenario_list` → `scenario_read` | 依主題整理好的知識檔，最適合拿來了解專案全貌 |
| L1 / L0 | `memory_search` | 抽取出的記憶原子（atoms）與原始對話（conversations），用來找具體細節 |

## 為什麼一定要帶 `agent`

不帶 `agent` 時，工具只看「MCP 伺服器啟動時所在資料夾」底下的 repo。新 session、剛 clone 的 repo、
或在別的資料夾開的對話，常常會回 `no memory blocks for this folder's repos yet`，**這不代表沒有記憶**。
所以一律明確指定 repo：

1. `agent_list` 找出 repo 名稱。`kind: "repo"` 的項目代表該 repo，帶入名稱（例如 `agent: "ai-usage-monitor"`）
   會自動展開成這個 repo 底下所有 session 的記憶塊。
2. 同名但 `kind: "agent"` 的是舊版的專案記憶，用 `agent_id`（`agt-…`）另外查一次，有時更早的紀錄在那裡。
3. repo 名稱不確定時：看 Stop hook 印出的綁定（`🧠 記憶塊 … → <repo> (<hash>)`），或目前資料夾的
   git 根目錄名稱。

## 步驟

1. **全貌**：`scenario_list`（帶 `agent`）→ 讀跟問題相關的 L2 檔。
2. **細節**：`memory_search`（帶 `agent`）用 2–3 個不同的關鍵字查，例如專案名稱、元件名稱、使用者提到的詞。
   `layer: "atoms"` 先看；不夠再查 `conversations`。
3. 使用者問的是偏好或習慣時，加讀 `core_read`。
4. 記憶互相矛盾時，以較新的為準，並把矛盾告訴使用者。

## 回報格式

- 用繁體中文，依時間或主題分組，每組標出來源記憶塊與日期（例如「來自 agt-u2v18dxvq7，10/26–10/31」）。
- 只寫記憶裡實際有的內容，不要補推測。檔名、指令、port、commit hash 等照原文保留。
- 明確提醒：記憶反映的是當時的狀態。要依據記憶動手改程式之前，先對照目前的程式碼與 git log；
  發現記憶與現況不同時，指出差異。
- 最後列出記憶中還沒完成的待辦（如果有）。

## 規則

- 這個 skill 只讀。不要呼叫 `scenario_write`、`core_write`，除非使用者明確要求修改記憶。
- 查不到時，說明查了哪些 agent、用了哪些關鍵字，不要直接說「沒有記憶」。
- MCP 工具不存在或連不上（MemoryCore 沒開）時，直接告訴使用者，不要猜。

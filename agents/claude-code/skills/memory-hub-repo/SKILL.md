---
name: memory-hub-repo
description: "查看或修改這個 session 的 Memory Hub 記憶塊綁定了哪些 repo（mem: repo、mem: repo add、mem: repo rm）。觸發：使用者的訊息裡有 mem: repo 但 hook 沒攔下來（例如前面多了 -、引號、其他文字），或用一般說法要求「把 X 加到記憶塊」「從記憶塊拿掉 X」「這個記憶塊綁了哪些 repo」。"
---

# Memory Hub repo 綁定

`mem: repo` 平常由 UserPromptSubmit hook（`memory-command.mjs`）攔下並直接回覆，不會送到你這邊。
**會送到你這邊，就表示 hook 沒比對到**（hook 只認以 `mem:` 開頭的訊息）。這時不要叫使用者重送，
直接用下面的指令替他執行。

## 指令

| 意圖 | 指令文字 |
|---|---|
| 查看目前綁定 | `mem: repo` |
| 加入 repo | `mem: repo add <路徑或已有記憶的 repo 名稱>` |
| 移除 repo | `mem: repo rm <repo 名稱或 hash 前綴>` |

## 執行方式（Bash）

把指令文字當作第一個參數傳入，不要手寫 JSON（Windows 路徑的反斜線會被吃掉）：

```bash
HUB="${PERSONAL_MEMORY_HUB_DIR:-$HOME/personal-memory-hub}"
node -e 'process.stdout.write(JSON.stringify({session_id:process.env.CLAUDE_CODE_SESSION_ID,cwd:process.cwd(),prompt:process.argv[1]}))' \
  "mem: repo add ai-usage-monitor" \
  | node "$HUB/agents/claude-code/hooks/memory-command.mjs"
```

- 輸出是 `{"decision":"block","reason":"…"}`，把 `reason` 原文告訴使用者，例如
  `🧠 記憶塊 d421a1be → ai-usage-monitor (f716b9e) · llm-gateway (4f98fc7)`。
- 沒有輸出：指令文字不是以 `mem: repo` 開頭，檢查後重試。
- `reason` 是錯誤訊息（例如找不到 repo）：照實告訴使用者。用名稱找不到時，改用完整路徑再試一次
  （repo 名稱只對已經有記憶的 repo 有效）；路徑有空白時整段指令文字要加引號。

## 規則

- 只執行使用者要求的動作。只要求查看時只跑 `mem: repo`，不要順手 add 或 rm。
- `rm` 會讓那個 repo 不再被自動加回，執行前確認使用者指的是哪個 repo；名稱不明確時先跑 `mem: repo` 列出來讓使用者選。
- 需要 `CLAUDE_CODE_SESSION_ID`（Claude Code 才有）。沒有這個環境變數時，告訴使用者直接在訊息開頭輸入 `mem: repo …`。
- 下一輪結束時 Stop hook 會再印一次綁定，那是正常的確認輸出。

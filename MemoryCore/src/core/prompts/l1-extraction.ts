/**
 * L1 Extraction Prompt: 情境切分 + 記憶提取
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `你是專業的"情境切分與記憶提取專家"。
你的任務是分析使用者的對話，判斷情境切換，並從中提取結構化的核心記憶（僅限 persona, episodic, instruction 三類）。

**輸出語言**：所有自由文字欄位（\`scene_name\`、memory \`content\`）使用與使用者訊息相同的語言；JSON 欄位名、列舉值、ISO 時間戳保持英文。若判定為中文，一律使用繁體中文（Traditional Chinese, zh-TW），嚴禁使用簡體中文。

### 任務一：情境切分（Scene Segmentation）
分析【待提取的新訊息】，結合【上一個情境】，判斷並輸出當前對話的情境。
- 繼承：無明顯切換，沿用上一個情境。
- 切換條件：使用者發出明確指令（如"換話題"）、意圖轉變、或提出獨立新目標。
- 一段對話可能只有一個情境，也可能有多個情境（話題多次切換時）。
- 命名規則："我（AI）在和xxx（使用者身份）做xxx（目標活動）"（**使用上述輸出語言**，約 30-50 個字元或等價長度，單句，全域性唯一）。

---

### 任務二：核心記憶提取（Memory Extraction）
結合背景和當前情境，僅從【待提取的新訊息】中提取核心資訊。

【通用提取原則】
1. 寧缺毋濫：過濾瑣碎閒聊、臨時性指令和一次性操作（如"這次、本單"）；剔除不可靠的邊緣資訊。
2. 獨立完整：記憶必須"跳出當前對話依然成立"，無上下文也能看懂。提取主體必須以"使用者（姓名）"或"AI"為核心。
3. 歸納合並：強關聯或因果關係的多條訊息，必須合併為一條完整記憶，不可碎片化。

【支援提取的三大型別】（必須嚴格遵守型別規則）
> 下面給出的"提取句式"和"觸發詞"僅作為中文骨架參考；**實際 \`content\` 必須按上述輸出語言書寫**（例如英文使用者 → "The user (Maya) is a senior product manager based in Berlin"）。

1. 個性化記憶 (type: "persona")
   - 定義：使用者的穩定屬性、偏好、技能、價值觀、習慣（如住所、職業、飲食禁忌）。
   - 提取句式："使用者（[姓名]）喜歡/是/擅長..."
   - 打分 (priority)：80-100（健康/禁忌/核心特質）；50-70（一般喜好/技能）；<50（模糊次要，可丟棄）。
   - 觸發詞：喜歡、習慣、經常、我這個人...

2. 客觀事件記憶 (type: "episodic")
   - 定義：客觀發生的動作、決定、計劃或達成結果。絕不包含純主觀感受。
   - 提取句式："使用者（[姓名]）在 [最好是精確絕對時間] 於 [地點] [做了某事（可以包含起因、經過、結果）]"。
   - 時間約束：儘量基於訊息的 timestamp 推算絕對時間，如能確定則在 metadata 中輸出 activity_start_time 和 activity_end_time（ISO 8601格式）。無法確定時可省略。
   - 打分 (priority)：80-100（重要事件/計劃）；60-70（一般完整活動）；<60（瑣碎事項，直接丟棄）。

3. 全域性指令記憶 (type: "instruction")
   - 定義：使用者對 AI 提出的長期行為規則、格式偏好、語氣控制。
   - 提取句式："使用者要求/希望 AI 以後回答時..."
   - 觸發詞：以後都、從現在開始、記住、必須。
   - 打分 (priority)：-1（極其嚴格的全域性死命令）；90-100（核心行為規則）；70-80（重要要求）；<70（臨時要求，直接丟棄）。

---

### 不應該提取的內容
- 瑣碎閒聊、問候；臨時性的純工具性請求（如"這次幫我翻譯一下"）
- 一次性操作指令（如"這次、本單"相關）
- 重複的內容；AI助手自身的行為或輸出
- 不屬於以上3類的資訊
- 純主觀感受（不帶客觀事件的情緒表達）

---

### 任務三：輸出格式規範（JSON）
返回且僅返回一個合法的 JSON 陣列。陣列的每一項是一個情境，包含該情境的訊息範圍和抽取到的記憶：

[
  {
    "scene_name": "當前生成或繼承的情境名稱",
    "message_ids": ["屬於該情境的訊息ID列表"],
    "memories": [
      {
        "content": "完整、獨立的記憶陳述（按對應型別的句式要求）",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["訊息ID_1", "訊息ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata 欄位說明：
- episodic 型別：如能確定活動時間，填入 {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- 其他型別或無法確定時間：輸出空物件 {}

如果整段對話無有意義的記憶，也要輸出情境分割結果，memories 為空陣列：
[
  {
    "scene_name": "情境名稱",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

請嚴格按上述 JSON 陣列格式輸出，不要輸出任何額外的 Markdown 程式碼塊修飾符（如 \`\`\`json）或解釋文字。

**中文強制要求**：若判定輸出語言為中文，一律使用繁體中文（Traditional Chinese, zh-TW）書寫，嚴禁使用簡體中文。`;

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `你是專業的"工作情境切分與工作記憶提取專家"。
你的任務是分析工作訊息，判斷工作情境切換，並從中提取結構化工作記憶。

訊息通常是一位使用者和 AI 助理的對話，不是多人團隊；記憶內容請用「使用者」稱呼這位使用者，不要寫成「團隊」。你應重點提取專案事實、任務進展、決策結論、工作方法、SOP、禁忌、設計思路、交付物，以及使用者明確表達的工作偏好等對後續工作和 Agent 執行有長期價值的資訊。

**輸出語言**：所有自由文字欄位（\`scene_name\`、memory \`content\`）使用與待提取訊息主導語言相同的語言；JSON 欄位名、列舉值、ISO 時間戳保持英文。若判定為中文，一律使用繁體中文（Traditional Chinese, zh-TW），嚴禁使用簡體中文。

---

### 任務一：工作情境切分（Work Scene Segmentation）

分析【待提取的新訊息】，結合【上一個情境】和【背景訊息】，判斷當前訊息屬於哪個工作情境。

【情境定義】
一個情境是圍繞同一個專案、任務、模組、需求、問題、決策、事故、客戶場景或工作目標展開的一組訊息。

【繼承條件】
如果新訊息仍在延續上一個專案、任務、需求、問題或工作目標，則沿用上一個情境。

【切換條件】
出現以下情況之一，應切換或建立新的情境：
1. 討論對象變成另一個專案、模組、需求、客戶、Issue、PR、實驗、事故或交付物。
2. 工作目標發生明顯變化，例如從"需求討論"切換到"上線排期"。
3. 明確出現新的獨立任務、決策脈絡或問題排查脈絡。
4. 多個工作議題在同一批訊息中連續出現，應拆分為多個情境。

【命名規則】
- 情境名稱必須圍繞工作對象命名，以專案或主題開頭。
- 推薦格式："[專案或主題]-[子題]"，例如 "Memory Hub-L1 去重"。
- 長度約 10-30 個字元，簡短穩定，不要加動作描述。
- 同一個專案和主題要沿用同一個名稱（例如上一個情境名稱），不要因為措辭不同而另起新名稱。
- 示例：
  - "Agent Memory-群聊抽取規則"
  - "Billing API-線上超時排查"
  - "安燈試點-查詢介面需求"

---

### 任務二：工作記憶提取（Work Memory Extraction）

結合背景和當前情境，僅從【待提取的新訊息】中提取可共享的核心工作資訊。

【通用提取原則】

1. 面向工作協作：
   - 提取出的記憶應能幫助團隊成員或 Agent 在後續任務中理解專案背景、接續任務、複用經驗或避免重複錯誤。
   - 不提取普通寒暄、閒聊、臨時情緒表達、一次性工具請求。

2. 面向團隊共享：
   - 提取內容預設會在專案團隊內共享。
   - 只提取適合團隊共享的工作內容。
   - 不提取與工作無關的個人偏好、私人生活或敏感資訊。

3. 獨立完整：
   - 每條記憶必須跳出當前對話仍能理解。
   - content 必須包含清晰主體、工作對象、結論、狀態或方法。
   - 不要使用"這個"、"那個"、"上面說的"等依賴上下文的表達。

4. 準確歸因：
   - 某人提出的建議、擔憂、判斷，不等於團隊決策。
   - 只有出現明確確認、拍板、採納、執行安排時，才能寫成確定結論。
   - 未確認內容應表達為"團隊正在討論..."、"某方案仍待確認..."、"存在某風險..."。

5. 歸納合並：
   - 強關聯的多條訊息應合併成一條完整記憶。
   - 不要把同一個工作結論拆成多個碎片。
   - 但不同工作對象、不同任務、不同方法論應分開提取。

6. 只從新訊息提取：
   - 【背景訊息】只用於理解上下文、指代關係和時間。
   - 嚴禁從背景訊息中新增提取記憶。
   - source_message_ids 必須只包含【待提取的新訊息】中的 message id。

7. AI / Agent 輸出處理：
   - 不要把 AI 的建議自動當成團隊事實或團隊決策。
   - 只有當人類成員採納、確認，或 Agent 輸出本身是明確的工具執行結果、交付物、實驗結果時，才可以提取。
   - AI 生成的草案、方案、分析，如被明確作為後續工作資產使用，可提取為 work_artifact 或 work_method。

---

### 支援提取的四類工作記憶

memory \`type\` 必須從以下列舉中選擇：

1. 工作事實（type: "work_fact"）

定義：
關於專案、系統、業務、客戶、需求、決策、狀態、風險、約束、實驗結果的事實性資訊。

適合提取：
- 專案目標
- 產品需求
- 技術方案
- 架構約束
- 客戶反饋
- 決策結論
- 當前狀態
- 風險和阻塞
- 實驗結果
- 術語定義
- 系統事實

示例：
- "Agent Memory 團隊版採用 L0 Work Event、L1 Work Record、L2 Project Scene Block、L3 Team Operating Memory 的四層結構。"
- "團隊決定團隊共享記憶只提取工作內容，不沉澱個人畫像。"
- "安燈試點要求記憶查詢介面支援按專案篩選，並允許配置返回欄位。"
- "多人群聊中工作討論和閒聊混雜，存在誤提取無關內容的風險。"

priority：
- 90-100：關鍵決策、核心需求、長期約束、重要風險。
- 70-89：對當前專案有持續價值的一般事實。
- <70：細碎、臨時、低影響事實，直接丟棄。

---

2. 工作任務（type: "work_task"）

定義：
需要後續執行、跟進、確認或交付的任務、行動項、責任分工。

適合提取：
- 待辦事項
- owner 明確的任務
- deadline 明確的任務
- 需要跟進的問題
- 阻塞中的事項
- 下一步計劃
- 任務狀態變化

示例：
- "後端團隊需要在週五前完成 record 與 event 多對多追溯表結構設計。"
- "產品側需要補充團隊共享記憶的許可權邊界說明。"
- "L1 Prompt 已進入工作記憶型別收斂階段，下一步需要同步修改下游 enum。"

priority：
- 90-100：阻塞交付、有明確 deadline、影響關鍵路徑的任務。
- 70-89：有明確 owner 或明確後續動作的一般任務。
- <70：模糊、臨時、無明確後續動作的待辦，直接丟棄。

metadata 建議：
- 如能確定 owner，填入 {"owner": "名稱或ID"}。
- 如能確定 deadline，填入 {"deadline": "ISO8601"}。
- 如能確定狀態，填入 {"status": "todo|doing|done|blocked|deferred|cancelled"}。

---

3. 工作方法（type: "work_method"）

定義：
團隊在工作中形成的可複用方法、SOP、流程、原則、禁忌、設計思路、經驗教訓、判斷標準、Agent 行為規則。

這是團隊長期工作記憶中最重要的型別之一。它不只是記錄發生了什麼，而是記錄以後遇到類似任務應該怎麼做、不要怎麼做、按什麼原則判斷。

適合提取：
- SOP
- 協作流程
- 設計原則
- 技術路線選擇思路
- 評估標準
- 風險規避規則
- 禁忌和邊界
- 複用經驗
- Agent 執行策略
- Prompt 編寫原則
- 專案方法論

示例：
- "團隊版 Agent Memory 的 L1 抽取應優先使用少量高層工作型別，避免把型別拆得過細導致後續聚合困難。"
- "團隊共享記憶的抽取應優先記錄專案事實、任務、方法和交付物，而不是普通聊天內容。"
- "當多人訊息中只有單人建議而沒有明確確認時，不能直接抽取為團隊決策。"
- "L1 Prompt 應保持輸出 JSON 結構穩定，優先透過調整 type 列舉和提取規則適配新場景。"
- "工作方法類記憶可以沉澱 SOP、禁忌、設計思路和可複用經驗，用於支援後續 Agent 執行。"

priority：
- 90-100：長期穩定、可跨任務複用、影響 Agent 行為或團隊流程的核心方法。
- 70-89：對當前專案後續工作有明顯複用價值的方法。
- <70：過於臨時、模糊或只適用於一次性操作的方法，直接丟棄。

metadata 建議：
- 如能確定適用範圍，填入 {"scope": "project|team|module|agent|workflow"}。
- 如能確定方法類別，填入 {"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}。
- 如是禁忌或反模式，填入 {"method_type": "anti_pattern"}。

---

4. 工作資產（type: "work_artifact"）

定義：
團隊產生、引用、維護或需要後續使用的工作資產，包括文件、PR、Issue、設計稿、實驗報告、程式碼倉庫、資料表、會議紀要、Prompt、方案草案等。

適合提取：
- 文件
- PR / Issue
- 程式碼分支
- 實驗報告
- 設計稿
- 會議紀要
- Prompt
- 表格
- 連結
- 方案草案
- Agent 生成且被採納的工作輸出

示例：
- "L1 工作記憶抽取 Prompt 是 Agent Memory 團隊版設計中的核心 Prompt 資產。"
- "團隊將四層工作記憶結構作為後續 L2 和 L3 聚合 Prompt 的設計基礎。"
- "Flowchart 與 StateDiagram 對比實驗結果可作為短期記憶壓縮方案選擇的依據。"

priority：
- 90-100：核心文件、關鍵 PR、上線相關資產、重要實驗報告。
- 70-89：後續可能複用的一般工作資產。
- <70：臨時檔案、低價值連結、未被採用的草稿，直接丟棄。

metadata 建議：
- 如能確定資產型別，填入 {"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note"}。
- 如能確定連結或標識，填入 {"artifact_ref": "連結、ID或名稱"}。

---

### 不應該提取的內容

以下內容通常不應提取：
- 問候、寒暄、玩笑、無工作價值的閒聊。
- 臨時性的一次性請求，例如"這次幫我改一下格式"。
- 未被採納的 AI 建議或臨時草稿。
- 無明確後續價值的細節。
- 與工作無關的個人偏好、私人生活或敏感資訊（使用者對 AI 助理工作方式的要求屬於工作內容，要提取）。

---

### 任務三：輸出格式規範（JSON）

返回且僅返回一個合法的 JSON 陣列。陣列的每一項是一個工作情境，包含該情境的訊息範圍和抽取到的工作記憶：

[
  {
    "scene_name": "當前生成或繼承的工作情境名稱",
    "message_ids": ["屬於該情境的訊息ID列表"],
    "memories": [
      {
        "content": "完整、獨立、適合團隊共享的工作記憶陳述",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["訊息ID_1", "訊息ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata 欄位說明：
- 所有型別都可以輸出空物件 {}。
- work_task 可補充 owner、deadline、status。
- work_method 可補充 scope、method_type。
- work_artifact 可補充 artifact_type、artifact_ref。
- work_fact 可補充 work_object、status、activity_start_time、activity_end_time。
- metadata 不要包含無關個人資訊。

如果整段新訊息無有意義的團隊共享工作記憶，也要輸出情境分割結果，memories 為空陣列：

[
  {
    "scene_name": "工作情境名稱",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

請嚴格按上述 JSON 陣列格式輸出，不要輸出任何額外的 Markdown 程式碼塊修飾符（如 \`\`\`json）或解釋文字。

**中文強制要求**：若判定輸出語言為中文，一律使用繁體中文（Traditional Chinese, zh-TW）書寫，嚴禁使用簡體中文。`;

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "無" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "無";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**輸出語言**：根據下方"待提取的新訊息"中 user 發言的主導語言書寫 \`scene_name\` 和 memory \`content\`。若判定為中文，一律使用繁體中文（Traditional Chinese, zh-TW），嚴禁使用簡體中文。

【上一個情境】：${previousSceneName}

【背景對話】（僅供理解上下文推斷關係/時間，嚴禁從中提取記憶）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新訊息】（務必結合 timestamp 推算時間，只從這裡提取記憶！）：
${newText}`;
}

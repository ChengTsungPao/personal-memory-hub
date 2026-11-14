/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**輸出語言**：\`persona.md\` 的所有自然語言內容（Archetype、基本資訊、Chapter 1-4 正文等）使用與變化場景內容相同的語言；Markdown 語法、標籤格式、檔名 \`persona.md\` 保持英文。模板裡 Chapter 標識保留作骨架，非中文輸出時請改用目標語言的對照說明。若判定為中文，一律使用繁體中文（Traditional Chinese, zh-TW），嚴禁使用簡體中文。

請你結合已有的 persona.md 和新增/變化的 block 資訊深度分析，然後使用檔案工具將結果寫入 \`persona.md\` 檔案。

## ⛔ 檔案操作約束（必須嚴格遵守）

1. **必須使用檔案工具將最終 persona 內容寫入 \`persona.md\`**。當前工作目錄已設為資料目錄，直接使用檔名 \`persona.md\`。
   - **首次生成 / 大幅重寫**：使用 **write** 工具整體寫入。引數：\`path\`=\`persona.md\`, \`content\`=完整內容
   - **增量更新（區域性修改）**：使用 **edit** 工具精確替換。引數：\`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: 舊內容片段, \`newText\`: 新內容片段}]
2. **只能操作 \`persona.md\` 這一個檔案**，禁止讀取或寫入任何其他檔案（包括 scene_blocks/、.metadata/ 等）。
3. **寫入的內容必須只包含最終的 persona 文件**，不要包含你的思考過程、分析步驟或任何非 persona 內容。
4. **無需 read 工具**：當前 persona.md 的完整內容已在使用者訊息中提供，直接基於它進行更新即可。

### 🚫 嚴格禁止
- **禁止過長**：persona.md 內容總長度不要超過 2000 字元，及時做總結和刪除不重要的資訊。
- **禁止過度推測**：沒提到的資訊不要過度臆想導致產生幻覺，特別是在冷啟動階段，要保持克制，如果沒有相關資訊完全可以不填！
- **禁止使用非場景來源的資訊**：Persona 的所有內容必須且只能來自下方提供的場景資料。不要從 workspace 目錄結構、檔案路徑、系統資訊等技術後設資料中提取任何關於使用者的個人資訊。
- **禁止操作 persona.md 以外的任何檔案**。

---

## ⚙️ 核心運作邏輯 (The Core Logic)

🧠 核心思維引擎：連線與綜合 (Connect & Synthesize)
請遵循 "敘事連貫性" 原則處理資訊。禁止簡單的羅列（No Bullet-point Spamming）。

1. 尋找"貫穿線" (The Connecting Thread)
不要孤立地看資訊。要尋找不同領域行為背後的共同邏輯。
** 要保持精簡，不過度猜想，如果不確定可以不寫 **

執行以下**四層深度掃描**：

### 🟢 Layer 1: 基礎錨點 (The Base & Facts) -> 【建立連線】
* **掃描目標**: 確鑿的事實、人口統計學特徵、當前狀態。
* **實用價值**: 為 Agent 提供**破冰話題**和**上下文感知**。

### 🔵 Layer 2: 興趣圖譜 (The Interest Graph) -> 【提供談資】
* **掃描目標**: 使用者投入時間、金錢或注意力的事物。
* **提取原則**: **區分活躍度**（活躍愛好 / 被動消費 / 休眠興趣）。
* **實用價值**: 讓 Agent 能夠進行**高質量的閒聊 (Chit-chat)** 和 **生活推薦**。

### 🟡 Layer 3: 互動協議 (The Interface) -> 【消除摩擦】
* **掃描目標**: 使用者的溝通習慣、雷區、工作流偏好。
* **實用價值**: 指導 Agent **如何說話、如何交付結果**，避免踩雷。

### 🔴 Layer 4: 認知核心 (The Core) -> 【深度共鳴】
* **掃描目標**: 決策邏輯、矛盾點、終極驅動力。
* **實用價值**: 讓 Agent 成為**能夠替使用者做決策**的"副駕駛"。

---

## 📝 輸出模板 (The Persona Template)

請參考以下格式，使用 **write** 工具寫入最終內容。可以做自主調整（資訊不足時可以減少或新增 chapter）（**必須保持 Markdown 格式**）：

\`\`\`\`markdown
# User Narrative Profile

> **Archetype (核心原型)**: [一句話定義。例如：一位在現實重力下掙扎，但試圖透過技術構建理想國的"務實理想主義者"。]

> **基本資訊**
（使用者的基本資訊，如年齡、性別、職業等，更新時若有衝突則覆蓋，不衝突儘量疊加）
 -
 -

> **長期偏好**
（你觀察到的使用者最穩定且可複用的偏好）
    -
    -

## 📖 Chapter 1: Context & Current State (全景語境)
*(將基礎事實與當前狀態融合，寫成一段連貫的背景介紹)*

**[這裡寫連貫描述，區別較大的時候可以分點闡述]**

## 🎨 Chapter 2: The Texture of Life (生活的肌理)
*(將興趣、消費、生活習慣串聯起來，展示生活品味)*

**[這裡寫連貫的描述，重點在於"興趣/偏好"和"品味"的統一性，區別較大的時候可以分點闡述]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol (互動與認知協議)
*(這是 Main Agent 的行動指南。為了實用，這裡保持半結構化，但要解釋"為什麼")*

### 3.1 溝通策略 (How to Speak)
### 3.2 決策邏輯 (How to Think)

## 🧩 Chapter 4: Deep Insights & Evolution (深層洞察與演變)
*(人類學觀察筆記)*

* **矛盾統一性**: [描述使用者身上看似衝突但實則合理的特質]。
* **演變軌跡**: [可加上時間，分為多點，描述使用者最近發生的變化]。
* **湧現特徵**: 提煉 3-7 個最核心的特質標籤，每個標籤單獨一行並附上簡短註釋（10-15字）
  - \`TagName\` - 簡短註釋說明
\`\`\`\`

---

### ⚠️ 成功標準
- ✅ **必須使用 write 或 edit 工具寫入最終結果到 \`persona.md\`**
- ✅ 基於場景證據生成深度洞察
- ✅ 內容到 Chapter 4 結束（不包含場景導航，工程會自動追加）
- ✅ 必須嚴格按照上面的模板格式
- ✅ 不要新增場景導航（工程會自動追加）
- ✅ 只操作 persona.md，不要操作其他檔案

**中文強制要求**：若判定輸出語言為中文，一律使用繁體中文（Traditional Chinese, zh-TW）書寫，嚴禁使用簡體中文。`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# L3 工作原則撰寫者

**輸出語言**：\`persona.md\` 的所有自然語言內容使用與變化場景內容相同的語言；Markdown 語法、標籤格式、檔名 \`persona.md\` 保持英文。若判定為中文，一律使用繁體中文（Traditional Chinese, zh-TW），嚴禁使用簡體中文。

請你結合已有的 \`persona.md\` 和新增/變化的 L2 場景塊，生成或更新一份高度精煉的工作原則文件。

記憶通常來自一位使用者和 AI 助理的對話，不是多人團隊；請用「使用者」稱呼這位使用者，不要寫成「團隊」。

這份 L3 不是專案總結、進度記錄、場景索引或事實彙總，而是在各種工作場合都可複用的工作原則。它應幫助 Agent 在未來面對新任務時，知道應該如何判斷、如何執行、如何避免錯誤。

## ⛔ 檔案操作約束

1. **必須使用檔案工具將最終內容寫入 \`persona.md\`**。
   - 首次生成 / 大幅重寫：使用 **write**，引數：\`path\`=\`persona.md\`, \`content\`=完整內容。
   - 增量更新：使用 **edit**，引數：\`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: 舊內容片段, \`newText\`: 新內容片段}]。
2. **只能操作 \`persona.md\` 這一個檔案**，禁止讀取或寫入任何其他檔案。
3. **無需 read 工具**：當前 \`persona.md\` 的完整內容已在使用者訊息中提供。
4. 寫入內容必須只包含最終 Markdown 文件，不要包含分析過程或解釋。

## 🚫 嚴格禁止

- **禁止超過 1200 字**：最終 \`persona.md\` 必須高度壓縮，求精不求多。
- **禁止專案化碎片**：不要寫只有在某個專案上下文裡才懂的內容，例如"專案 v2 要最佳化"、"某模組繼續推進"。
- **禁止流水賬**：不要記錄發生了什麼、誰做了什麼、某任務進展如何，除非它已經抽象成通用方法。
- **禁止低層事實堆積**：專案名、版本號、任務名、PR、Issue、文件名通常不要進入 L3，除非它們代表可複用範式。
- **禁止語義不完整**：每條原則必須脫離原專案也能理解，必須包含動作對象、適用條件或判斷邏輯。
- **使用者的工作偏好要寫**：使用者明確說過的工作要求與偏好（例如「改動前先確認」「只做被要求的事」「走 PR 不直接推 main」）屬於 Agent 規則，應該寫入；但不要推測性格、私人狀態或情緒。
- **禁止過度推測**：沒有場景證據的資訊不要臆測。
- **禁止抄寫本提示**：本提示裡的寫作規則（例如「求精不求多」「語義完整」）是給你的指示，不是知識，不要寫進文件。

---

## 核心目標

你要從 L2 場景中提煉所有工作場合都可複用的內容：

1. **SOP**：以後類似任務應該按什麼流程做。
2. **Principle**：使用者長期遵守的工作原則。
3. **Decision Logic**：遇到取捨時按什麼標準判斷。
4. **Boundary**：哪些事情不能做，哪些內容不能自動化。
5. **Anti-pattern**：哪些做法會導致錯誤、汙染記憶、降低質量。
6. **Agent Rule**：Agent 執行任務、更新記憶、生成結果時應遵守什麼規則。

專案事實、任務狀態、資產名稱只作為證據來源，不應直接進入 L3。只有當它們能抽象成跨場景規則時，才寫入。

---

## 過濾標準

寫入 L3 前逐條檢查：

1. **通用性**：這條內容是否適用於多個專案、多個任務或多種工作場合？
2. **完整性**：脫離原始專案後，讀者是否仍能理解它在要求什麼？
3. **可執行性**：Agent 是否能據此改變未來行為？
4. **穩定性**：它是否可能長期有效，而不是一次性任務狀態？
5. **精煉性**：能否用更少字表達？是否可以合併進已有原則？

如果任一答案是否定，優先不寫入。

---

## 增量更新策略

面對變化場景，自主判斷：

- **強化**：新場景只是佐證已有原則，壓縮進原句或不改。
- **補充**：出現新的通用 SOP、禁忌、判斷邏輯或 Agent 規則。
- **修正**：舊原則被新證據推翻或邊界變清晰。
- **重構**：文件變散、變長、變專案化時，整體壓縮重寫。
- **不改**：新增內容只有專案狀態、普通任務或低層事實時，不更新 L3。

不要把每次變化追加為新條目。L3 應持續壓縮，保持少而準。

---

## 輸出模板

請參考以下格式，使用 **write** 或 **edit** 工具寫入最終內容。可以刪減章節，但必須保持 Markdown 格式，全文不超過 1200 字。

# 工作原則

> **核心主張**：[一句話概括使用者最核心、最通用的工作方法或 Agent 執行原則。]

## 核心原則
[只寫跨工作場景穩定成立的高層原則。每條必須語義完整。]

- [原則]&#58; [適用條件 / 判斷邏輯 / 為什麼重要]

## 可重複使用的 SOP
[只寫能被反覆執行的流程。不要寫具體專案步驟。]

- [SOP 名稱]&#58; 當 [觸發條件] 時，先 [步驟1]，再 [步驟2]，最後 [產出/驗收標準]。

## 判斷邏輯
[記錄取捨標準和優先順序。]

- 當 [場景] 時，優先 [A] 而不是 [B]，因為 [原因]。

## 邊界與反模式
[記錄禁忌、邊界和錯誤模式。]

- 不要 [錯誤做法]；應改為 [推薦做法]，因為 [原因]。

## Agent 規則
[記錄 Agent 在工作中預設遵守的行為規則。]

- Agent 應 [行為規則]，避免 [風險]。

（不要寫更新時間、場景數或記憶數的頁尾，系統會自動加上。）

---

## 成功標準

- ✅ 必須使用 write 或 edit 寫入 \`persona.md\`
- ✅ 最終內容不超過 1200 字
- ✅ 只保留所有工作場合可複用的原則、SOP、禁忌、判斷邏輯和 Agent 規則
- ✅ 每條內容脫離具體專案後仍語義完整
- ✅ 求精不求多，能不寫就不寫，能合併就合併
- ✅ 不寫專案進度、任務流水賬、版本碎片或場景索引
- ✅ 不要新增場景導航（工程會自動追加 Scene Navigation 和場景索引）
- ✅ 只操作 \`persona.md\`

**中文強制要求**：若判定輸出語言為中文，一律使用繁體中文（Traditional Chinese, zh-TW）書寫，嚴禁使用簡體中文。`;

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 首次生成" : "🔄 迭代更新";

  const triggerSection = triggerInfo
    ? `\n### 觸發資訊\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 當前工作原則（工程已預載入）\n\n` +
        `*以下是現有 persona.md 的完整內容（${existingPersona.length} 字元）。更新後必須壓縮在 1200 字以內；若標題仍是舊的英文模板（Team Operating Doctrine 等），改用上方模板的中文標題：*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 當前 Persona（工程已預載入）\n\n` +
        `*以下是現有 persona.md 的完整內容（${existingPersona.length} 字元），基於此更新後請控制在2000字內：*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 迭代決策指南\n\n` +
        `面對變化場景，自主判斷處理方式：強化（佐證已有原則）/ 補充（新的通用 SOP、禁忌、判斷邏輯或 Agent 規則）/ 修正（舊原則被更新）/ 重構（內容變長、變散、變專案化）/ 不改（只有專案狀態或低層事實）。\n`
      : `\n## 🔄 迭代決策指南\n\n` +
        `面對變化場景，自主判斷處理方式：強化（佐證已有洞察）/ 補充（新維度）/ 修正（矛盾）/ 重構（結構調整）/ 不改（無有用新增內容）。\n`
    : "";

  const userPrompt = `**輸出語言**：\`${targetFile}\` 使用下方變化場景內容的主導語言。若判定為中文，一律使用繁體中文（Traditional Chinese, zh-TW），嚴禁使用簡體中文。

**⏰ 更新時間**: ${currentTime}
**模式**: ${modeLabel}
${triggerSection}
## 📊 統計
- **總記憶數**: ${totalProcessed} 條
- **場景總數**: ${sceneCount} 個
- **變化場景**: ${changedSceneCount} 個（自上次更新後）

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}

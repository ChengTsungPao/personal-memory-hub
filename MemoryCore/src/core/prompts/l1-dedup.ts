/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `你是記憶衝突檢測器。批次比較多條【新記憶】與【統一候選記憶池】中的已有記憶，逐條決定如何處理。

**輸出語言**：\`merged_content\` 使用與候選池中已有記憶相同的語言；JSON 欄位名、列舉值、record_id、ISO 時間戳保持英文。

## 核心規則

- **跨 type 合併**：不同 type（persona / episodic / instruction / work_fact / work_task / work_method / work_artifact）的記憶如果語義上描述同一事實/事件，**可以合併**。
- **多對多合併**：一條新記憶可以同時替換/合併候選池中的**多條**已有記憶（透過 target_ids 陣列指定）。
- 合併後你必須判斷新記憶的最佳 type（merged_type）。

## 判斷邏輯

1. **分辨記憶性質**：
   - **狀態類**（persona/instruction）：偏好、特質、長期設定、相對穩定的事實、行為規則
   - **事件類**（episodic）：一次性經歷、帶時間點的客觀記錄，建議合併同一件事的前因後果

2. **判斷是否同一事實/事件**：主體相同、主題一致、時間接近、scene_name 相似

3. **選擇動作**：
   - "store"：視為新資訊，新增當前記憶。
   - "skip"：已有記憶更好，新記憶無增量或更模糊，忽略當前記憶。
   - "update"：同一事實/事件，新記憶在內容或時間上更優（更具體、更晚或糾錯），以新記憶為主覆蓋舊記憶，可保留舊記憶中仍正確的細節。
   - "merge"：同一事實或同一演化過程，多條記憶資訊互補且不矛盾，合併成一條更完整記憶，資訊儘量不冗餘。

4. **策略傾向**：
   - 狀態類：多條描述同一偏好/特質 → 傾向 merge；無增量 → skip；明確更新 → update
   - 事件類：同一事件的前因後果、不同階段 → 傾向 merge 為一條完整敘述；完全相同 → skip
   - 跨型別示例：一條 episodic "使用者在 2018 年開始做播客" + 一條 persona "使用者有播客製作經驗" → 可 merge 為一條 persona 或 episodic（取決於資訊側重）

5. **timestamp 處理**：
   - merge / update 時，merged_timestamps 應包含**所有相關記憶的時間戳並集**（去重排序）
   - 這樣可以保留事件發生的完整時間線

## 輸出格式

嚴格輸出 JSON 陣列，每個元素對應一條新記憶的決策。不輸出任何其他內容：

[
  {
    "record_id": "新記憶的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要刪除的候選記憶 record_id 1", "record_id 2"],
    "merged_content": "合併/更新後的記憶內容（merge/update 時必填）",
    "merged_type": "合併後的最佳 type：persona|episodic|instruction|work_fact|work_task|work_method|work_artifact（merge/update 時必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合併後的時間戳陣列，包含所有新舊記憶時間戳的並集（merge/update 時必填）"]
  }
]

欄位說明：
- target_ids：要刪除替換的舊記憶 ID **陣列**（可以 1 條或多條）。store/skip 時省略或為空。
- merged_content：merge/update 時的最終記憶文字。store/skip 時省略。
- merged_type：merge/update 後記憶應歸屬的 type。根據合併後內容本質判斷。
- merged_priority：merge/update 後的新優先順序（0-100 整數，merge/update 時必填）。合併後資訊更完整、更確定，通常應**酌情提升** priority（例如兩條 priority 70 的記憶合併後可提升到 80）。參考標準：80-100（核心特質/重要事件），60-79（一般偏好/普通活動），<60（次要資訊）。
- merged_timestamps：合併後的時間戳陣列。收集新記憶 + 所有被合併舊記憶的時間戳，去重排序。`;

// Work mode (Memory Hub). Traditional Chinese, and tuned against an offline replay of 20 real dedup jobs:
// the upstream "傾向 update/merge" bias and "資訊儘量不冗餘" made merges drop identifiers, so this
// version stores by default, caps targets at 2, requires every detail to survive a merge, and uses
// each new memory's source_time to stop a backfilled old conversation from overwriting newer memory.
export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `你是工作記憶衝突檢測器。批次比較多條【新記憶】與【統一候選記憶池】中的已有記憶，逐條決定如何處理。

**輸出語言**：\`merged_content\` 使用與候選池中已有記憶相同的語言；JSON 欄位名、列舉值、record_id、ISO 時間戳保持英文。

## 核心規則

- **跨 type 合併**：不同 type（work_fact / work_task / work_method / work_artifact）的記憶如果語意上描述同一工作對象、任務、方法或資產，**可以合併**。
- **多對多合併**：一條新記憶可以同時取代／合併候選池中的**多條**已有記憶（透過 target_ids 陣列指定）。
- 合併後你必須判斷新記憶的最佳 type（merged_type）。
- 記憶來自一位使用者和 AI 助理的對話，不是多人團隊；合併內容請用「使用者」稱呼，不要寫成「團隊」，只保留工作相關資訊。

## 判斷邏輯

1. **分辨記憶性質**：
   - **工作事實類（work_fact）**：專案事實、需求、決策、狀態、風險、限制、實驗結果、客戶回饋。
   - **工作任務類（work_task）**：待辦、負責人、截止日、下一步計畫、任務狀態變化。
   - **工作方法類（work_method）**：SOP、禁忌、原則、經驗、設計思路、判斷標準、Agent 行為規則。
   - **工作資產類（work_artifact）**：檔案、PR、Issue、Prompt、報告、程式分支、設計稿、連結等。

2. **判斷是否為同一工作對象／演進過程**：
   - 同一專案、模組、需求、任務、風險、決策、方法、資產，且 scene_name 或語意高度相似。
   - 同一任務的不同階段、同一方法的補充、同一資產的版本或用途變化，通常可以合併。
   - 僅屬於同一大專案但討論對象不同，不應強行合併。

3. **選擇動作**：
   - "store"：視為新資訊，新增目前這條記憶。
   - "skip"：已有記憶較好，新記憶沒有增量或較模糊，忽略目前這條記憶。
   - "update"：同一工作對象，新記憶更具體、更新、更權威或修正舊資訊，以新記憶為主覆蓋舊記憶，可保留舊記憶中仍正確的細節。
   - "merge"：同一工作對象或同一演進過程，新舊記憶互補且不矛盾，合併成一條更完整的記憶，所有具體細節都必須保留。

4. **timestamp 處理**：
   - merge / update 時，merged_timestamps 應包含**所有相關記憶時間戳的聯集**（去重、排序）。
   - 這樣可以保留工作事實、任務或方法演進的完整時間線。

## 輸出格式

嚴格輸出 JSON 陣列，每個元素對應一條新記憶的決定。不要輸出任何其他內容：

[
  {
    "record_id": "新記憶的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要刪除的候選記憶 record_id 1", "record_id 2"],
    "merged_content": "合併／更新後的記憶內容（merge/update 時必填）",
    "merged_type": "合併後的最佳 type：work_fact|work_task|work_method|work_artifact（merge/update 時必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合併後的時間戳陣列，包含所有新舊記憶時間戳的聯集（merge/update 時必填）"]
  }
]

欄位說明：
- target_ids：要刪除取代的舊記憶 ID **陣列**（可以 1 條或多條）。store/skip 時省略或留空。
- merged_content：merge/update 時的最終記憶文字。store/skip 時省略。
- merged_type：merge/update 後記憶應歸屬的 type，依合併後內容的本質判斷。
- merged_priority：merge/update 後的新優先度（0–100 整數，merge/update 時必填）。合併後資訊更完整、更確定，通常應**酌情提高** priority。參考標準：80–100（關鍵事實／重要任務／核心方法／重要資產），60–79（一般工作資訊），<60（次要資訊）。
- merged_timestamps：合併後的時間戳陣列。收集新記憶與所有被合併舊記憶的時間戳，去重、排序。

## 覆蓋規則（優先於上文）

1. 預設 store。只有確定描述同一個具體對象（同一檔案、PR、決定、任務）才可 merge 或 update；不確定、只是同一專案、或主題不同，一律 store。
2. target_ids 最多 2 條，且只能來自該新記憶的【關聯候選 ID】。同一批中，每條已有記憶最多被一條新記憶當作目標。
3. merged_content 必須保留被合併記憶的全部具體細節：檔名、PR 編號、指令、數字、日期、限定語（如「未交叉驗證」）。不得概括或省略，寧可寫長。無法完整保留時改用 store。
4. 每條新記憶帶有 source_time（來源對話時間）。若它早於目標記憶最新的 timestamps，不得 update，也不得用它否定目標內容；只能 merge（目標內容全部保留）、store 或 skip。`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## 統一候選記憶池\n\n（空，沒有已有記憶，所有新記憶直接 store）";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## 統一候選記憶池（共 ${poolList.length} 條已有記憶）\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[]（無相似候選，直接 store）";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
        ...(m.newMemory.source_time ? { source_time: m.newMemory.source_time } : {}),
      },
      null,
      2,
    );

    return `### 第 ${idx + 1} 條新記憶 (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【關聯候選 ID】${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**輸出語言**：\`merged_content\` 使用與候選池中已有記憶相同的語言。

${poolSection}

${"═".repeat(50)}

## 待判斷的新記憶（共 ${matches.length} 條）

${newMemoriesText}

請逐條判斷並輸出決定 JSON 陣列。當某條新記憶的候選列表為空時，該條直接輸出 action=store。`;
}

/**
 * Put back concrete facts an L2 rewrite dropped without saying why.
 *
 * A small model rewrites a whole scene file on each UPDATE and silently loses commands, paths,
 * ports and env vars the file already had. A fact here is a backtick span in the old content.
 * It counts as kept if it still appears in any scene file after the run (it may have moved in a
 * merge or split), including the 演化記錄 line the prompt asks for when a fact is retired.
 * Otherwise the old line that carried it is appended to 關鍵事實依據 of the same file if it
 * survived, else of the new file closest to that line. Size stays bounded by the split guard in
 * scene-extractor.ts.
 */

const FACT_SECTION = "## 關鍵事實依據";
const MIN_TERM_CHARS = 3;
// A lone plain word (`name`, `plan`, `Currently`) is emphasis, not a command, path or setting.
const PLAIN_WORD = /^[A-Za-z][a-z]*$/;

function factTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    if (t.length >= MIN_TERM_CHARS && !PLAIN_WORD.test(t)) out.add(m[1]);
  }
  return out;
}

/** ASCII words and CJK character pairs of a line, used to find the file on the same topic. */
function lineTokens(line: string): Set<string> {
  const out = new Set<string>();
  for (const w of line.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) out.add(w);
  for (const run of line.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** The new file sharing the most tokens with `line`, or undefined when none shares any. */
function closestFile(line: string, newFiles: Map<string, string>): string | undefined {
  const tokens = lineTokens(line);
  let best: string | undefined;
  let bestShared = 0;
  for (const [file, content] of newFiles) {
    const lower = content.toLowerCase();
    let shared = 0;
    for (const t of tokens) if (lower.includes(t)) shared++;
    if (shared > bestShared) {
      best = file;
      bestShared = shared;
    }
  }
  return best;
}

/** The new file that took over `oldFile`: the same name if it survived, else the one sharing the most terms. */
function successor(oldFile: string, oldTerms: Set<string>, newFiles: Map<string, string>): string | undefined {
  if (newFiles.has(oldFile)) return oldFile;
  let best: string | undefined;
  let bestShared = 0;
  for (const [file, content] of newFiles) {
    let shared = 0;
    for (const t of oldTerms) if (content.includes(`\`${t}\``)) shared++;
    if (shared > bestShared) {
      best = file;
      bestShared = shared;
    }
  }
  return best;
}

function appendToFactSection(raw: string, lines: string[]): string {
  const block = lines.join("\n");
  const start = raw.indexOf(FACT_SECTION);
  if (start < 0) return `${raw.trimEnd()}\n\n${FACT_SECTION}\n${block}\n`;
  const next = raw.indexOf("\n## ", start + FACT_SECTION.length);
  if (next < 0) return `${raw.trimEnd()}\n${block}\n`;
  return `${raw.slice(0, next).trimEnd()}\n${block}\n${raw.slice(next)}`;
}

/**
 * @param oldContents scene body (no META) per file before the LLM run
 * @param newRaws     whole file text per file after the run
 * @returns the files to rewrite, and which terms went back where
 */
export function restoreDroppedFacts(
  oldContents: Map<string, string>,
  newRaws: Map<string, string>,
): { changed: Map<string, string>; restored: Array<{ file: string; term: string }> } {
  const allNew = [...newRaws.values()].join("\n");
  const additions = new Map<string, string[]>();
  const restored: Array<{ file: string; term: string }> = [];

  for (const [oldFile, oldContent] of oldContents) {
    const terms = factTerms(oldContent);
    const dropped = [...terms].filter((t) => !allNew.includes(`\`${t}\``));
    if (dropped.length === 0) continue;
    const fallback = successor(oldFile, terms, newRaws);
    for (const term of dropped) {
      const line = oldContent.split("\n").find((l) => l.includes(`\`${term}\``))!.trim();
      // A renamed or split file's facts follow their own topic, not the file that kept most terms.
      const target = newRaws.has(oldFile) ? oldFile : (closestFile(line, newRaws) ?? fallback);
      if (!target) continue;
      const lines = additions.get(target) ?? [];
      const bullet = line.startsWith("-") || line.startsWith("*") ? line : `- ${line}`;
      if (!lines.includes(bullet)) lines.push(bullet);
      additions.set(target, lines);
      restored.push({ file: target, term });
    }
  }

  const changed = new Map<string, string>();
  for (const [file, lines] of additions) changed.set(file, appendToFactSection(newRaws.get(file)!, lines));
  return { changed, restored };
}

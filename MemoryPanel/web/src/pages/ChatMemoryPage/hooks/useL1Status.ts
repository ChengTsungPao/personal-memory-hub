/**
 * useL1Status — L1 extraction state of the conversation on screen.
 *
 * Asks /chat-memory/l1-status which slices of the loaded sessions are still extracting (🟡) or failed
 * (🔴), and maps each L0 message onto them by session and recorded time. Polls every 10 s only while
 * something is 🟡; stops once everything is done or failed. With no L0 loaded yet (the L1 tab), the
 * sessions come from the first page of L0, so the layer badges show anyway.
 */
import { useEffect, useMemo, useState } from 'react';
import { chatMemoryApi, type ChatMemoryLayerItem, type L1StatusSlice } from '@/lib/api/chat-memory';

export type L1MessageStatus = 'pending' | 'failed';

export const L1_STATUS_POLL_MS = 10_000;

/** The worst state of the slices a message falls in (failed beats pending), or undefined when done. */
export function statusOfMessage(
  item: Pick<ChatMemoryLayerItem, 'session_id' | 'created_at'>,
  slices: L1StatusSlice[],
): L1MessageStatus | undefined {
  if (!item.session_id || !item.created_at) return undefined;
  const t = Date.parse(item.created_at);
  if (!Number.isFinite(t)) return undefined;
  let status: L1MessageStatus | undefined;
  for (const s of slices) {
    if (s.session_id !== item.session_id || t <= s.from || t > s.to) continue;
    if (s.status === 'failed') return 'failed';
    status = 'pending';
  }
  return status;
}

export function countSlices(slices: L1StatusSlice[]): { pending: number; failed: number } {
  return {
    pending: slices.filter((s) => s.status === 'pending').length,
    failed: slices.filter((s) => s.status === 'failed').length,
  };
}

export function useL1Status(blockId: string | undefined, items: ChatMemoryLayerItem[], active: boolean) {
  const [slices, setSlices] = useState<L1StatusSlice[]>([]);
  const sessionIds = useMemo(
    () => [...new Set(items.map((i) => i.session_id).filter((s): s is string => !!s))].sort(),
    [items],
  );
  const key = `${blockId ?? ''}|${sessionIds.join(',')}`;

  useEffect(() => {
    if (!blockId || !active) {
      setSlices([]);
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ids = sessionIds;
    const load = async () => {
      try {
        // L0 is loaded lazily: on the L1 tab it may not be yet, so take the sessions from its first page
        if (ids.length === 0) {
          const l0 = await chatMemoryApi.layer(blockId, 'L0', 50);
          ids = [...new Set(l0.items.map((i) => i.session_id).filter((s): s is string => !!s))].sort();
          if (cancelled) return;
          if (ids.length === 0) {
            setSlices([]);
            return;
          }
        }
        const r = await chatMemoryApi.l1Status(blockId, ids);
        if (cancelled) return;
        const next = r.enabled ? r.slices : [];
        setSlices(next);
        // conditional polling: only while something is still queued or running
        if (next.some((s) => s.status === 'pending')) timer = setTimeout(load, L1_STATUS_POLL_MS);
      } catch {
        // best effort: the page works without it; the next change of the list asks again
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  return { slices, counts: useMemo(() => countSlices(slices), [slices]) };
}

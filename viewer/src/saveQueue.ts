// Debounced auto-save queue, independent of React/DOM so it can be unit-tested
// with `node --test`. store.ts owns the single instance.
//
// Every body is the full serialized file, so for a given path the latest body
// always wins. Per path:
//   pending  — debounce timer running, body not sent yet
//   inflight — PUT sent, not settled; PUTs to one path are chained, never parallel
//   failed   — last PUT failed and no newer body superseded it
//   fenced   — the server is rewriting / has rewritten the file (restore-bak…):
//              bodies scheduled for it are kept aside and NEVER sent, so a body
//              built from the old file cannot land over the new one. A fence
//              ends only with a page reload, or when the rewrite clearly did
//              not happen (then the kept body is scheduled normally).
// isDirty() is true while the server lacks something the user sees.

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'error';

export interface SendOptions {
  /** Unload path: ask the transport to outlive the page (fetch keepalive). */
  keepalive?: boolean;
}

export interface SaveQueueDeps {
  /** Write `body` to `path`; must reject on any failure (network or non-2xx). */
  send: (path: string, body: string, opts: SendOptions) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  delayMs: number;
  onStatus?: (status: SaveStatus, error: string | null) => void;
}

/**
 * Result of a server-side rewrite:
 *   ok          — the file was rewritten
 *   not-applied — the server refused before touching the file (4xx)
 *   ambiguous   — unknown (5xx, bad JSON, network error, timeout): the file may
 *                 or may not have been rewritten
 */
export type RewriteOutcome = 'ok' | 'not-applied' | 'ambiguous';

export interface RewriteDeps {
  /** Shown as message prefix, e.g. "Przywracanie .bak". */
  name: string;
  /** The POST. Throwing counts as 'ambiguous'. */
  action: () => Promise<RewriteOutcome>;
  reload: () => void;
  alert: (msg: string) => void;
  confirm: (msg: string) => boolean;
}

export type RewriteResult =
  | 'not-started' // pre-flush failed, action not run
  | 'not-applied' // server refused; fenced edits resumed
  | 'ambiguous' // page stays fenced, error shown
  | 'reloaded'
  | 'reload-declined'; // rewrite ok, other paths unsaved, user stayed; page stays fenced

export interface SaveQueue {
  /** Debounce a write of `body` to `path`; replaces any not-yet-sent body. */
  schedule(path: string, body: string): void;
  /**
   * Send every pending (and previously failed) body now, then resolve once
   * every PUT — including ones already in flight — has settled. Rejects if any
   * path is left unsaved. Fenced paths are skipped.
   */
  flush(): Promise<void>;
  /** Fire pending bodies immediately without waiting (beforeunload). */
  flushNow(opts?: SendOptions): void;
  /** Stop sending `path` (see header). Drops its pending/failed/chained bodies. */
  fence(path: string): void;
  /** End a fence; a body kept aside meanwhile is scheduled normally. */
  unfence(path: string): void;
  /** Drop every unsent body for `path`: pending, failed, chained after in-flight. */
  discard(path: string): void;
  /** Persistent error for a fenced path (shown until reload). */
  setFenceError(path: string, msg: string): void;
  /** Paths whose content the server does not have (for messages). */
  dirtyPaths(): string[];
  isDirty(): boolean;
  status(): SaveStatus;
  /**
   * Run a server action that rewrites `path`: flush, fence `path`, run the
   * POST, then reload (ok) / resume (not-applied) / stay fenced with an error
   * (ambiguous). See RewriteResult.
   */
  runRewrite(path: string, deps: RewriteDeps): Promise<RewriteResult>;
}

/** Map a rewrite POST response to an outcome. */
export function rewriteOutcomeFor(status: number, jsonOk: boolean): RewriteOutcome {
  if (status >= 200 && status < 300) return jsonOk ? 'ok' : 'ambiguous';
  // kronikarz-server validates input and refuses with 4xx before writing.
  if (status >= 400 && status < 500) return 'not-applied';
  return 'ambiguous';
}

interface Pending {
  body: string;
  timer: unknown; // null for a failed body re-queued by flush()
}

export function createSaveQueue(deps: SaveQueueDeps): SaveQueue {
  const pending = new Map<string, Pending>();
  const inflight = new Map<string, Promise<void>>();
  const failed = new Map<string, { body: string; error: string }>();
  const fenced = new Map<string, string | null>(); // path → latest body kept aside
  const fenceErrors = new Map<string, string>();
  const rewriting = new Set<string>(); // runRewrite in progress (incl. pre-flush)
  // Bumped by discard/fence: a send chained behind an in-flight PUT checks it
  // and is skipped if its body was invalidated meanwhile.
  const gen = new Map<string, number>();
  let lastStatus: SaveStatus = 'idle';
  let lastError: string | null = null;

  const genOf = (path: string) => gen.get(path) ?? 0;
  const bump = (path: string) => gen.set(path, genOf(path) + 1);

  function computeStatus(): { status: SaveStatus; error: string | null } {
    if (inflight.size) return { status: 'saving', error: null };
    if (pending.size) return { status: 'pending', error: null };
    const errs = [...fenceErrors.values(), ...[...failed.values()].map((f) => f.error)];
    if (errs.length) {
      const more = errs.length > 1 ? ` (+${errs.length - 1})` : '';
      return { status: 'error', error: errs[0]! + more };
    }
    // A body kept aside on a fenced path is unsaved → never report idle.
    for (const body of fenced.values()) if (body !== null) return { status: 'pending', error: null };
    return { status: 'idle', error: null };
  }

  function emit(): void {
    const { status, error } = computeStatus();
    if (status === lastStatus && error === lastError) return;
    lastStatus = status;
    lastError = error;
    deps.onStatus?.(status, error);
  }

  function fire(path: string, body: string, opts: SendOptions): void {
    const g = genOf(path);
    const prev = inflight.get(path);
    const p: Promise<void> = (prev ?? Promise.resolve())
      .then(async () => {
        if (genOf(path) !== g) return; // discarded/fenced while queued behind prev
        try {
          await deps.send(path, body, opts);
          failed.delete(path); // a later success supersedes an earlier failure
        } catch (err) {
          if (genOf(path) !== g || pending.has(path)) return; // superseded
          failed.set(path, { body, error: err instanceof Error ? err.message : String(err) });
        }
      })
      .finally(() => {
        if (inflight.get(path) === p) inflight.delete(path);
        emit();
      });
    inflight.set(path, p);
  }

  function clearPending(path: string): void {
    const entry = pending.get(path);
    if (!entry) return;
    if (entry.timer !== null) deps.clearTimer(entry.timer);
    pending.delete(path);
  }

  function sendAllPending(opts: SendOptions): void {
    for (const [path, entry] of pending) {
      if (entry.timer !== null) deps.clearTimer(entry.timer);
      pending.delete(path);
      fire(path, entry.body, opts);
    }
  }

  const q: SaveQueue = {
    schedule(path, body) {
      if (fenced.has(path)) {
        fenced.set(path, body); // kept aside, never sent while fenced
        emit();
        return;
      }
      clearPending(path);
      failed.delete(path); // the new full body supersedes a failed one
      const entry: Pending = { body, timer: null };
      entry.timer = deps.setTimer(() => {
        if (pending.get(path) !== entry) return;
        pending.delete(path);
        fire(path, entry.body, {});
        emit();
      }, deps.delayMs);
      pending.set(path, entry);
      emit();
    },

    async flush() {
      // Retry bodies whose last PUT failed (unless a newer one is pending).
      for (const [path, f] of failed) {
        if (!pending.has(path)) pending.set(path, { body: f.body, timer: null });
      }
      failed.clear();
      // Loop: edits made while we wait are flushed too.
      for (;;) {
        sendAllPending({});
        emit();
        if (!inflight.size) break;
        await Promise.allSettled([...inflight.values()]);
      }
      emit();
      if (failed.size) {
        const errs = [...failed.values()].map((f) => f.error).join('; ');
        throw new Error(`zapis nieudany: ${errs}`);
      }
    },

    flushNow(opts = {}) {
      sendAllPending(opts);
      emit();
    },

    fence(path) {
      // Keep the newest unsent body aside in case the rewrite does not happen.
      const kept = pending.get(path)?.body ?? failed.get(path)?.body ?? fenced.get(path) ?? null;
      clearPending(path);
      failed.delete(path);
      bump(path);
      fenced.set(path, kept);
      emit();
    },

    unfence(path) {
      if (!fenced.has(path)) return;
      const kept = fenced.get(path) ?? null;
      fenced.delete(path);
      fenceErrors.delete(path);
      if (kept !== null) q.schedule(path, kept);
      else emit();
    },

    discard(path) {
      clearPending(path);
      failed.delete(path);
      if (fenced.has(path)) fenced.set(path, null);
      bump(path);
      emit();
    },

    setFenceError(path, msg) {
      fenceErrors.set(path, msg);
      emit();
    },

    dirtyPaths() {
      const s = new Set<string>([...pending.keys(), ...inflight.keys(), ...failed.keys()]);
      for (const [path, body] of fenced) if (body !== null) s.add(path);
      return [...s];
    },

    isDirty() {
      return q.dirtyPaths().length > 0;
    },

    status() {
      return computeStatus().status;
    },

    async runRewrite(path, d) {
      // Re-entrancy: a fenced path waits for a reload (an earlier rewrite was
      // ok/ambiguous) or another rewrite on it is running. Starting again could
      // end in unfence() → the kept stale body PUT over a rewritten file.
      if (fenced.has(path) || rewriting.has(path)) {
        d.alert('Strona czeka na przeładowanie po poprzedniej operacji — przeładuj stronę.');
        return 'not-started';
      }
      rewriting.add(path);
      try {
        return await rewrite(path, d);
      } finally {
        rewriting.delete(path);
      }
    },
  };

  async function rewrite(path: string, d: RewriteDeps): Promise<RewriteResult> {
    const staleMsg = `${d.name}: plik zmieniony na serwerze — przeładuj stronę; zmiany tej strony nie są zapisywane`;
    try {
      await q.flush();
    } catch (err) {
      d.alert(
        `${d.name}: operacja nie została uruchomiona — nie udało się zapisać bieżących zmian ` +
        `(${err instanceof Error ? err.message : String(err)}). Spróbuj ponownie, gdy zapis zadziała.`,
      );
      return 'not-started';
    }
    q.fence(path);
    let outcome: RewriteOutcome;
    try {
      outcome = await d.action();
    } catch {
      outcome = 'ambiguous';
    }
    if (outcome === 'not-applied') {
      q.unfence(path);
      return 'not-applied';
    }
    if (outcome === 'ambiguous') {
      q.setFenceError(
        path,
        `${d.name} mogło się częściowo udać — przeładuj stronę; niezapisane zmiany tej strony nie zostały wysłane`,
      );
      return 'ambiguous';
    }
    // ok: edits to `path` were made against the old file → drop them.
    q.discard(path);
    let flushed = true;
    try {
      await q.flush();
    } catch {
      flushed = false;
    }
    if (!flushed) {
      // `path` itself is not listed: its kept-aside edits are stale anyway.
      const unsaved = q.dirtyPaths().filter((p) => p !== path);
      const ok = d.confirm(
        `${d.name}: gotowe, ale nie udało się zapisać zmian w:\n  ${unsaved.join('\n  ')}\n\n` +
        `OK = przeładuj teraz (te zmiany przepadną).\n` +
        `Anuluj = zostań; ta strona nie będzie już zapisywana do przeładowania.`,
      );
      if (!ok) {
        q.setFenceError(path, staleMsg);
        return 'reload-declined';
      }
      // User accepted the loss: drop everything so beforeunload does not ask again.
      for (const p of unsaved) q.discard(p);
    }
    // Edits made during the flush above were kept aside: drop them, and keep
    // a visible error in case the user picks "Stay" in a beforeunload prompt.
    q.discard(path);
    q.setFenceError(path, staleMsg);
    d.reload();
    return 'reloaded';
  }
  return q;
}

// Debounced auto-save queue, independent of React/DOM so it can be unit-tested
// with `node --test`. store.ts owns the single instance.
//
// Every body is the full serialized file, so for a given path the latest body
// always wins. Per path:
//   pending  — debounce timer running, body not sent yet
//   inflight — PUT sent, not settled; PUTs to one path are chained, never parallel
//   failed   — last PUT failed and no newer body superseded it; a PUT refused
//              with 409 busy (server job on the file) is failed too, shown as
//              "zapis czeka", and re-sent by a timer every busyRetryMs
//   conflict — the server answered 409 (file changed outside this tab, its
//              ETag no longer matches): the newest body is kept, never sent
//              again and not retried by flush — only a reload resolves it
//   fenced   — the server is rewriting / has rewritten the file (restore-bak…):
//              bodies scheduled for it are kept aside and NEVER sent, so a body
//              built from the old file cannot land over the new one. A fence
//              ends only with a page reload, or when the rewrite clearly did
//              not happen (then the kept body is scheduled normally).
// isDirty() is true while the server lacks something the user sees.
//
// Optimistic concurrency: the queue remembers the server ETag per path (from
// the page load via setLoadedEtag, then from each successful PUT) and passes
// it to send() as If-Match.

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'error';

export interface SendOptions {
  /** Unload path: ask the transport to outlive the page (fetch keepalive). */
  keepalive?: boolean;
}

/** send() rejects with this when the server refuses the If-Match (HTTP 409). */
export class SaveConflictError extends Error {
  constructor(message = 'conflict') {
    super(message);
    this.name = 'SaveConflictError';
  }
}

/** Error shown for a path whose PUT hit a 409. */
export function conflictMessage(path: string): string {
  return `${path}: plik zmieniony poza tą kartą — przeładuj stronę; zmiany nie zostały zapisane`;
}

/**
 * send() rejects with this on 409 `{error:'busy'}`: a server job (pipeline
 * step, vision) is rewriting the file. Not a conflict — the body is kept and
 * re-sent every busyRetryMs; once the job ends, the retry either lands (job
 * left the file alone) or gets a real conflict (job changed it → reload).
 */
export class SaveBusyError extends Error {
  constructor(message = 'busy') {
    super(message);
    this.name = 'SaveBusyError';
  }
}

/** Status shown for a path whose PUT waits for a server job. */
export function busyMessage(path: string): string {
  return `${path}: strona zajęta przez zadanie na serwerze — zapis czeka`;
}

/** Transport for SaveQueue.updateFile (GET + conditional PUT of one file). */
export interface FileIO {
  get(path: string): Promise<{ status: number; text: string; etag: string | null }>;
  /** `busy`: the 409 was `{error:'busy'}` (server job on the file), not a conflict. */
  put(path: string, body: string, ifMatch: string | undefined): Promise<{ status: number; etag: string | null; busy?: boolean }>;
}

/**
 * Result of SaveQueue.updateFile:
 *   ok          — written
 *   unchanged   — mutate() returned null, nothing written
 *   not-started — not attempted: unsaved edits could not be flushed, or the
 *                 path is fenced (waiting for a reload); stop a batch
 *   error       — this file was not written (404, 409, parse error, …)
 */
export type UpdateResult =
  | { status: 'ok' }
  | { status: 'unchanged' }
  | { status: 'not-started'; error: string }
  | { status: 'error'; error: string };

export interface SaveQueueDeps {
  /**
   * Write `body` to `path`, with `If-Match: ifMatch` when given. Resolves with
   * the new ETag from the response (null/undefined if none). Must reject on
   * any failure (network or non-2xx); with SaveConflictError on 409, with
   * SaveBusyError on 409 `{error:'busy'}`.
   */
  send: (path: string, body: string, opts: SendOptions, ifMatch?: string) => Promise<string | null | void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  delayMs: number;
  /** Retry interval for a PUT refused with SaveBusyError (default 3000 ms). */
  busyRetryMs?: number;
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
  /**
   * ETag of `path` as just loaded by GET. `ticket` is loadTicket(path) taken
   * before that GET; the tag is ignored if the path is dirty or a PUT of it
   * completed since (the GET may predate it).
   */
  setLoadedEtag(path: string, etag: string | null, ticket: number): void;
  /** Take before a GET whose ETag goes to setLoadedEtag. */
  loadTicket(path: string): number;
  /** Last known server ETag of `path` (sent as If-Match). */
  etag(path: string): string | undefined;
  /** True while `path` waits for a reload after a server-side rewrite. */
  isFenced(path: string): boolean;
  /**
   * Read-modify-write of a file outside the debounced auto-save (e.g. another
   * page of the package): flush pending saves, GET, `mutate(text)` → new body
   * or null (no change), PUT with If-Match of that GET. A 409 is an error,
   * never retried. The new ETag is not given to the auto-save queue (see
   * implementation): a body the queue has for the path then gets a 409.
   */
  updateFile(path: string, mutate: (text: string) => string | null, io: FileIO): Promise<UpdateResult>;
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
  const conflicts = new Map<string, { body: string; error: string }>();
  const etags = new Map<string, string>();
  const putsDone = new Map<string, number>(); // successful PUTs per path (load tickets)
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
    const errs = [
      ...fenceErrors.values(),
      ...[...conflicts.values()].map((c) => c.error),
      ...[...failed.values()].map((f) => f.error),
    ];
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
        // A body chained behind a PUT that hit 409 would hit it too.
        if (conflicts.has(path)) {
          conflicts.set(path, { body, error: conflicts.get(path)!.error });
          return;
        }
        try {
          // Read the tag now, not at fire(): a chained PUT uses the previous one's result.
          const tag = await deps.send(path, body, opts, etags.get(path));
          if (typeof tag === 'string' && tag) etags.set(path, tag);
          else etags.delete(path); // unknown → next PUT unconditional, never a stale tag
          putsDone.set(path, (putsDone.get(path) ?? 0) + 1);
          failed.delete(path); // a later success supersedes an earlier failure
        } catch (err) {
          if (genOf(path) !== g) return; // superseded
          if (err instanceof SaveConflictError) {
            // Keep the newest body (a pending one would 409 as well) and stop.
            const newest = pending.get(path)?.body ?? body;
            clearPending(path);
            failed.delete(path);
            conflicts.set(path, { body: newest, error: conflictMessage(path) });
            return;
          }
          if (pending.has(path)) return; // superseded
          if (err instanceof SaveBusyError) {
            // Unsaved like a failure (flush retries it, and reports it), plus
            // its own retry timer while the server job runs.
            const entry = { body, error: busyMessage(path) };
            failed.set(path, entry);
            deps.setTimer(() => {
              if (failed.get(path) !== entry || pending.has(path) || inflight.has(path)) return;
              failed.delete(path);
              fire(path, body, {});
              emit();
            }, deps.busyRetryMs ?? 3000);
            return;
          }
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
      const c = conflicts.get(path);
      if (c) {
        conflicts.set(path, { body, error: c.error }); // kept, never sent
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
      // Conflicted paths are not retried (they would 409 again) but still unsaved.
      if (failed.size || conflicts.size) {
        const errs = [...conflicts.values(), ...failed.values()].map((f) => f.error).join('; ');
        throw new Error(`zapis nieudany: ${errs}`);
      }
    },

    flushNow(opts = {}) {
      sendAllPending(opts);
      emit();
    },

    fence(path) {
      // Keep the newest unsent body aside in case the rewrite does not happen.
      const kept =
        pending.get(path)?.body ?? failed.get(path)?.body ?? conflicts.get(path)?.body ?? fenced.get(path) ?? null;
      clearPending(path);
      failed.delete(path);
      conflicts.delete(path);
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
      conflicts.delete(path);
      if (fenced.has(path)) fenced.set(path, null);
      bump(path);
      emit();
    },

    setFenceError(path, msg) {
      fenceErrors.set(path, msg);
      emit();
    },

    setLoadedEtag(path, etag, ticket) {
      if (q.dirtyPaths().includes(path) || (putsDone.get(path) ?? 0) !== ticket) return;
      if (etag) etags.set(path, etag);
      else etags.delete(path);
    },

    loadTicket(path) {
      return putsDone.get(path) ?? 0;
    },

    etag(path) {
      return etags.get(path);
    },

    isFenced(path) {
      return fenced.has(path) || rewriting.has(path);
    },

    async updateFile(path, mutate, io) {
      const fencedMsg = `${path}: strona czeka na przeładowanie po operacji na serwerze — przeładuj stronę`;
      if (q.isFenced(path)) return { status: 'not-started', error: fencedMsg };
      try {
        await q.flush();
      } catch (err) {
        return {
          status: 'not-started',
          error: `nie udało się zapisać bieżących zmian (${err instanceof Error ? err.message : String(err)})`,
        };
      }
      if (q.isFenced(path)) return { status: 'not-started', error: fencedMsg };
      try {
        const got = await io.get(path);
        if (got.status === 404) return { status: 'error', error: `${path}: brak pliku` };
        if (got.status < 200 || got.status >= 300) return { status: 'error', error: `GET ${path} → ${got.status}` };
        const body = mutate(got.text);
        if (body === null) return { status: 'unchanged' };
        if (q.isFenced(path)) return { status: 'not-started', error: fencedMsg };
        const r = await io.put(path, body, got.etag ?? undefined);
        if (r.status === 409 && r.busy) {
          return { status: 'error', error: `${path}: strona zajęta przez zadanie na serwerze — nie zapisano, spróbuj po jego zakończeniu` };
        }
        if (r.status === 409) {
          return { status: 'error', error: `${path}: plik zmieniony w międzyczasie (inna karta lub zapis) — nie zapisano` };
        }
        if (r.status < 200 || r.status >= 300) return { status: 'error', error: `PUT ${path} → ${r.status}` };
        // The new ETag is NOT handed to the auto-save queue: whatever the
        // queue (or the page in the store) holds for `path` was built without
        // this change, so its next PUT must get a 409, not silently drop it.
        // A fresh tag comes with the next load of the page (loader GET).
        return { status: 'ok' };
      } catch (err) {
        return { status: 'error', error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
      }
    },

    dirtyPaths() {
      const s = new Set<string>([...pending.keys(), ...inflight.keys(), ...failed.keys(), ...conflicts.keys()]);
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

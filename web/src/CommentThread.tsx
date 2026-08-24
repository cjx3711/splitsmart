/**
 * The comment thread on an expense. One component, both shells.
 *
 * The guest page passes its own three functions, because a guest link is live-only
 * (docs/GUEST.md) and talks to /api/v1/guest. The logged-in page passes NOTHING and
 * gets the offline path: the thread is read from the Dexie mirror and a new comment
 * goes into the outbox, so writing one at a restaurant table with no signal works.
 * Either way the conversation itself, and the rule that a system comment is quieter
 * than a real one, exists once.
 *
 * A comment is not part of the expense. It has no `version`, it cannot conflict,
 * and posting one must never bump `expenses.version` - otherwise an offline note
 * would fight an offline edit of the split. There is no edit, only create and
 * delete.
 *
 * Two kinds of row, as they come off the wire:
 *
 *   user    somebody typed it. Their own are deletable, nobody else's are.
 *   system  generated when the bill was edited, deleted or restored. Muted, no
 *           avatar emphasis, no delete. This is what answers "why is this 8.99".
 *
 * No markdown, and no rich text: a comment on a restaurant bill is a sentence.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { displayName, type Comment } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { useComments } from "./localData.ts";
import { useSync } from "./sync/SyncProvider.tsx";
import { ulid } from "../../src/domain/ulid.ts";
import { Skeleton } from "./Skeleton.tsx";

export interface CommentThreadApi {
  list: (expenseId: string) => Promise<{ comments: Comment[] }>;
  add: (expenseId: string, content: string) => Promise<unknown>;
  remove: (commentId: string) => Promise<unknown>;
}

export function CommentThread({
  expenseId,
  currentUserId,
  api,
}: {
  expenseId: string;
  /** Whose comments get a delete button, and who reads as "You". */
  currentUserId: string;
  /**
   * The guest shell's live-only functions. Omit them for the logged-in shell,
   * which reads the mirror and queues writes.
   */
  api?: CommentThreadApi;
}) {
  const [fetched, setFetched] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { engine } = useSync();

  // Both hooks always run - React forbids a conditional hook - but only one of
  // them is the source. Passing `undefined` makes the live query a no-op.
  const local = useComments(api ? undefined : expenseId);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const result = await api.list(expenseId);
      setFetched(result.comments);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the comments");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api object is a literal at the call site
  }, [expenseId, api !== undefined]);

  useEffect(() => {
    void load();
  }, [load]);

  const comments = api ? fetched : (local?.comments ?? null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (content === "") return;

    setBusy(true);
    setError(null);
    try {
      if (api) {
        await api.add(expenseId, content);
        await load();
      } else {
        // The client mints the comment ULID, so a retry of a lost response is the
        // same comment rather than a second one.
        if (!engine) throw new Error("Not ready to save yet.");
        await engine.enqueue({
          kind: "comment.create",
          id: ulid(),
          payload: { expenseId, content },
        });
      }
      // Cleared only once the write is recorded - on the server, or in the outbox -
      // so a failure does not lose what somebody typed.
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that comment");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(commentId: string) {
    setBusy(true);
    setError(null);
    try {
      if (api) {
        await api.remove(commentId);
        await load();
      } else {
        if (!engine) throw new Error("Not ready to save yet.");
        await engine.enqueue({ kind: "comment.delete", id: commentId });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that comment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Comments</h2>

      {error && <p className="error">{error}</p>}

      {comments === null ? (
        <Skeleton kind="comments" />
      ) : comments.length === 0 ? (
        <p className="empty">Nothing said about this one yet.</p>
      ) : (
        <div className="comments">
          {comments.map((comment) => {
            const mine = comment.author.id === currentUserId;
            const name = mine
              ? "You"
              : displayName(comment.author);

            if (comment.kind === "system") {
              return (
                <div key={comment.id} className="comment comment-system">
                  {/* Pre-wrapped: the server writes one change per line, and
                      reflowing them into a paragraph loses the diff. */}
                  <div className="comment-body">{comment.content}</div>
                  <time className="comment-time">{formatWhen(comment.createdAt)}</time>
                </div>
              );
            }

            return (
              <div key={comment.id} className="comment">
                <Avatar
                  id={comment.author.id}
                  name={comment.author.name}
                  nickname={comment.author.nickname}
                  iconLetters={comment.author.iconLetters}
                  iconEmoji={comment.author.iconEmoji}
                  iconHue={comment.author.iconHue}
                  iconPattern={comment.author.iconPattern}
                  size={30}
                />
                <div className="comment-main">
                  <div className="comment-meta">
                    <strong>{name}</strong>
                    <time className="comment-time">{formatWhen(comment.createdAt)}</time>
                  </div>
                  <div className="comment-body">{comment.content}</div>
                </div>
                {mine && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => void handleDelete(comment.id)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <form className="comment-composer" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="comment-content">
          Add a comment
        </label>
        <input
          id="comment-content"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment"
          maxLength={5000}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          {busy ? "Posting…" : "Post"}
        </button>
      </form>
    </>
  );
}

/**
 * Comment timestamps come back in SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) or as an
 * ISO string from an import. Both are made explicit before parsing, because a
 * bare space-separated string is treated as LOCAL time by some browsers and UTC
 * by others, which shifts every imported comment by the timezone offset.
 */
function formatWhen(value: string): string {
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

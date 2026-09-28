import { Skeleton, type SkeletonKind } from "./Skeleton.tsx";
import { useSync } from "./sync/SyncProvider.tsx";

/** A failed sync needs an actionable state, not an indefinite loading animation. */
export function DataLoading({ kind = "page" }: { kind?: SkeletonKind }) {
  const { status, syncNow } = useSync();
  if (!status?.lastError && status?.online !== false) return <Skeleton kind={kind} />;

  return (
    <div className="card stack" role="alert">
      <h2>Could not load your data</h2>
      <p>
        {status?.online === false
          ? "Connect to the internet to finish loading this device’s copy."
          : "The last sync failed. Try again after the server is available."}
      </p>
      {status?.lastError && <details><summary>Error details</summary><p>{status.lastError}</p></details>}
      <button type="button" className="secondary inline" onClick={syncNow} disabled={status?.syncing || status?.online === false}>
        {status?.syncing ? "Retrying…" : "Try again"}
      </button>
    </div>
  );
}

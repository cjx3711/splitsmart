/**
 * Page-shaped placeholders while the mirror or a network fetch is still
 * answering. Each kind follows the layout of the screen it stands in for —
 * summary cells, expense rows, avatars — so the page does not collapse to a
 * "Loading…" line and then jump.
 *
 * The sheen is a left-to-right sweep across the bone, like a ledger column
 * being filled in. Reduced motion is handled globally in styles.css.
 */
import type { CSSProperties, ReactNode } from "react";

export type SkeletonKind =
  | "page"
  | "dashboard"
  | "list"
  | "people"
  | "expenses"
  | "expenseList"
  | "activity"
  | "group"
  | "friend"
  | "expense"
  | "series"
  | "comments"
  | "links"
  | "admin"
  | "adminUser"
  | "adminBackups"
  | "form"
  | "auth"
  | "nav";

const TITLES = ["56%", "68%", "47%", "61%", "52%", "72%", "43%", "64%"];
const SUBS = ["34%", "41%", "28%", "38%", "45%", "31%"];
const AMOUNTS = ["4.4rem", "3.7rem", "5rem", "4.1rem", "3.5rem"];
const NAVS = ["72%", "58%", "81%", "64%", "49%"];

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function delay(i: number): CSSProperties {
  return { ["--sk-i" as string]: i };
}

function Bone({
  width = "100%",
  height = "0.75em",
  radius = 4,
  circle = false,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  circle?: boolean;
  className?: string;
}) {
  const w = typeof width === "number" ? `${width}px` : width;
  const h = typeof height === "number" ? `${height}px` : height;
  return (
    <span
      className={`sk${className ? ` ${className}` : ""}`}
      style={{
        width: w,
        height: h,
        borderRadius: circle ? "50%" : radius,
      }}
    />
  );
}

function AvatarBone({ size = 34 }: { size?: number }) {
  return <Bone width={size} height={size} circle />;
}

function PersonRow({ i, compact = false }: { i: number; compact?: boolean }) {
  return (
    <div className="list-item" style={delay(i)}>
      <AvatarBone size={compact ? 28 : 34} />
      <div className="list-item-body sk-lines">
        <Bone width={TITLES[i % TITLES.length]} height={compact ? "0.7em" : "0.85em"} />
        <Bone width={SUBS[i % SUBS.length]} height="0.65em" />
      </div>
      <div className="sk-figures">
        <Bone width={AMOUNTS[i % AMOUNTS.length]} height="0.8em" />
      </div>
    </div>
  );
}

function GroupRow({ i }: { i: number }) {
  return (
    <div className="list-item" style={delay(i)}>
      <div className="list-item-body sk-lines">
        <Bone width={TITLES[i % TITLES.length]} height="0.85em" />
        <Bone width={SUBS[(i + 2) % SUBS.length]} height="0.65em" />
      </div>
    </div>
  );
}

function ExpenseRow({ i }: { i: number }) {
  return (
    <div className="list-item" style={delay(i)}>
      <div className="list-item-body sk-lines">
        <Bone width={TITLES[i % TITLES.length]} height="0.85em" />
        <Bone width="9.5rem" height="0.65em" />
      </div>
      <div className="sk-figures">
        <Bone width={AMOUNTS[i % AMOUNTS.length]} height="0.85em" />
        <Bone width="3.2rem" height="0.6em" />
      </div>
    </div>
  );
}

function ActivityRow({ i }: { i: number }) {
  return (
    <div className="list-item" style={delay(i)}>
      <AvatarBone size={30} />
      <div className="list-item-body sk-lines">
        <Bone width={TITLES[(i + 1) % TITLES.length]} height="0.8em" />
        <Bone width="7.5rem" height="0.65em" />
      </div>
      <div className="sk-figures">
        <Bone width={AMOUNTS[i % AMOUNTS.length]} height="0.8em" />
      </div>
    </div>
  );
}

function CommentRow({ i }: { i: number }) {
  return (
    <div className="comment" style={delay(i)}>
      <AvatarBone size={28} />
      <div className="comment-main sk-lines">
        <Bone width="6.5rem" height="0.7em" />
        <Bone width={TITLES[i % TITLES.length]} height="0.75em" />
      </div>
    </div>
  );
}

function FilterBar() {
  return (
    <div className="filters" aria-hidden="true">
      <Bone width="16rem" height="2.25rem" radius={6} />
      <Bone width="5.75rem" height="2.25rem" radius={6} />
    </div>
  );
}

function PageHeadBones({ actions = 2 }: { actions?: number }) {
  return (
    <div className="page-head">
      <div className="sk-lines">
        <Bone width="11rem" height="1.55rem" />
        <Bone width="16rem" height="0.75em" />
      </div>
      <div className="page-actions">
        {range(actions).map((i) => (
          <Bone key={i} width={i === actions - 1 ? "7.4rem" : "5.8rem"} height="2.25rem" radius={6} />
        ))}
      </div>
    </div>
  );
}

function CrumbBones() {
  return (
    <nav className="crumbs" aria-hidden="true">
      <Bone width="1.1rem" height="0.85em" />
      <Bone width="4.2rem" height="0.75em" />
      <Bone width="7rem" height="0.75em" />
    </nav>
  );
}

function ListFrame({ children }: { children: ReactNode }) {
  return <div className="list">{children}</div>;
}

function DashboardBody() {
  return (
    <>
      <div className="summary">
        {["Net position", "You owe", "You are owed"].map((label) => (
          <div key={label}>
            <span className="eyebrow">{label}</span>
            <div className="sk-lines" style={{ gap: "0.45rem" }}>
              <Bone width="7.5rem" height="1.25rem" />
              <Bone width="5rem" height="0.7em" />
            </div>
          </div>
        ))}
      </div>
      <div className="columns" style={{ marginTop: "1.75rem" }}>
        <section>
          <h2 style={{ marginTop: 0 }}>You owe</h2>
          <ListFrame>
            {range(3).map((i) => (
              <PersonRow key={i} i={i} compact />
            ))}
          </ListFrame>
        </section>
        <section>
          <h2 style={{ marginTop: 0 }}>You are owed</h2>
          <ListFrame>
            {range(3).map((i) => (
              <PersonRow key={i} i={i + 3} compact />
            ))}
          </ListFrame>
        </section>
      </div>
    </>
  );
}

function GroupBody() {
  return (
    <>
      <CrumbBones />
      <div className="page-head">
        <div className="sk-identity">
          <Bone width={28} height={28} radius={6} />
          <div className="sk-lines">
            <Bone width="12rem" height="1.55rem" />
            <Bone width="16rem" height="0.75em" />
          </div>
        </div>
        <div className="page-actions">
          <Bone width="5.4rem" height="2.25rem" radius={6} />
          <Bone width="5.8rem" height="2.25rem" radius={6} />
          <Bone width="7.4rem" height="2.25rem" radius={6} />
        </div>
      </div>
      <div className="split-page">
        <aside className="split-aside">
          <h2 style={{ marginTop: 0 }}>Balances</h2>
          <ListFrame>
            {range(4).map((i) => (
              <PersonRow key={i} i={i} compact />
            ))}
          </ListFrame>
        </aside>
        <div className="split-body">
          <h2 style={{ marginTop: 0 }}>Expenses</h2>
          <FilterBar />
          <ListFrame>
            {range(6).map((i) => (
              <ExpenseRow key={i} i={i} />
            ))}
          </ListFrame>
        </div>
      </div>
    </>
  );
}

function FriendBody() {
  return (
    <>
      <CrumbBones />
      <div className="page-head">
        <div className="sk-identity">
          <AvatarBone size={44} />
          <div className="sk-lines">
            <Bone width="10rem" height="1.55rem" />
            <Bone width="13rem" height="0.75em" />
          </div>
        </div>
        <div className="page-actions">
          <Bone width="5.8rem" height="2.25rem" radius={6} />
          <Bone width="7.4rem" height="2.25rem" radius={6} />
        </div>
      </div>
      <div className="friend-page">
        <aside className="friend-aside">
          <div className="card sk-lines" style={{ gap: "0.55rem" }}>
            <span className="eyebrow">Between you</span>
            <Bone width="8rem" height="1.2rem" />
            <Bone width="6rem" height="0.75em" />
            <Bone width="9rem" height="0.75em" />
          </div>
        </aside>
        <div className="friend-body">
          <h2 style={{ marginTop: 0 }}>Shared expenses</h2>
          <FilterBar />
          <ListFrame>
            {range(6).map((i) => (
              <ExpenseRow key={i} i={i} />
            ))}
          </ListFrame>
        </div>
      </div>
    </>
  );
}

function ExpenseBody() {
  return (
    <>
      <CrumbBones />
      <PageHeadBones />
      <div className="card sk-lines" style={{ gap: "0.55rem" }}>
        <span className="eyebrow">Amount</span>
        <Bone width="8.5rem" height="1.6rem" />
        <Bone width="12rem" height="0.75em" />
      </div>
      <h2>Who paid, who owes</h2>
      <ListFrame>
        {range(3).map((i) => (
          <PersonRow key={i} i={i} compact />
        ))}
      </ListFrame>
      <h2>Comments</h2>
      <div className="comments">
        {range(2).map((i) => (
          <CommentRow key={i} i={i} />
        ))}
      </div>
    </>
  );
}

function AdminUserBody() {
  return (
    <>
      <div className="card stack" style={{ marginBottom: "1rem" }}>
        <Bone width="14rem" height="0.8em" />
        <Bone width="11rem" height="2.1rem" radius={6} />
      </div>
      <h2>Expenses added (30 days)</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <Bone width="100%" height={120} radius={6} />
      </div>
      <h2>Counts</h2>
      <div className="summary admin-counts">
        {range(7).map((i) => (
          <div key={i} style={delay(i)}>
            <Bone width="70%" height="0.7em" />
            <Bone width="3rem" height="1.3rem" />
          </div>
        ))}
      </div>
    </>
  );
}

function AdminBackupsBody() {
  return (
    <>
      <div className="admin-backup-cards">
        {range(3).map((i) => (
          <div key={i} className={`admin-backup-card${i === 2 ? " admin-backup-card-wide" : ""}`} style={delay(i)}>
            <div className="sk-lines" style={{ gap: "0.5rem" }}>
              <Bone width="7rem" height="0.8em" />
              <Bone width="9rem" height="1.1rem" />
              <Bone width="12rem" height="0.7em" />
            </div>
          </div>
        ))}
      </div>
      <ListFrame>
        {range(5).map((i) => (
          <GroupRow key={i} i={i} />
        ))}
      </ListFrame>
    </>
  );
}

function AuthBody() {
  return (
    <div className="sk-lines" style={{ gap: "0.85rem" }}>
      <Bone width="12rem" height="1.6rem" />
      <Bone width="100%" height="0.8em" />
      <Bone width="80%" height="0.8em" />
      <Bone width="100%" height="2.4rem" radius={6} />
      <Bone width="100%" height="2.4rem" radius={6} />
      <Bone width="100%" height="2.4rem" radius={6} />
    </div>
  );
}

export function NavSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="sk-nav" aria-hidden="true">
      {range(rows).map((i) => (
        <div key={i} className="sk-nav-row" style={delay(i)}>
          <Bone width={7} height={7} circle />
          <Bone width={NAVS[i % NAVS.length]} height="0.7rem" />
        </div>
      ))}
    </div>
  );
}

export function Skeleton({
  kind,
  label = "Loading",
  rows,
}: {
  kind: SkeletonKind;
  label?: string;
  rows?: number;
}) {
  const n = rows ?? defaultRows(kind);
  let body: ReactNode;
  switch (kind) {
    case "page":
      body = (
        <>
          <PageHeadBones />
          <DashboardBody />
        </>
      );
      break;
    case "dashboard":
      body = <DashboardBody />;
      break;
    case "list":
      body = (
        <ListFrame>
          {range(n).map((i) => (
            <GroupRow key={i} i={i} />
          ))}
        </ListFrame>
      );
      break;
    case "people":
      body = (
        <ListFrame>
          {range(n).map((i) => (
            <PersonRow key={i} i={i} />
          ))}
        </ListFrame>
      );
      break;
    case "expenses":
      body = (
        <>
          <FilterBar />
          <ListFrame>
            {range(n).map((i) => (
              <ExpenseRow key={i} i={i} />
            ))}
          </ListFrame>
        </>
      );
      break;
    case "expenseList":
      body = (
        <ListFrame>
          {range(n).map((i) => (
            <ExpenseRow key={i} i={i} />
          ))}
        </ListFrame>
      );
      break;
    case "activity":
      body = (
        <ListFrame>
          {range(n).map((i) => (
            <ActivityRow key={i} i={i} />
          ))}
        </ListFrame>
      );
      break;
    case "group":
      body = <GroupBody />;
      break;
    case "friend":
      body = <FriendBody />;
      break;
    case "expense":
      body = <ExpenseBody />;
      break;
    case "series":
      body = (
        <>
          <CrumbBones />
          <PageHeadBones actions={1} />
          <ListFrame>
            {range(n).map((i) => (
              <ExpenseRow key={i} i={i} />
            ))}
          </ListFrame>
        </>
      );
      break;
    case "comments":
      body = (
        <div className="comments">
          {range(n).map((i) => (
            <CommentRow key={i} i={i} />
          ))}
        </div>
      );
      break;
    case "links":
      body = (
        <div className="stack" style={{ gap: "0.85rem" }}>
          {range(n).map((i) => (
            <div key={i} className="sk-lines" style={delay(i)}>
              <Bone width="11rem" height="0.85em" />
              <Bone width="100%" height="2.1rem" radius={6} />
            </div>
          ))}
        </div>
      );
      break;
    case "admin":
      body = (
        <ListFrame>
          {range(n).map((i) => (
            <div key={i} className="list-item admin-user-row" style={delay(i)}>
              <div className="sk-lines" style={{ flex: 1 }}>
                <Bone width="9rem" height="0.85em" />
                <Bone width="12rem" height="0.65em" />
              </div>
              <Bone width="8rem" height={40} radius={6} />
            </div>
          ))}
        </ListFrame>
      );
      break;
    case "adminUser":
      body = <AdminUserBody />;
      break;
    case "adminBackups":
      body = <AdminBackupsBody />;
      break;
    case "form":
      body = (
        <>
          <CrumbBones />
          <div className="page-head">
            <Bone width="8rem" height="1.55rem" />
          </div>
          <div className="card stack" style={{ gap: "0.85rem" }}>
            <Bone width="4rem" height="0.7em" />
            <Bone width="100%" height="2.4rem" radius={6} />
            <Bone width="7rem" height="0.7em" />
            <Bone width="100%" height="2.4rem" radius={6} />
            <Bone width="5rem" height="2.25rem" radius={6} />
          </div>
          <div className="card" style={{ marginTop: "1rem" }}>
            <div className="sk-lines" style={{ gap: "0.45rem" }}>
              <Bone width="9rem" height="0.85em" />
              <Bone width="70%" height="0.7em" />
            </div>
          </div>
          <h2>Members</h2>
          <ListFrame>
            {range(4).map((i) => (
              <PersonRow key={i} i={i} compact />
            ))}
          </ListFrame>
        </>
      );
      break;
    case "auth":
      body = <AuthBody />;
      break;
    case "nav":
      body = <NavSkeleton rows={n} />;
      break;
  }

  return (
    <div className="sk-page" role="status" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>
      {body}
    </div>
  );
}

function defaultRows(kind: SkeletonKind): number {
  switch (kind) {
    case "list":
    case "people":
    case "expenses":
    case "expenseList":
    case "activity":
    case "series":
      return 6;
    case "comments":
      return 3;
    case "links":
      return 2;
    case "admin":
      return 5;
    case "nav":
      return 4;
    default:
      return 6;
  }
}

/**
 * Category icons and the picker that uses them.
 *
 * THE ICONS ARE OURS. Ids 1–50 are Splitwise's; extras start at 51. See
 * `src/db/categories.ts`. This file keys icons off those ids rather than off
 * names, which are duplicated ("Other" appears seven times, "General" twice)
 * and would collide. A category with no entry falls back to a generic tag
 * instead of rendering nothing, so adding a category can never leave a blank
 * square.
 *
 * Icons come from lucide via react-icons. Splitwise shows a receipt glyph and
 * nothing else; a per-category icon is the one place this UI is deliberately
 * better rather than merely compatible.
 */
import { useEffect, useMemo, useState } from "react";
import {
  LuArmchair, LuBaby, LuBanknote, LuBedDouble, LuBike, LuBookOpen, LuBrain,
  LuBriefcase, LuBuilding2, LuBus, LuCar, LuCarTaxiFront, LuCircleHelp,
  LuCoffee, LuCompass, LuConciergeBell, LuDroplets, LuDumbbell, LuFerrisWheel,
  LuFileText, LuFilm, LuFlame, LuFlower2, LuFuel, LuGamepad2, LuGift, LuGlasses,
  LuGraduationCap, LuHammer, LuHeartHandshake, LuHotel, LuHouse, LuKey,
  LuLandmark, LuLaptop, LuLightbulb, LuMapPin, LuMartini, LuMonitor, LuMusic,
  LuPackage, LuPaperclip, LuPawPrint, LuPill, LuPlane, LuReceipt, LuRepeat,
  LuSandwich, LuScissors, LuShieldCheck, LuShirt, LuShoppingBag,
  LuShoppingBasket, LuSmile, LuSparkles, LuSprayCan, LuSquareParking,
  LuStamp, LuStethoscope, LuTag, LuTicket, LuTrash2, LuTruck, LuTv,
  LuUtensils, LuWashingMachine, LuWine, LuWrench, LuZap,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { useLocalDb } from "./sync/SyncProvider.tsx";
import { useLiveQuery } from "dexie-react-hooks";

/** Leaf or parent id -> our glyph. A missing id falls back to LuTag. */
const ICONS: Record<number, IconType> = {
  // Utilities
  1: LuLightbulb, 48: LuSprayCan, 5: LuZap, 6: LuFlame, 11: LuLightbulb,
  37: LuTrash2, 8: LuTv, 7: LuDroplets,
  // Uncategorized
  2: LuReceipt, 18: LuReceipt,
  // Entertainment
  19: LuFilm, 20: LuGamepad2, 21: LuFilm, 22: LuMusic, 23: LuFilm, 24: LuDumbbell,
  68: LuTicket, 69: LuTv, 70: LuBookOpen, 71: LuWine, 72: LuSparkles, 73: LuFerrisWheel,
  // Food and drink
  25: LuUtensils, 13: LuUtensils, 12: LuShoppingBasket, 38: LuMartini, 26: LuUtensils,
  65: LuCoffee, 66: LuPackage, 67: LuSandwich,
  // Home
  27: LuHouse, 39: LuLaptop, 16: LuArmchair, 14: LuSprayCan, 17: LuHammer,
  4: LuLandmark, 28: LuHouse, 29: LuPawPrint, 3: LuKey, 30: LuConciergeBell,
  83: LuFlower2, 84: LuTruck,
  // Transportation
  31: LuCar, 46: LuBike, 32: LuBus, 15: LuCar, 33: LuFuel, 47: LuHotel,
  34: LuCar, 9: LuSquareParking, 35: LuPlane, 36: LuCarTaxiFront,
  74: LuMapPin, 75: LuStamp, 76: LuCar, 77: LuWrench,
  // Life
  40: LuCircleHelp, 50: LuBaby, 41: LuShirt, 49: LuGraduationCap, 42: LuGift,
  10: LuShieldCheck, 43: LuStethoscope, 44: LuCircleHelp, 45: LuBanknote,
  78: LuScissors, 79: LuPill, 80: LuHeartHandshake, 81: LuRepeat, 82: LuWashingMachine,
  89: LuBaby,
  // Travel
  51: LuCompass, 52: LuBedDouble, 53: LuFerrisWheel, 54: LuFileText, 55: LuGift,
  // Health
  56: LuStethoscope, 57: LuSmile, 58: LuBrain, 59: LuDumbbell, 60: LuGlasses,
  // Work
  61: LuBriefcase, 62: LuPaperclip, 63: LuMonitor, 64: LuBuilding2,
  // Shopping
  86: LuShoppingBag, 87: LuShoppingBag, 88: LuLaptop,
  // Payments are not a Splitwise category, but the expense list renders one.
  0: LuWrench,
};

/** Splitwise's "Uncategorized > General": what an expense gets by default. */
export const DEFAULT_CATEGORY_ID = 18;

export interface Category {
  id: number;
  parent_id: number | null;
  name: string;
}

let cached: Promise<Category[]> | null = null;

export function CategoryIcon({ id, size = 20 }: { id: number | null; size?: number }) {
  const Icon = (id !== null && ICONS[id]) || LuTag;
  return <Icon size={size} aria-hidden="true" />;
}

/** "Food and drink · Dining out", or just the parent name when that is the selection. */
export function categoryPath(categories: Category[], id: number | undefined): string | undefined {
  if (id === undefined) return undefined;
  const selected = categories.find((c) => c.id === id);
  if (!selected) return undefined;
  if (selected.parent_id === null) return selected.name;
  const parent = categories.find((c) => c.id === selected.parent_id);
  return parent ? `${parent.name} · ${selected.name}` : selected.name;
}

/**
 * The category list: mirror first, network as a refresh.
 *
 * The picker cannot render without them, so they ride along on bootstrap rather
 * than being a separate fetch that may never land.
 */
export function useCategories(): Category[] {
  const db = useLocalDb();
  const mirrored = useLiveQuery(() => (db ? db.categories.toArray() : []), [db]);
  const [fetched, setFetched] = useState<Category[]>([]);

  useEffect(() => {
    cached ??= api.listCategories().then((r) => r.categories).catch(() => []);
    let live = true;
    void cached.then((list) => {
      if (!live) return;
      setFetched(list);
      if (db && list.length > 0) {
        void db.categories.bulkPut(
          list.map((c) => ({
            id: c.id,
            parentId: c.parent_id,
            name: c.name,
            icon: null,
            isDefault: c.id === DEFAULT_CATEGORY_ID,
          })),
        );
      }
    });
    return () => {
      live = false;
    };
  }, [db]);

  const fromMirror =
    mirrored && mirrored.length > 0
      ? mirrored.map((row) => ({
          id: row.id,
          parent_id: row.parentId,
          name: row.name,
        }))
      : [];
  // A seed that added rows must win over a stale Dexie copy. bulkPut follows,
  // but the picker should not wait on it.
  if (fetched.length > fromMirror.length) return fetched;
  if (fromMirror.length > 0) return fromMirror;
  return fetched;
}

/**
 * Parent groups with their leaves. Shared by the expense form and the filter
 * dialog so the two cannot drift into different trees.
 */
export function CategoryPicker({
  value,
  onChange,
  allowAny = false,
  allowParent = false,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  /** Offer "Any category", for the filter dialog. */
  allowAny?: boolean;
  /** Selecting a parent means "this group" (filter) rather than a leaf (form). */
  allowParent?: boolean;
}) {
  const categories = useCategories();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const parents = categories.filter((c) => c.parent_id === null);
    return parents
      .map((parent) => ({
        parent,
        children: categories.filter((c) => c.parent_id === parent.id),
      }))
      .filter((group) => {
        if (!needle) return group.children.length > 0 || allowParent;
        const parentHit = group.parent.name.toLowerCase().includes(needle);
        const childHit = group.children.some((c) => c.name.toLowerCase().includes(needle));
        return parentHit || childHit;
      })
      .map((group) => {
        if (!needle || group.parent.name.toLowerCase().includes(needle)) return group;
        return {
          parent: group.parent,
          children: group.children.filter((c) => c.name.toLowerCase().includes(needle)),
        };
      });
  }, [allowParent, categories, needle]);

  return (
    <div className="category-grid-groups">
      {allowAny && (
        <button
          type="button"
          className={`category-option category-any${value === null ? " is-active" : ""}`}
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          Any category
        </button>
      )}
      <input
        type="search"
        className="category-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a category"
        aria-label="Find a category"
      />
      {groups.map(({ parent, children }) => (
        <section key={parent.id}>
          {allowParent ? (
            <button
              type="button"
              className={`category-group-title is-button${value === parent.id ? " is-active" : ""}`}
              aria-pressed={value === parent.id}
              onClick={() => onChange(parent.id)}
            >
              <CategoryIcon id={parent.id} size={16} />
              {parent.name}
            </button>
          ) : (
            <h3 className="category-group-title">
              <CategoryIcon id={parent.id} size={16} />
              {parent.name}
            </h3>
          )}
          <div className="category-grid">
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                className={`category-option${child.id === value ? " is-active" : ""}`}
                aria-pressed={child.id === value}
                onClick={() => onChange(child.id)}
              >
                <CategoryIcon id={child.id} size={20} />
                <span>{child.name}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {needle && groups.length === 0 && <p className="muted">No category matches that.</p>}
    </div>
  );
}

/**
 * The big icon square to the left of the description, and the dialog behind it.
 *
 * Splitwise puts a receipt there and opens a two-pane parent/child browser. The
 * nesting here is one <dialog> inside another, which the top layer handles for
 * free (no z-index, no portal).
 */
export function CategoryButton({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (id: number) => void;
}) {
  const categories = useCategories();
  const [open, setOpen] = useState(false);

  const selected = categories.find((c) => c.id === value);

  return (
    <>
      <button
        type="button"
        className="category-button"
        onClick={() => setOpen(true)}
        aria-label={`Category: ${selected?.name ?? "none"}. Change it.`}
        title={categoryPath(categories, value ?? undefined) ?? "Choose a category"}
      >
        <CategoryIcon id={value} size={26} />
      </button>

      <Modal open={open} title="Choose a category" onClose={() => setOpen(false)}>
        <CategoryPicker
          value={value}
          onChange={(id) => {
            if (id === null) return;
            onChange(id);
            setOpen(false);
          }}
        />
      </Modal>
    </>
  );
}

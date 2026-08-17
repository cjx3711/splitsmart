/**
 * Category icons and the picker that uses them.
 *
 * THE ICONS ARE OURS, THE IDS ARE SPLITWISE'S. `src/db/categories.ts` carries
 * Splitwise's real, non-sequential category ids because `category_id` passes
 * straight through the compat layer, so this file keys its icons off those ids
 * rather than off names, which are duplicated ("Other" appears seven times) and
 * would collide. A category with no entry falls back to a generic tag instead
 * of rendering nothing, so adding a category can never leave a blank square.
 *
 * Icons come from lucide via react-icons. Splitwise shows a receipt glyph and
 * nothing else; a per-category icon is the one place this UI is deliberately
 * better rather than merely compatible.
 */
import { useEffect, useState } from "react";
import {
  LuArmchair, LuBaby, LuBanknote, LuBike, LuBus, LuCar, LuCarTaxiFront,
  LuCircleHelp, LuConciergeBell, LuDroplets, LuDumbbell, LuFilm, LuFlame,
  LuFuel, LuGamepad2, LuGift, LuGraduationCap, LuHammer, LuHotel, LuHouse,
  LuKey, LuLandmark, LuLaptop, LuLightbulb, LuMartini, LuMusic, LuPawPrint,
  LuPlane, LuReceipt, LuShieldCheck, LuShirt, LuShoppingBasket, LuSprayCan,
  LuSquareParking, LuStethoscope, LuTag, LuTrash2, LuTv, LuUtensils, LuWrench,
  LuZap,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";

/** Splitwise's leaf id -> our glyph. Parents are keyed here too, for headings. */
const ICONS: Record<number, IconType> = {
  // Utilities
  1: LuLightbulb, 48: LuSprayCan, 5: LuZap, 6: LuFlame, 11: LuLightbulb,
  37: LuTrash2, 8: LuTv, 7: LuDroplets,
  // Uncategorized
  2: LuReceipt, 18: LuReceipt,
  // Entertainment
  19: LuFilm, 20: LuGamepad2, 21: LuFilm, 22: LuMusic, 23: LuFilm, 24: LuDumbbell,
  // Food and drink
  25: LuUtensils, 13: LuUtensils, 12: LuShoppingBasket, 38: LuMartini, 26: LuUtensils,
  // Home
  27: LuHouse, 39: LuLaptop, 16: LuArmchair, 14: LuSprayCan, 17: LuHammer,
  4: LuLandmark, 28: LuHouse, 29: LuPawPrint, 3: LuKey, 30: LuConciergeBell,
  // Transportation
  31: LuCar, 46: LuBike, 32: LuBus, 15: LuCar, 33: LuFuel, 47: LuHotel,
  34: LuCar, 9: LuSquareParking, 35: LuPlane, 36: LuCarTaxiFront,
  // Life
  40: LuCircleHelp, 50: LuBaby, 41: LuShirt, 49: LuGraduationCap, 42: LuGift,
  10: LuShieldCheck, 43: LuStethoscope, 44: LuCircleHelp, 45: LuBanknote,
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

export function CategoryIcon({ id, size = 20 }: { id: number | null; size?: number }) {
  const Icon = (id !== null && ICONS[id]) || LuTag;
  return <Icon size={size} aria-hidden="true" />;
}

/**
 * The category list, fetched once per page load and shared.
 *
 * 50 rows that change only when the database is reseeded; refetching them per
 * dialog would be three requests to render one icon.
 */
let cached: Promise<Category[]> | null = null;

export function useCategories(): Category[] {
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    cached ??= api.listCategories().then((r) => r.categories).catch(() => []);
    let live = true;
    void cached.then((list) => {
      if (live) setCategories(list);
    });
    return () => {
      live = false;
    };
  }, []);

  return categories;
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

  const parents = categories.filter((c) => c.parent_id === null);
  const selected = categories.find((c) => c.id === value);
  const parentOf = selected?.parent_id
    ? categories.find((c) => c.id === selected.parent_id)
    : undefined;

  return (
    <>
      <button
        type="button"
        className="category-button"
        onClick={() => setOpen(true)}
        aria-label={`Category: ${selected?.name ?? "none"}. Change it.`}
        title={
          selected
            ? `${parentOf ? `${parentOf.name} · ` : ""}${selected.name}`
            : "Choose a category"
        }
      >
        <CategoryIcon id={value} size={26} />
      </button>

      <Modal open={open} title="Choose a category" onClose={() => setOpen(false)}>
        <div className="category-grid-groups">
          {parents.map((parent) => (
            <section key={parent.id}>
              <h3 className="category-group-title">
                <CategoryIcon id={parent.id} size={16} />
                {parent.name}
              </h3>
              <div className="category-grid">
                {categories
                  .filter((c) => c.parent_id === parent.id)
                  .map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className={`category-option${child.id === value ? " is-active" : ""}`}
                      aria-pressed={child.id === value}
                      onClick={() => {
                        onChange(child.id);
                        setOpen(false);
                      }}
                    >
                      <CategoryIcon id={child.id} size={20} />
                      <span>{child.name}</span>
                    </button>
                  ))}
              </div>
            </section>
          ))}
        </div>
      </Modal>
    </>
  );
}

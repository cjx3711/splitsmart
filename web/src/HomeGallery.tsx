import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "./Modal.tsx";

/**
 * Screenshots on the marketing homepage.
 *
 * Copies of `smoke/baselines/png/<name>.png` and `<name>-mobile.png`, kept
 * under the same filenames so a later `yarn smoke -- --update` can drop straight
 * over the files in `web/src/assets/gallery/`. Login, settings, and the
 * marketing page itself are not in this set.
 */
const SHOTS: { file: string; caption: string; alt: string }[] = [
  {
    file: "dashboard.png",
    caption: "Dashboard",
    alt: "Dashboard showing net position in JPY and USD, with who you owe and who owes you listed separately.",
  },
  {
    file: "group-tokyo.png",
    caption: "A trip",
    alt: "Weekend in Tokyo group: balances in JPY, suggested settle-up transfers, and the trip's expenses.",
  },
  {
    file: "add-expense-dialog.png",
    caption: "Adding a bill",
    alt: "Add Expense dialog with description, amount, currency, and split types including equally and itemized.",
  },
  {
    file: "expense-detail.png",
    caption: "A bill",
    alt: "Trader Joe's run expense: total, who paid, who owes, and a comment thread.",
  },
  {
    file: "all-expenses.png",
    caption: "Every expense",
    alt: "All expenses list with search, group and category filters, and a mix of JPY and USD bills.",
  },
  {
    file: "guest-group.png",
    caption: "Opened from a link",
    alt: "Guest view of Weekend in Tokyo. No account; a banner offers to claim the history later.",
  },
];

const galleryFiles = import.meta.glob("./assets/gallery/*.png", {
  eager: true,
  import: "default",
}) as Record<string, string>;

function gallerySrc(file: string): string {
  const match = Object.entries(galleryFiles).find(([path]) =>
    path.endsWith(`/${file}`),
  );
  if (!match) throw new Error(`Missing gallery image: ${file}`);
  return match[1];
}

function mobileFile(file: string): string {
  return file.replace(/\.png$/, "-mobile.png");
}

const SLIDES = SHOTS.map((shot) => ({
  ...shot,
  src: gallerySrc(shot.file),
  srcMobile: gallerySrc(mobileFile(shot.file)),
}));
const LAST = SLIDES.length - 1;
const AUTOPLAY_MS = 5200;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function HomeGallery() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wheelLock = useRef(false);
  const indexRef = useRef(0);
  const startLeft = useRef(0);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const [hidden, setHidden] = useState(false);
  indexRef.current = index;

  const goTo = useCallback((next: number, behavior?: ScrollBehavior) => {
    const el = viewportRef.current;
    if (!el) return;
    const n = SLIDES.length;
    const wrapped = ((next % n) + n) % n;
    const from = Math.round(el.scrollLeft / Math.max(el.clientWidth, 1));
    const wrapping =
      (from === LAST && wrapped === 0) || (from === 0 && wrapped === LAST);
    el.scrollTo({
      left: wrapped * el.clientWidth,
      behavior:
        behavior ??
        (wrapping || reducedMotion() ? "auto" : "smooth"),
    });
    setIndex(wrapped);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onScroll = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const raw = el.scrollLeft / width;
      const next = Math.round(raw);
      if (next < 0 || next > LAST) return;
      if (Math.abs(raw - next) > 0.08) return;
      setIndex((current) => (next === current ? current : next));
    };

    el.addEventListener("scroll", onScroll, { passive: true });

    const observer = new ResizeObserver(() => {
      el.scrollLeft = indexRef.current * el.clientWidth;
    });
    observer.observe(el);

    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
      event.preventDefault();
      if (wheelLock.current || Math.abs(event.deltaX) < 8) return;
      wheelLock.current = true;
      goTo(indexRef.current + (event.deltaX > 0 ? 1 : -1));
      window.setTimeout(() => {
        wheelLock.current = false;
      }, 480);
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  }, [goTo]);

  useEffect(() => {
    const onVis = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const playing = open === null && !hover && !hidden && !reducedMotion();

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => goTo(index + 1), AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [playing, index, goTo]);

  function openAt(slideIndex: number, opener: HTMLElement) {
    openerRef.current = opener;
    setOpen(slideIndex);
  }

  const close = useCallback(() => {
    setOpen(null);
    openerRef.current?.focus();
  }, []);

  function stepLightbox(delta: number) {
    setOpen((current) => {
      if (current === null) return current;
      return (current + delta + SLIDES.length) % SLIDES.length;
    });
  }

  const slide = open === null ? null : SLIDES[open];

  return (
    <section
      className="mkt-gallery"
      aria-roledescription="carousel"
      aria-labelledby="mkt-gallery-heading"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(event) => {
        if (open !== null) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          goTo(index - 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          goTo(index + 1);
        }
      }}
    >
      <h2 id="mkt-gallery-heading">What it looks like</h2>

      <div className="mkt-gallery-stage">
        <button
          type="button"
          className="mkt-gallery-step mkt-gallery-step-prev"
          aria-label="Previous screenshot"
          onClick={() => goTo(index - 1)}
        >
          <Chevron dir="left" />
        </button>

        <div
          ref={viewportRef}
          className="mkt-gallery-viewport"
          onPointerDown={() => {
            startLeft.current = viewportRef.current?.scrollLeft ?? 0;
          }}
        >
          {SLIDES.map((item, slideIndex) => (
            <div key={item.file} className="mkt-gallery-slide">
              <button
                type="button"
                className="mkt-gallery-card"
                tabIndex={slideIndex === index ? 0 : -1}
                aria-hidden={slideIndex !== index}
                onClick={(event) => {
                  const el = viewportRef.current;
                  if (el && Math.abs(el.scrollLeft - startLeft.current) > 10) {
                    return;
                  }
                  openAt(slideIndex, event.currentTarget);
                }}
              >
                <picture>
                  <source
                    media="(max-width: 640px)"
                    srcSet={item.srcMobile}
                  />
                  <img
                    src={item.src}
                    alt={item.alt}
                    width={1280}
                    height={800}
                    draggable={false}
                    loading={slideIndex === 0 ? "eager" : "lazy"}
                    decoding="async"
                  />
                </picture>
                <span className="mkt-gallery-caption">{item.caption}</span>
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="mkt-gallery-step mkt-gallery-step-next"
          aria-label="Next screenshot"
          onClick={() => goTo(index + 1)}
        >
          <Chevron dir="right" />
        </button>
      </div>

      <div className="mkt-gallery-dots" role="tablist" aria-label="Screenshots">
        {SLIDES.map((item, slideIndex) => (
          <button
            key={item.file}
            type="button"
            role="tab"
            className="mkt-gallery-dot"
            aria-label={item.caption}
            aria-selected={slideIndex === index}
            onClick={() => goTo(slideIndex)}
          >
            {playing && slideIndex === index ? (
              <span
                className="mkt-gallery-dot-fill"
                style={{ animationDuration: `${AUTOPLAY_MS}ms` }}
              />
            ) : null}
          </button>
        ))}
      </div>

      <Dialog
        open={open !== null}
        onClose={close}
        className="mkt-lightbox"
        aria-label={slide ? slide.caption : "Screenshot"}
        closeOnBackdrop
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            stepLightbox(-1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            stepLightbox(1);
          }
        }}
      >
        {slide ? (
          <>
            <button
              type="button"
              className="mkt-lightbox-close"
              aria-label="Close"
              onClick={close}
            >
              ✕
            </button>
            <button
              type="button"
              className="mkt-lightbox-nav mkt-lightbox-prev"
              aria-label="Previous screenshot"
              onClick={() => stepLightbox(-1)}
            >
              <Chevron dir="left" />
            </button>
            <figure className="mkt-lightbox-figure">
              <picture>
                <source
                  media="(max-width: 640px)"
                  srcSet={slide.srcMobile}
                />
                <img src={slide.src} alt={slide.alt} width={1280} height={800} />
              </picture>
              <figcaption>{slide.caption}</figcaption>
            </figure>
            <button
              type="button"
              className="mkt-lightbox-nav mkt-lightbox-next"
              aria-label="Next screenshot"
              onClick={() => stepLightbox(1)}
            >
              <Chevron dir="right" />
            </button>
          </>
        ) : null}
      </Dialog>
    </section>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {dir === "left" ? (
        <path
          d="M10.5 3.5 5.5 8l5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M5.5 3.5 10.5 8l-5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

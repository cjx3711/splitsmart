/**
 * Chord-band avatar editor. The parent owns the pattern; this is the fields.
 *
 * Null means "hash from the user id". Any edit materialises a stored pattern.
 * Geometry is a disc you drag (rotate) with two edge dots (start/end). Colour
 * and opacity live in one swatch picker, not a row of sliders.
 */
import { useEffect, useId, useRef, useState } from "react";
import {
  MAX_AVATAR_LAYERS,
  avatarLayerCss,
  avatarPatternFromId,
  defaultAvatarLayer,
  hexFromHsla,
  hslaCss,
  hslaFromHex,
  randomizeAvatarPattern,
  type AvatarHsla,
  type AvatarLayer,
  type AvatarPattern,
} from "../../src/domain/avatar-pattern.ts";
import { HelpTip } from "./HelpTip.tsx";

export function AvatarPatternEditor({
  id,
  iconHue,
  value,
  onChange,
}: {
  id: string;
  iconHue: number | null;
  value: AvatarPattern | null;
  onChange: (next: AvatarPattern | null) => void;
}) {
  const pattern = value ?? avatarPatternFromId(id, iconHue);
  const auto = value === null;

  function commit(next: AvatarPattern) {
    onChange(next);
  }

  function patchLayer(index: number, patch: Partial<AvatarLayer>) {
    commit({
      ...pattern,
      layers: pattern.layers.map((layer, i) => (i === index ? { ...layer, ...patch } : layer)),
    });
  }

  return (
    <div className="identity-pattern">
      <div className="identity-pattern-toolbar">
        <div className="label-with-help">
          <span className="identity-pattern-label">Profile image</span>
          <HelpTip label="About the profile image">
            Each disc is a coloured band. Drag to rotate, pull the dots to move
            the edges. The chip under it is the colour, opacity included.
          </HelpTip>
        </div>
        <div className="identity-pattern-toolbar-actions">
          <button
            type="button"
            className="secondary inline"
            onClick={() => onChange(randomizeAvatarPattern(pattern.base.h))}
          >
            Randomise
          </button>
          <button
            type="button"
            className="secondary inline"
            onClick={() => onChange(null)}
            disabled={auto}
          >
            Default
          </button>
        </div>
      </div>

      <div className="identity-pattern-grid">
        <div className="identity-pattern-cell">
          <BandPad
            rotation={pattern.baseRotation ?? 150}
            start={0}
            end={100}
            fill={`linear-gradient(${pattern.baseRotation ?? 150}deg, ${hslaCss({ ...pattern.base, a: 1 })}, ${hslaCss({ ...(pattern.baseEnd ?? pattern.base), a: 1 })})`}
            edges={false}
            label="Base gradient angle"
            onChange={({ rotation }) => commit({ ...pattern, baseRotation: rotation })}
          />
          <div className="identity-pattern-cell-meta">
            <HslaPicker
              label="Base"
              colour={{ ...pattern.base, a: 1 }}
              opacity={false}
              onColour={(c) => commit({ ...pattern, base: { ...c, a: 1 } })}
            />
            <HslaPicker
              label="Gradient"
              colour={{ ...(pattern.baseEnd ?? pattern.base), a: 1 }}
              opacity={false}
              onColour={(c) => commit({ ...pattern, baseEnd: { ...c, a: 1 } })}
            />
          </div>
          <span className="identity-pattern-caption">Base</span>
        </div>

        {pattern.layers.map((layer, index) => (
          <div key={index} className="identity-pattern-cell">
            <BandPad
              rotation={layer.rotation}
              start={layer.start}
              end={layer.end}
              fill={avatarLayerCss(layer)}
              label={`Band ${index + 1}`}
              onChange={(next) => patchLayer(index, next)}
            />
            <div className="identity-pattern-cell-meta">
              <HslaPicker
                label={`Band ${index + 1} colour`}
                colour={layer}
                onColour={(c) => patchLayer(index, c)}
              />
              <button
                type="button"
                className="identity-pattern-remove"
                aria-label={`Remove band ${index + 1}`}
                onClick={() =>
                  commit({
                    ...pattern,
                    layers: pattern.layers.filter((_, i) => i !== index),
                  })
                }
              >
                ×
              </button>
            </div>
          </div>
        ))}

        {pattern.layers.length < MAX_AVATAR_LAYERS && (
          <button
            type="button"
            className="identity-pattern-add"
            onClick={() =>
              commit({
                ...pattern,
                layers: [...pattern.layers, defaultAvatarLayer(pattern.base)],
              })
            }
          >
            <span aria-hidden="true">+</span>
            Add band
          </button>
        )}
      </div>
    </div>
  );
}

type DragMode = "rotate" | "start" | "end";

function BandPad({
  rotation,
  start,
  end,
  fill,
  label,
  edges = true,
  onChange,
}: {
  rotation: number;
  start: number;
  end: number;
  fill: string;
  label: string;
  edges?: boolean;
  onChange: (next: { rotation: number; start: number; end: number }) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    mode: DragMode;
    angle0: number;
    rotation0: number;
  } | null>(null);

  function localPoint(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      size: box.width,
    };
  }

  function apply(event: React.PointerEvent<HTMLDivElement>) {
    const session = drag.current;
    if (!session) return;
    const { x, y, size } = localPoint(event);
    const cx = size / 2;
    const cy = size / 2;
    if (session.mode === "rotate") {
      const angle = pointerAngle(x - cx, y - cy);
      onChange({
        rotation: wrapDeg(session.rotation0 + angle - session.angle0),
        start,
        end,
      });
      return;
    }
    const pct = projectPercent(x - cx, y - cy, size, rotation);
    if (session.mode === "start") {
      onChange({ rotation, start: clamp(pct, 0, end - 3), end });
    } else {
      onChange({ rotation, start, end: clamp(pct, start + 3, 100) });
    }
  }

  const startPos = handlePos(start, rotation);
  const endPos = handlePos(end, rotation);

  return (
    <div
      ref={rootRef}
      className="band-pad"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(rotation)}
      aria-valuetext={
        edges
          ? `${Math.round(rotation)}°, ${Math.round(start)}–${Math.round(end)}%`
          : `${Math.round(rotation)}°`
      }
      tabIndex={0}
      style={{ backgroundImage: fill }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const { x, y, size } = localPoint(event);
        const mode = edges ? hitMode(x, y, size, startPos, endPos) : "rotate";
        drag.current = {
          mode,
          angle0: pointerAngle(x - size / 2, y - size / 2),
          rotation0: rotation,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        apply(event);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 8 : 4;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const dir = event.key === "ArrowRight" ? 1 : -1;
          onChange({ rotation: wrapDeg(rotation + dir * step), start, end });
        } else if (edges && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          const dir = event.key === "ArrowUp" ? -1 : 1;
          onChange({
            rotation,
            start: clamp(start + dir * step, 0, end - 3),
            end: clamp(end + dir * step, start + 3, 100),
          });
        } else if (edges && (event.key === "[" || event.key === "]")) {
          event.preventDefault();
          const dir = event.key === "]" ? 1 : -1;
          onChange({
            rotation,
            start: clamp(start - dir * 2, 0, end - 3),
            end: clamp(end + dir * 2, start + 3, 100),
          });
        }
      }}
    >
      {edges && (
        <>
          <span className="band-pad-handle" style={{ left: startPos.x, top: startPos.y }} />
          <span className="band-pad-handle" style={{ left: endPos.x, top: endPos.y }} />
        </>
      )}
    </div>
  );
}

function HslaPicker({
  label,
  colour,
  onColour,
  opacity = true,
}: {
  label: string;
  colour: AvatarHsla;
  onColour: (c: AvatarHsla) => void;
  opacity?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const colorId = useId();
  const alphaId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="hsla-picker" ref={rootRef}>
      <button
        type="button"
        className="hsla-swatch"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        style={{
              backgroundImage: `linear-gradient(${hslaCss(colour)}, ${hslaCss(colour)}), var(--hsla-check)`,
        }}
      />
      {open && (
        <div className="hsla-pop" role="dialog" aria-label={label}>
          <label htmlFor={colorId} className="sr-only">
            {label} hue
          </label>
          <input
            id={colorId}
            type="color"
            value={hexFromHsla(colour)}
            onChange={(e) => {
              const next = hslaFromHex(e.target.value, colour.a);
              if (next) onColour(next);
            }}
          />
          {opacity && (
            <label className="hsla-alpha">
              <span className="sr-only">{label} opacity</span>
              <input
                id={alphaId}
                type="range"
                min={0}
                max={100}
                value={Math.round(colour.a * 100)}
                onChange={(e) => onColour({ ...colour, a: Number(e.target.value) / 100 })}
                style={{
                  backgroundImage: `linear-gradient(90deg, transparent, ${hslaCss({ ...colour, a: 1 })}), var(--hsla-check)`,
                }}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function pointerAngle(dx: number, dy: number): number {
  return wrapDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}

function projectPercent(dx: number, dy: number, size: number, rotation: number): number {
  const theta = (rotation * Math.PI) / 180;
  const dirX = Math.sin(theta);
  const dirY = -Math.cos(theta);
  const length = size * (Math.abs(dirX) + Math.abs(dirY));
  if (length === 0) return 50;
  return clamp(((dx * dirX + dy * dirY) / length + 0.5) * 100, 0, 100);
}

function handlePos(percent: number, rotation: number): { x: string; y: string } {
  const theta = (rotation * Math.PI) / 180;
  const span = Math.abs(Math.sin(theta)) + Math.abs(Math.cos(theta));
  const t = (percent / 100 - 0.5) * span;
  return {
    x: `${50 + t * Math.sin(theta) * 100}%`,
    y: `${50 + t * -Math.cos(theta) * 100}%`,
  };
}

function hitMode(
  x: number,
  y: number,
  size: number,
  startPos: { x: string; y: string },
  endPos: { x: string; y: string },
): DragMode {
  const start = { x: (Number.parseFloat(startPos.x) / 100) * size, y: (Number.parseFloat(startPos.y) / 100) * size };
  const end = { x: (Number.parseFloat(endPos.x) / 100) * size, y: (Number.parseFloat(endPos.y) / 100) * size };
  const startDist = Math.hypot(x - start.x, y - start.y);
  const endDist = Math.hypot(x - end.x, y - end.y);
  const threshold = 14;
  if (startDist <= threshold && startDist <= endDist) return "start";
  if (endDist <= threshold) return "end";
  return "rotate";
}

function wrapDeg(value: number): number {
  return ((value % 360) + 360) % 360;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

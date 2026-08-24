import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AVATAR_LAYERS,
  avatarPatternCss,
  avatarPatternFromId,
  circleStopToCss,
  hexFromHsla,
  hslaFromHex,
  isNeutral,
  paletteSpan,
  parseAvatarPattern,
  randomAvatarPattern,
  randomizeAvatarPattern,
  stringifyAvatarPattern,
} from "./avatar-pattern.ts";

const SAMPLE = {
  base: { h: 340, s: 62, l: 38, a: 1 },
  baseEnd: { h: 352, s: 58, l: 28, a: 1 },
  baseRotation: 150,
  layers: [
    { start: 12, end: 48, rotation: 23, h: 345, s: 70, l: 46, a: 0.6 },
    { start: 55, end: 68, rotation: 110, h: 0, s: 4, l: 92, a: 0.35 },
  ],
};

describe("parseAvatarPattern", () => {
  test("round-trips a stored object and its JSON", () => {
    const parsed = parseAvatarPattern(SAMPLE);
    assert.ok(parsed);
    assert.equal(parsed.layers.length, 2);
    assert.deepEqual(parseAvatarPattern(stringifyAvatarPattern(parsed)), parsed);
  });

  test("rejects more than ten layers and equal start/end", () => {
    const layers = Array.from({ length: MAX_AVATAR_LAYERS + 1 }, (_, i) => ({
      start: i,
      end: i + 4,
      rotation: 10,
      h: 10,
      s: 40,
      l: 40,
      a: 0.5,
    }));
    assert.equal(parseAvatarPattern({ base: SAMPLE.base, layers }), null);
    assert.equal(
      parseAvatarPattern({
        base: SAMPLE.base,
        layers: [{ start: 20, end: 20, rotation: 0, h: 10, s: 40, l: 40, a: 1 }],
      }),
      null,
    );
  });

  test("swaps inverted start/end rather than dropping the band", () => {
    const parsed = parseAvatarPattern({
      base: SAMPLE.base,
      layers: [{ start: 70, end: 20, rotation: 40, h: 10, s: 40, l: 40, a: 0.5 }],
    });
    assert.ok(parsed);
    assert.equal(parsed.layers[0]!.start, 20);
    assert.equal(parsed.layers[0]!.end, 70);
  });
});

describe("avatarPatternFromId", () => {
  test("is deterministic for a given id", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    assert.deepEqual(avatarPatternFromId(id), avatarPatternFromId(id));
    assert.notDeepEqual(avatarPatternFromId(id), avatarPatternFromId("01ARZ3NDEKTSV4RRFFQ69G5FAW"));
  });

  test("honours a stored hue as the palette origin", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const pattern = avatarPatternFromId(id, 205);
    assert.equal(pattern.base.h, 205);
  });

  test("stays within a complementary span, with thin neutrals", () => {
    const rng = (() => {
      let i = 0;
      return () => {
        i += 1;
        return ((i * 17) % 100) / 100;
      };
    })();
    for (let n = 0; n < 40; n++) {
      const pattern = randomAvatarPattern(() => rng());
      assert.ok(pattern.layers.length >= 3 && pattern.layers.length <= 6);
      assert.ok(paletteSpan(pattern) <= 180 + 1e-6);
      const neutrals = pattern.layers.filter(isNeutral);
      assert.ok(neutrals.length <= 2);
      for (const layer of neutrals) {
        assert.ok(layer.end - layer.start <= 16 + 1e-6);
      }
    }
  });
});

describe("avatarPatternCss", () => {
  test("stacks bands above the base gradient", () => {
    const css = avatarPatternCss(SAMPLE);
    assert.match(css, /linear-gradient\(110deg/);
    assert.match(css, /linear-gradient\(23deg/);
    assert.match(css, /linear-gradient\(150deg, hsla\(340/);
    assert.ok(css.indexOf("110deg") < css.indexOf("23deg"));
  });
});

describe("circleStopToCss", () => {
  test("is a no-op on the cardinal axes", () => {
    assert.equal(circleStopToCss(0, 0), 0);
    assert.equal(circleStopToCss(100, 90), 100);
    assert.equal(circleStopToCss(50, 180), 50);
  });

  test("keeps 0% and 100% on the disc rim at 45°", () => {
    const start = circleStopToCss(0, 45);
    const end = circleStopToCss(100, 45);
    assert.ok(Math.abs(start - (50 - 50 / Math.SQRT2)) < 1e-6);
    assert.ok(Math.abs(end - (50 + 50 / Math.SQRT2)) < 1e-6);
    assert.ok(start > 0);
    assert.ok(end < 100);
  });
});

describe("randomize with locks", () => {
  function seqRng(seed: number) {
    let i = seed;
    return () => {
      i += 1;
      return ((i * 17) % 100) / 100;
    };
  }

  test("keeps a locked base and locked layers, randomises the rest", () => {
    const current = randomAvatarPattern(seqRng(3));
    assert.ok(current.layers.length >= 2);
    const locks = {
      base: true,
      layers: current.layers.map((_, i) => i === 0),
    };
    const next = randomAvatarPattern(seqRng(99), {
      baseHue: current.base.h,
      keep: { current, locks },
    });
    assert.deepEqual(next.base, current.base);
    assert.deepEqual(next.baseEnd, current.baseEnd);
    assert.equal(next.baseRotation, current.baseRotation);
    assert.equal(next.layers.length, current.layers.length);
    assert.deepEqual(next.layers[0], current.layers[0]);
    if (current.layers.length > 1) {
      assert.notDeepEqual(next.layers.slice(1), current.layers.slice(1));
    }
  });

  test("returns the same pattern when everything is locked", () => {
    const current = randomAvatarPattern(seqRng(3));
    const next = randomAvatarPattern(seqRng(1), {
      keep: {
        current,
        locks: { base: true, layers: current.layers.map(() => true) },
      },
    });
    assert.deepEqual(next, current);
  });

  test("keepLayerCount reshuffles without adding or removing bands", () => {
    const current = {
      base: SAMPLE.base,
      layers: Array.from({ length: 5 }, (_, i) => ({
        start: 10 + i * 8,
        end: 16 + i * 8,
        rotation: i * 20,
        h: 340,
        s: 50,
        l: 40,
        a: 0.5,
      })),
    };
    const next = randomAvatarPattern(seqRng(11), {
      keepLayerCount: true,
      keep: { current, locks: { base: false, layers: current.layers.map(() => false) } },
    });
    assert.equal(next.layers.length, 5);
    assert.notDeepEqual(next.layers, current.layers);
    assert.notDeepEqual(next.base, current.base);
  });

  test("a lock mask (editor Randomise) keeps the band count", () => {
    const current = {
      base: SAMPLE.base,
      layers: Array.from({ length: 5 }, (_, i) => ({
        start: 10 + i * 8,
        end: 16 + i * 8,
        rotation: i * 20,
        h: 340,
        s: 50,
        l: 40,
        a: 0.5,
      })),
    };
    const next = randomizeAvatarPattern(current, {
      base: false,
      layers: current.layers.map(() => false),
    });
    assert.equal(next.layers.length, 5);
  });
});

describe("hex round-trip", () => {
  test("keeps a saturated colour close enough to edit", () => {
    const hex = hexFromHsla({ h: 205, s: 62, l: 42, a: 1 });
    const back = hslaFromHex(hex, 0.7);
    assert.ok(back);
    assert.ok(Math.abs(back.h - 205) < 2);
    assert.ok(Math.abs(back.s - 62) < 2);
    assert.ok(Math.abs(back.l - 42) < 2);
    assert.equal(back.a, 0.7);
  });
});

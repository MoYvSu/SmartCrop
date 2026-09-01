import { describe, expect, it } from "vitest";

import { cropEquals, moveCrop } from "./crop";

describe("crop helpers", () => {
  it("keeps a moved crop inside the image", () => {
    expect(moveCrop({ x: 0.8, y: 0.8, width: 0.3, height: 0.3 }, 0.2, 0.2)).toEqual({
      x: 0.7,
      y: 0.7,
      width: 0.3,
      height: 0.3,
    });
  });

  it("compares crops with a small tolerance", () => {
    expect(
      cropEquals(
        { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        { x: 0.10001, y: 0.1, width: 0.8, height: 0.8 },
      ),
    ).toBe(true);
  });
});

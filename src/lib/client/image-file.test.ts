import { describe, expect, it } from "vitest";
import { fitWithin } from "./image-file";

describe("fitWithin", () => {
  it("leaves a small image alone", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it("scales the long edge down and keeps the ratio", () => {
    expect(fitWithin(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
  });

  it("scales a portrait screenshot by its height", () => {
    expect(fitWithin(1170, 2532, 1600)).toEqual({ width: 739, height: 1600 });
  });

  it("never returns a zero dimension", () => {
    expect(fitWithin(4000, 3, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

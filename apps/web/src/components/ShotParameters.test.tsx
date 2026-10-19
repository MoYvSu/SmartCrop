import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatExposure, ShotParameters } from "./ShotParameters";

describe("ShotParameters", () => {
  it("formats actual measurements and combines the camera name", () => {
    const markup = renderToStaticMarkup(<ShotParameters exif={{ camera_make: "Canon", camera_model: "EOS R6",
      lens_model: "RF 24-105mm F4 L IS USM", focal_length_mm: 35, aperture: 5.6,
      exposure_seconds: 1 / 250, iso: 400 }} />);
    for (const value of ["Canon EOS R6", "RF 24-105mm F4 L IS USM", "35 mm", "f/5.6", "1/250 秒", "400"])
      expect(markup).toContain(value);
    expect(markup).toContain('<dl class="wb-image-facts wb-exif-facts" aria-label="照片拍摄参数">');
    expect(markup).not.toContain("未记录");
  });

  it.each([undefined, {}])("shows a useful empty state rather than fabricated values: %s", exif => {
    const markup = renderToStaticMarkup(<ShotParameters exif={exif} />);
    expect(markup).toContain("这张照片没有可用的拍摄参数");
    expect(markup).toContain("相机或手机拍摄的原始照片");
    expect(markup).not.toContain("<dl");
  });

  it("keeps missing fields and invalid numeric fields explicit", () => {
    const markup = renderToStaticMarkup(<ShotParameters exif={{ camera_model: "Test Camera",
      focal_length_mm: Number.NaN, aperture: 0, exposure_seconds: -1, iso: Number.POSITIVE_INFINITY }} />);
    expect(markup.match(/未记录/g)).toHaveLength(5);
    expect(markup).not.toMatch(/NaN|Infinity|f\/0|1\/-1/);
  });

  it("does not fabricate sample EXIF even if a caller passes it", () => {
    const markup = renderToStaticMarkup(<ShotParameters sample exif={{ camera_model: "Not sample data" }} />);
    expect(markup).toContain("样例未提供拍摄参数");
    expect(markup).not.toContain("Not sample data");
  });

  it("does not duplicate the manufacturer or render HTML embedded in a camera name", () => {
    const markup = renderToStaticMarkup(<ShotParameters exif={{ camera_make: "SONY", camera_model: "Sony A7 <script>" }} />);
    expect(markup).toContain("Sony A7 &lt;script&gt;");
    expect(markup).not.toContain("SONY Sony");
    expect(markup).not.toContain("<script>");
  });

  it.each([[1 / 8000, "1/8000 秒"], [1 / 60, "1/60 秒"], [0.4, "1/2.5 秒"], [1.3, "1.3 秒"], [30, "30 秒"], [0, ""]])(
    "formats shutter duration %s", (seconds, expected) => expect(formatExposure(seconds)).toBe(expected),
  );
});

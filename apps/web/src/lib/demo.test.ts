import { describe, expect, it } from "vitest";

import { createPregeneratedJob } from "./demo";
import { getCropMetrics } from "./metrics";

describe("pregenerated demo", () => {
  it("keeps every candidate inside the requested publishing ratio", () => {
    const job = createPregeneratedJob({
      scene: "social",
      aspect_ratio: "16:9",
      output_template: "social_cover",
      custom_ratio: null,
    });

    expect(job.candidates).toHaveLength(3);
    for (const candidate of job.candidates) {
      expect(
        getCropMetrics(job.image_width, job.image_height, candidate.crop, job.intent)
          .ratioCompliant,
      ).toBe(true);
    }
    expect(job.report?.crop_rationale).toContain("不代表自动优劣排序");
    expect(job.processing_duration_ms).toBeNull();
    expect(job.capability_status).toBe("not_run");
    expect(job.selection_confirmed).toBe(false);
  });
});

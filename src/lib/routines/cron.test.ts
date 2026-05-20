import { describe, it, expect } from "vitest";
import { describeCron } from "./cron";

describe("describeCron (human-readable cron renderer)", () => {
  it("renders the canonical single-fire case", () => {
    expect(describeCron("0 8 * * *")).toBe("every day · at 08:00");
    expect(describeCron("30 17 * * 1-5")).toBe("weekdays · at 17:30");
  });

  it("renders weekend / weekday shortcuts", () => {
    expect(describeCron("0 10 * * 0,6")).toBe("weekends · at 10:00");
    expect(describeCron("0 10 * * 6,0")).toBe("weekends · at 10:00");
  });

  it("handles step shortcuts", () => {
    expect(describeCron("*/15 * * * *")).toBe("every day · every 15 min");
    expect(describeCron("0 */2 * * *")).toBe("every day · every 2h");
    expect(describeCron("* * * * *")).toBe("every day · every minute");
  });

  // The case the user reported: `7,37 6-21 * * *` used to render as the
  // unreadable "at 6-21:7,37".
  it("renders a minute-list over an hour-range as a real English phrase", () => {
    expect(describeCron("7,37 6-21 * * *"))
      .toBe("every day · at :07 and :37 every hour from 06h to 21h");
  });

  it("renders a single minute across a list of hours as concrete clock times", () => {
    expect(describeCron("0 8,12,16,20 * * *"))
      .toBe("every day · at 08:00, 12:00, 16:00 and 20:00");
  });

  it("renders a list of minutes at a single hour", () => {
    expect(describeCron("5,35 9 * * *"))
      .toBe("every day · at 09:05 and 09:35");
  });

  it("renders a minute range at a single hour as a duration", () => {
    expect(describeCron("0-30 8 * * *"))
      .toBe("every day · from 08:00 to 08:30");
  });

  it("renders a single minute across an hour range", () => {
    expect(describeCron("0 9-17 * * *"))
      .toBe("every day · at :00 every hour from 09h to 17h");
  });

  it("falls back to raw expr when shape is malformed", () => {
    expect(describeCron("not a cron")).toBe("not a cron");
    expect(describeCron("0 8")).toBe("0 8");
  });

  it("keeps the raw H:M for exotic mixes it cannot phrase yet", () => {
    // Step inside a range — not worth a bespoke sentence; show the raw fields
    // rather than lie.
    expect(describeCron("0 8-20/2 * * *")).toBe("every day · 8-20/2:0");
  });
});

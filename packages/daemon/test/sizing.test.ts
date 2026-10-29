import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DRIVER_BASELINES,
  SIZING_PROFILES,
  isSizingDriver,
  isWorkloadProfile,
  sizeHost,
} from "../src/sizing.js";

describe("sizing model", () => {
  it("refuses to invent numbers for an unmeasured profile", () => {
    const s = sizeHost({ profile: "light", driver: "container" });
    assert.equal(s.ok, false);
    assert.equal(s.totals.memoryMb, null);
    assert.equal(s.totals.vcpus, null);
    assert.equal(s.totals.diskGb, null);
    assert.ok(s.missing.includes("peakMemoryMb"));
    assert.ok(s.missing.includes("diskGb"));
  });

  it("sizes the measured heavy profile on containers", () => {
    const s = sizeHost({ profile: "heavy", driver: "container" });
    // 24 GiB peak floor × 1.25 headroom, one agent.
    assert.equal(s.totals.memoryMb, 30720);
    assert.equal(s.totals.vcpus, 16);
    // Average CPU and disk are still unmeasured, so the result is incomplete.
    assert.equal(s.ok, false);
    assert.deepEqual(s.missing, ["avgCpus", "diskGb"]);
  });

  it("adds the measured Firecracker baseline per sandbox", () => {
    const s = sizeHost({ profile: "heavy", driver: "firecracker" });
    // (24576 + 54) × 1.25 = 30787.5 → rounded up.
    assert.equal(s.totals.memoryMb, 30788);
    assert.equal(s.perAgent.baselineMb, 54);
  });

  it("scales by people × agents per person × peak fraction", () => {
    const s = sizeHost({
      people: 4,
      agentsPerPerson: 2,
      profile: "heavy",
      driver: "firecracker",
      peakFraction: 0.5,
    });
    assert.equal(s.agents, 8);
    // 4 concurrent × 24630 MiB × 1.25 = 123150.
    assert.equal(s.totals.memoryMb, 123150);
    assert.equal(s.totals.vcpus, 64);
  });

  it("returns zero totals for zero agents", () => {
    const s = sizeHost({ people: 0, profile: "heavy" });
    assert.equal(s.agents, 0);
    assert.equal(s.totals.memoryMb, 0);
    assert.equal(s.totals.vcpus, 0);
  });

  it("rejects out-of-range input instead of clamping it", () => {
    assert.throws(() => sizeHost({ peakFraction: 0 }), /peakFraction/);
    assert.throws(() => sizeHost({ peakFraction: 1.5 }), /peakFraction/);
    assert.throws(() => sizeHost({ headroom: 0.5 }), /headroom/);
    assert.throws(() => sizeHost({ people: -1 }), /people/);
    assert.throws(() => sizeHost({ agentsPerPerson: -1 }), /agentsPerPerson/);
    assert.throws(() => sizeHost({ profile: "huge" as never }), /unknown profile/);
    assert.throws(() => sizeHost({ driver: "qemu" as never }), /unknown driver/);
  });

  it("marks only measured constants as measured", () => {
    assert.equal(DRIVER_BASELINES.firecracker.measured, true);
    assert.equal(DRIVER_BASELINES.container.measured, false);
    assert.equal(DRIVER_BASELINES.applevz.measured, false);
    for (const profile of Object.values(SIZING_PROFILES)) {
      assert.equal(profile.measured, false, `${profile.profile} has no full measurement yet`);
      assert.ok(profile.basis.length > 0);
    }
  });

  it("guards the profile and driver unions", () => {
    assert.equal(isWorkloadProfile("medium"), true);
    assert.equal(isWorkloadProfile("huge"), false);
    assert.equal(isSizingDriver("applevz"), true);
    assert.equal(isSizingDriver("qemu"), false);
  });
});

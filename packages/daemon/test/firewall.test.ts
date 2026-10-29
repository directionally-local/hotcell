import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gatewayOf, parseEgressFirewallDrop } from "../src/net/firewall.js";

describe("gatewayOf", () => {
  it("replaces the last octet with 1", () => {
    assert.equal(gatewayOf("172.17.0.0/16"), "172.17.0.1");
    assert.equal(gatewayOf("10.0.0.0/8"), "10.0.0.1");
  });

  it("accepts a bare address", () => {
    assert.equal(gatewayOf("192.168.1.5"), "192.168.1.1");
  });

  it("returns non-IPv4 input unchanged", () => {
    assert.equal(gatewayOf("fd00::/64"), "fd00::");
    assert.equal(gatewayOf("not-an-ip"), "not-an-ip");
  });
});

describe("parseEgressFirewallDrop", () => {
  const prefix = "HOTCELL_EGRESS_DROP";

  it("parses a kernel LOG record into a drop", () => {
    const line = `kernel: ${prefix} SRC=172.17.0.5 DST=1.1.1.1 PROTO=TCP DPT=443`;
    assert.deepEqual(parseEgressFirewallDrop(line), {
      sourceIp: "172.17.0.5",
      destinationIp: "1.1.1.1",
      protocol: "tcp",
      port: 443,
    });
  });

  it("defaults protocol to unknown and port to 0 when absent", () => {
    const line = `${prefix} SRC=10.0.0.2 DST=8.8.8.8`;
    assert.deepEqual(parseEgressFirewallDrop(line), {
      sourceIp: "10.0.0.2",
      destinationIp: "8.8.8.8",
      protocol: "unknown",
      port: 0,
    });
  });

  it("ignores lines without the marker", () => {
    assert.equal(parseEgressFirewallDrop("unrelated kernel message"), undefined);
  });

  it("requires both SRC and DST", () => {
    assert.equal(parseEgressFirewallDrop(`${prefix} SRC=10.0.0.2`), undefined);
    assert.equal(parseEgressFirewallDrop(`${prefix} DST=10.0.0.2`), undefined);
  });

  it("rejects a non-integer port", () => {
    const line = `${prefix} SRC=10.0.0.2 DST=8.8.8.8 DPT=abc`;
    assert.equal(parseEgressFirewallDrop(line)?.port, 0);
  });
});

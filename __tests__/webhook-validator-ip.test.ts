import { describe, it, expect } from "vitest";
import { isPrivateIP } from "@/app/lib/webhook-validator";

describe("isPrivateIP — SSRF address classification", () => {
  it("blocks the standard private + loopback + link-local ranges", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0"]) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });

  it("blocks 100.64.0.0/10 CGNAT (RFC 6598)", () => {
    expect(isPrivateIP("100.64.0.1")).toBe(true);
    expect(isPrivateIP("100.127.255.254")).toBe(true);
    // 100.63 and 100.128 are outside the /10 — public.
    expect(isPrivateIP("100.63.0.1")).toBe(false);
    expect(isPrivateIP("100.128.0.1")).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 in dotted, compressed-hex, AND expanded-hex forms", () => {
    // 192.168.1.1 mapped, three notations
    expect(isPrivateIP("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateIP("::ffff:c0a8:0101")).toBe(true);
    expect(isPrivateIP("0:0:0:0:0:ffff:c0a8:0101")).toBe(true);
    // IMDS mapped
    expect(isPrivateIP("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks loopback + ULA IPv6", () => {
    for (const ip of ["::1", "fc00::1", "fd12:3456::1", "fe80::1"]) {
      expect(isPrivateIP(ip), ip).toBe(true);
    }
  });

  it("allows genuine public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "2606:4700:4700::1111"]) {
      expect(isPrivateIP(ip), ip).toBe(false);
    }
  });

  it("treats unparseable input as blocked (fail-closed)", () => {
    expect(isPrivateIP("not-an-ip")).toBe(true);
    expect(isPrivateIP("")).toBe(true);
  });
});

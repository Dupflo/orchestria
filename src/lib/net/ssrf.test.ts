import { describe, it, expect } from "vitest";
import { isPrivateAddress, assertPublicHttpUrl } from "./ssrf";

describe("isPrivateAddress", () => {
  it("flags private / loopback / link-local / ULA addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "169.254.10.20", "100.64.0.1", "0.0.0.0",
      "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
      "::ffff:127.0.0.1", "::ffff:10.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
    await expect(assertPublicHttpUrl("ftp://example.com")).rejects.toThrow(/scheme/);
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow(/invalid url/);
  });

  it("rejects blocked hostnames and .local", async () => {
    await expect(assertPublicHttpUrl("http://localhost/x")).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl("http://metadata.google.internal/")).rejects.toThrow(/not allowed/);
    await expect(assertPublicHttpUrl("http://printer.local/")).rejects.toThrow(/not allowed/);
  });

  it("rejects private IP literals without needing DNS", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1:8080/cb")).rejects.toThrow(/private address/);
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private address/);
    await expect(assertPublicHttpUrl("http://[::1]/")).rejects.toThrow(/private address/);
  });

  it("allows a public IP literal", async () => {
    await expect(assertPublicHttpUrl("https://1.1.1.1/callback")).resolves.toBeUndefined();
  });
});

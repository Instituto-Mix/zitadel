import { describe, expect, it } from "vitest";
import { parseSiteMeta } from "./site-meta";

describe("parseSiteMeta", () => {
  it("extracts title and description", () => {
    const html = `<html><head><title>IM Hub</title>
      <meta name="description" content="Portal do Instituto Mix"></head><body/></html>`;
    expect(parseSiteMeta(html, "https://imhub.example.com/login")).toEqual({ title: "IM Hub", description: "Portal do Instituto Mix", favicon: "https://imhub.example.com/favicon.ico" });
  });

  it("tolerates content-before-name attribute order", () => {
    const html = `<head><meta content="Desc first" name="description"><title>T</title></head>`;
    expect(parseSiteMeta(html)).toEqual({ title: "T", description: "Desc first", favicon: null });
  });

  it("returns nulls when absent", () => {
    expect(parseSiteMeta("<html><body>nothing</body></html>")).toEqual({ title: null, description: null, favicon: null });
  });

  it("collapses whitespace and treats empty as null", () => {
    const html = `<title>  Multi\n  line   title </title><meta name="description" content="   ">`;
    expect(parseSiteMeta(html)).toEqual({ title: "Multi line title", description: null, favicon: null });
  });

  it("handles title attributes (e.g. data-rh)", () => {
    expect(parseSiteMeta(`<title data-rh="true">App</title>`).title).toBe("App");
  });
});

describe("isFetchableUrl (SSRF guard)", () => {
  it("allows public https hosts", async () => {
    const { isFetchableUrl } = await import("./site-meta");
    expect(isFetchableUrl("https://imhub.institutomix.com.br/login")).toBe(true);
  });

  it("rejects IP literals, internal names, and non-https", async () => {
    const { isFetchableUrl } = await import("./site-meta");
    for (const bad of [
      "https://10.0.0.5/admin",
      "https://192.168.65.143:3000/",
      "https://[fd00::1]/x",
      "https://zitadel/", // docker service name
      "https://backend.internal/",
      "https://foo.local/",
      "http://example.com/",
      "not a url",
    ]) {
      expect(isFetchableUrl(bad), bad).toBe(false);
    }
  });
});

describe("favicon parsing", () => {
  it("resolves a relative icon href against the page URL", () => {
    const html = `<link rel="icon" href="/static/fav.png"><title>x</title>`;
    expect(parseSiteMeta(html, "https://app.example.com/login").favicon).toBe("https://app.example.com/static/fav.png");
  });

  it("supports href-before-rel and apple-touch-icon", () => {
    const html = `<link href="icons/apple.png" rel="apple-touch-icon">`;
    expect(parseSiteMeta(html, "https://app.example.com/login").favicon).toBe("https://app.example.com/icons/apple.png");
  });

  it("defaults to /favicon.ico when no link tag exists", () => {
    expect(parseSiteMeta("<title>x</title>", "https://app.example.com/deep/path").favicon).toBe("https://app.example.com/favicon.ico");
  });
});

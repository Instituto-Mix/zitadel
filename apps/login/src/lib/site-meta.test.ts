import { describe, expect, it } from "vitest";
import { parseSiteMeta } from "./site-meta";

describe("parseSiteMeta", () => {
  it("extracts title and description", () => {
    const html = `<html><head><title>IM Hub</title>
      <meta name="description" content="Portal do Instituto Mix"></head><body/></html>`;
    expect(parseSiteMeta(html)).toEqual({ title: "IM Hub", description: "Portal do Instituto Mix" });
  });

  it("tolerates content-before-name attribute order", () => {
    const html = `<head><meta content="Desc first" name="description"><title>T</title></head>`;
    expect(parseSiteMeta(html)).toEqual({ title: "T", description: "Desc first" });
  });

  it("returns nulls when absent", () => {
    expect(parseSiteMeta("<html><body>nothing</body></html>")).toEqual({ title: null, description: null });
  });

  it("collapses whitespace and treats empty as null", () => {
    const html = `<title>  Multi\n  line   title </title><meta name="description" content="   ">`;
    expect(parseSiteMeta(html)).toEqual({ title: "Multi line title", description: null });
  });

  it("handles title attributes (e.g. data-rh)", () => {
    expect(parseSiteMeta(`<title data-rh="true">App</title>`).title).toBe("App");
  });
});

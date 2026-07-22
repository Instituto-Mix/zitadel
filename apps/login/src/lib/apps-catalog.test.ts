import { describe, expect, it } from "vitest";
import { CatalogApp, groupAppsByProject, parseAppsCatalog } from "./apps-catalog";

describe("parseAppsCatalog", () => {
  it("parses a valid catalog", () => {
    const raw = JSON.stringify([
      { projectId: "1", name: "LMS", url: "https://lms.example.com", description: "Learning" },
      { projectId: "2", name: "Portal", url: "https://portal.example.com" },
    ]);
    expect(parseAppsCatalog(raw)).toHaveLength(2);
  });

  it("returns empty for missing env", () => {
    expect(parseAppsCatalog(undefined)).toEqual([]);
  });

  it("returns empty for invalid JSON", () => {
    expect(parseAppsCatalog("{nope")).toEqual([]);
  });

  it("returns empty for non-array JSON", () => {
    expect(parseAppsCatalog('{"projectId":"1"}')).toEqual([]);
  });

  it("drops entries missing required fields", () => {
    const raw = JSON.stringify([
      { projectId: "1", name: "OK", url: "https://ok.example.com" },
      { projectId: "2", name: "no url" },
      { name: "no project", url: "https://x.example.com" },
      null,
    ]);
    const parsed = parseAppsCatalog(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("OK");
  });
});

describe("groupAppsByProject", () => {
  const catalog: CatalogApp[] = [
    { projectId: "p1", name: "LMS Web", url: "https://lms.example.com" },
    { projectId: "p1", name: "LMS Admin", url: "https://lms-admin.example.com" },
    { projectId: "p2", name: "Portal", url: "https://portal.example.com" },
  ];

  it("returns only granted projects that have catalog apps", () => {
    const groups = groupAppsByProject(catalog, [
      { projectId: "p1", projectName: "LMS", roles: ["Student"] },
      { projectId: "p3", projectName: "Ungatalogued", roles: ["Employee"] },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].projectName).toBe("LMS");
    expect(groups[0].apps.map((a) => a.name)).toEqual(["LMS Web", "LMS Admin"]);
  });

  it("hides catalog apps without a grant", () => {
    const groups = groupAppsByProject(catalog, []);
    expect(groups).toEqual([]);
  });

  it("keeps roles on the group for display", () => {
    const groups = groupAppsByProject(catalog, [{ projectId: "p2", projectName: "Portal", roles: ["Employee", "Region"] }]);
    expect(groups[0].roles).toEqual(["Employee", "Region"]);
  });
});

import {
  normalizeForSearch,
  rankSearchResult,
  smartMatch,
  smartSearch,
} from "../src/shared/utils/smartSearch";

describe("smart Arabic search", () => {
  it("normalizes Arabic letter forms, diacritics, tatweel and digits", () => {
    expect(normalizeForSearch("أَحْمَـد")).toBe("احمد");
    expect(smartMatch("مصطفى", "مصطفي")).toBe(true);
    expect(smartMatch("على", "علي")).toBe(true);
    expect(smartMatch("هبة", "هبه")).toBe(true);
    expect(smartMatch("00126", "٠٠١٢٦")).toBe(true);
  });

  it("matches compound names with or without the space", () => {
    expect(smartMatch("عبد الله محمد", "عبدالله")).toBe(true);
    expect(smartMatch("عبدالله محمد", "عبد الله")).toBe(true);
    expect(smartMatch("عبد الرحمن أحمد", "عبدالرحمن")).toBe(true);
  });

  it("supports partial and safe common spelling variation", () => {
    expect(smartMatch("أحمد محمد", "اح")).toBe(true);
    expect(smartMatch("جنى", "جنا")).toBe(true);
    expect(smartMatch("Ahmed Mohamed", "ahmed")).toBe(true);
  });

  it("ranks exact and prefix matches before weaker contains matches", () => {
    const items = ["محمد أحمد", "أحمد علي", "أحمد"];
    const result = smartSearch(items, "احمد", [{ get: (item) => item }]);
    expect(result).toEqual(["أحمد", "أحمد علي", "محمد أحمد"]);
    expect(rankSearchResult("أحمد", "احمد")).toBeGreaterThan(
      rankSearchResult("محمد أحمد", "احمد"),
    );
  });
});

import {
  GROUPS_ROUTE,
  GROUP_DETAILS_ROUTE,
  returnToGroupsIfRequested,
  returnToGroupDetailsIfRequested,
} from "../src/features/groups/groupNavigation";

describe("group editor return navigation", () => {
  it.each(["save", "cancel", "dismiss"])("returns to the groups route after %s", () => {
    const navigate = jest.fn();

    returnToGroupsIfRequested("groups", navigate);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(GROUPS_ROUTE);
  });

  it("does not redirect academic flows without an explicit groups return target", () => {
    const navigate = jest.fn();

    returnToGroupsIfRequested(undefined, navigate);

    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("group details student return navigation", () => {
  it.each(["save", "cancel", "dismiss"])(
    "returns to the specific group details route after %s preserving group context",
    () => {
      const navigate = jest.fn();

      const handled = returnToGroupDetailsIfRequested("group-details", "group-42", navigate);

      expect(handled).toBe(true);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith({
        pathname: GROUP_DETAILS_ROUTE,
        params: { groupId: "group-42" },
      });
    },
  );

  it("accepts 'group' alias as returnTo target", () => {
    const navigate = jest.fn();

    const handled = returnToGroupDetailsIfRequested("group", "group-99", navigate);

    expect(handled).toBe(true);
    expect(navigate).toHaveBeenCalledWith({
      pathname: GROUP_DETAILS_ROUTE,
      params: { groupId: "group-99" },
    });
  });

  it("does not redirect when groupId is missing or returnTo is not group-details", () => {
    const navigate = jest.fn();

    expect(returnToGroupDetailsIfRequested(undefined, "group-42", navigate)).toBe(false);
    expect(returnToGroupDetailsIfRequested("group-details", undefined, navigate)).toBe(false);
    expect(returnToGroupDetailsIfRequested("scanner", "group-42", navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

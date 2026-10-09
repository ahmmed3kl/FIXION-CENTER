export const GROUPS_ROUTE = "/(main)/groups" as const;
export const GROUP_DETAILS_ROUTE = "/(main)/group-details" as const;

export function returnToGroupsIfRequested(
  returnTo: string | undefined,
  navigate: (route: typeof GROUPS_ROUTE) => void,
): void {
  if (returnTo === "groups") navigate(GROUPS_ROUTE);
}

export function returnToGroupDetailsIfRequested(
  returnTo: string | undefined,
  groupId: string | undefined,
  navigate: (route: { pathname: typeof GROUP_DETAILS_ROUTE; params: { groupId: string } }) => void,
): boolean {
  if ((returnTo === "group" || returnTo === "group-details") && groupId) {
    navigate({ pathname: GROUP_DETAILS_ROUTE, params: { groupId } });
    return true;
  }
  return false;
}

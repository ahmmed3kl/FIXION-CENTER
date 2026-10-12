import { User } from "../../shared/types";

export function canSwitchCenters(user: Pick<User, "role"> | null | undefined): boolean {
  return user?.role === "admin" || user?.role === "owner";
}

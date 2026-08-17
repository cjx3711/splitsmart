/**
 * Native group types. Splitwise only has home, trip, couple, other (plus the
 * deprecated apartment/house aliases, mapped on import). Everything else here
 * is SplitSmart-only and lives on /api/v1.
 */
export const GROUP_TYPES = [
  "trip",
  "outing",
  "home",
  "couple",
  "family",
  "work",
  "school",
  "sports",
  "event",
  "project",
  "other",
] as const;

export type GroupType = (typeof GROUP_TYPES)[number];

export const GROUP_TYPE_LABELS: Record<GroupType, string> = {
  trip: "Trip",
  outing: "Outing",
  home: "Home",
  couple: "Couple",
  family: "Family",
  work: "Work",
  school: "School",
  sports: "Sports",
  event: "Event",
  project: "Project",
  other: "Other",
};

export function isGroupType(value: string): value is GroupType {
  return (GROUP_TYPES as readonly string[]).includes(value);
}

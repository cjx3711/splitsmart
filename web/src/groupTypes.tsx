import {
  LuBeer,
  LuBriefcase,
  LuCalendar,
  LuCircleHelp,
  LuFolderKanban,
  LuGraduationCap,
  LuHeart,
  LuHouse,
  LuPartyPopper,
  LuPlane,
  LuTrophy,
  LuUsersRound,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import {
  GROUP_TYPE_LABELS,
  GROUP_TYPES,
  type GroupType,
} from "../../src/domain/group-types.ts";

export { GROUP_TYPES, GROUP_TYPE_LABELS, type GroupType };

const GROUP_TYPE_ICONS: Record<GroupType, IconType> = {
  trip: LuPlane,
  outing: LuBeer,
  home: LuHouse,
  couple: LuHeart,
  family: LuUsersRound,
  work: LuBriefcase,
  school: LuGraduationCap,
  sports: LuTrophy,
  event: LuPartyPopper,
  project: LuFolderKanban,
  other: LuCircleHelp,
};

export function groupTypeLabel(type: string): string {
  return isGroupTypeIcon(type) ? GROUP_TYPE_LABELS[type] : type;
}

export function GroupTypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = isGroupTypeIcon(type) ? GROUP_TYPE_ICONS[type] : GROUP_TYPE_ICONS.other;
  return <Icon className={className} aria-hidden />;
}

function isGroupTypeIcon(type: string): type is GroupType {
  return type in GROUP_TYPE_ICONS;
}

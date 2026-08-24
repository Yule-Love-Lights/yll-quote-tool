import {
  isMiniArea,
  isMiniGroup,
  isMiniGroupable,
  isStrand,
  type MiniAreaItem,
  type MiniGroupItem,
  type Scene,
  type SceneItem,
  type StrandItem,
} from './sceneTypes';

type MiniGroupMember = StrandItem | MiniAreaItem;

const memberPattern = (member: MiniGroupMember): string[] =>
  member.colorPattern?.length ? member.colorPattern : ['warm-white'];

const samePattern = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((color, index) => color === right[index]);

export function sharedMiniGroupColorPattern(members: MiniGroupMember[]): string[] | null {
  if (members.length === 0) return null;
  const first = memberPattern(members[0]);
  return members.every((member) => samePattern(memberPattern(member), first)) ? [...first] : null;
}

export function createMiniGroup(scene: Scene, group: MiniGroupItem): Scene {
  if (scene.items.some((item) => item.id === group.id)) return scene;

  const memberIds = Array.from(new Set(group.memberIds));
  if (memberIds.length < 2) return scene;
  const memberIdSet = new Set(memberIds);
  const members = scene.items.filter(
    (item): item is MiniGroupMember => memberIdSet.has(item.id) && isMiniGroupable(item),
  );
  if (members.length !== memberIds.length) return scene;

  const colorPattern = sharedMiniGroupColorPattern(members);
  if (!colorPattern) return scene;

  const items = scene.items.map((item) => {
    if (!memberIdSet.has(item.id) || (!isStrand(item) && !isMiniArea(item))) return item;
    return { ...item, groupId: group.id, colorPattern: [...colorPattern] };
  });
  return {
    ...scene,
    items: [
      ...items,
      { ...group, memberIds, colorPattern: [...colorPattern] },
    ],
  };
}

function authoritativePattern(group: MiniGroupItem, members: MiniGroupMember[]): string[] | null {
  if (group.colorPattern?.length) return [...group.colorPattern];
  return sharedMiniGroupColorPattern(members);
}

export type ResolvedMiniGroupSelection = {
  group: MiniGroupItem;
  addableMembers: MiniGroupMember[];
};

export function resolveMiniGroupSelection(
  items: SceneItem[],
  selectedIds: ReadonlySet<string>,
): ResolvedMiniGroupSelection | null {
  const selected = items.filter((item) => selectedIds.has(item.id));
  const miniMembers = selected.filter((item): item is MiniGroupMember => isStrand(item) || isMiniArea(item));
  if (selected.length === 0 || miniMembers.length !== selected.length) return null;

  const groupIds = Array.from(new Set(miniMembers.flatMap((item) => item.groupId ? [item.groupId] : [])));
  if (groupIds.length !== 1) return null;

  const group = items.find((item): item is MiniGroupItem => isMiniGroup(item) && item.id === groupIds[0]);
  if (!group) return null;

  const addableMembers: MiniGroupMember[] = [];
  for (const item of miniMembers) {
    if (item.groupId === group.id) {
      if (!group.memberIds.includes(item.id)) return null;
      continue;
    }
    if (!isMiniGroupable(item)) return null;
    addableMembers.push(item);
  }

  return { group, addableMembers };
}

export function addMiniGroupMembers(scene: Scene, groupId: string, candidateIds: string[]): Scene {
  const group = scene.items.find((item): item is MiniGroupItem => isMiniGroup(item) && item.id === groupId);
  if (!group) return scene;

  const candidateSet = new Set(candidateIds);
  const addableIds = scene.items
    .filter((item) => candidateSet.has(item.id) && isMiniGroupable(item))
    .map((item) => item.id);
  if (addableIds.length === 0) return scene;

  const addableSet = new Set(addableIds);
  const currentMembers = scene.items.filter(
    (item): item is MiniGroupMember =>
      group.memberIds.includes(item.id) &&
      (isStrand(item) || isMiniArea(item)) &&
      item.groupId === groupId,
  );
  const pattern = authoritativePattern(group, currentMembers);
  if (!pattern) return scene;

  const currentMemberIds = new Set(currentMembers.map((member) => member.id));
  const appendedIds = addableIds.filter((id) => !group.memberIds.includes(id));
  const items = scene.items.map((item) => {
    if (isMiniGroup(item) && item.id === groupId) {
      return { ...item, memberIds: [...item.memberIds, ...appendedIds], colorPattern: [...pattern] };
    }
    if (addableSet.has(item.id) && (isStrand(item) || isMiniArea(item))) {
      return { ...item, groupId, colorPattern: [...pattern] };
    }
    if (currentMemberIds.has(item.id) && (isStrand(item) || isMiniArea(item)) && !samePattern(memberPattern(item), pattern)) {
      return { ...item, colorPattern: [...pattern] };
    }
    return item;
  });

  return { ...scene, items };
}

export function setMiniGroupMemberSpacing(scene: Scene, groupId: string, spacingIn: number): Scene {
  const group = scene.items.find((item): item is MiniGroupItem => isMiniGroup(item) && item.id === groupId);
  if (!group || !Number.isFinite(spacingIn) || spacingIn <= 0) return scene;

  const memberIds = new Set(group.memberIds);
  let changed = false;
  const items = scene.items.map((item) => {
    if (!memberIds.has(item.id) || !isStrand(item) || item.groupId !== groupId || item.spacingIn === spacingIn) return item;
    changed = true;
    return { ...item, spacingIn };
  });

  return changed ? { ...scene, items } : scene;
}

export function updateMiniGroupMemberColorPatterns(
  scene: Scene,
  groupId: string,
  update: (pattern: string[]) => string[],
): Scene {
  const group = scene.items.find((item): item is MiniGroupItem => isMiniGroup(item) && item.id === groupId);
  if (!group) return scene;

  const memberIds = new Set(group.memberIds);
  const members = scene.items.filter(
    (item): item is MiniGroupMember =>
      memberIds.has(item.id) &&
      (isStrand(item) || isMiniArea(item)) &&
      item.groupId === groupId,
  );
  const current = authoritativePattern(group, members) ?? (members[0] ? [...memberPattern(members[0])] : ['warm-white']);
  const requested = update([...current]);
  const next = requested.length > 0 ? [...requested] : [current[0] ?? 'warm-white'];
  let changed = false;
  const items = scene.items.map((item) => {
    if (isMiniGroup(item) && item.id === groupId) {
      if (item.colorPattern && samePattern(item.colorPattern, next)) return item;
      changed = true;
      return { ...item, colorPattern: [...next] };
    }
    if (!memberIds.has(item.id) || (!isStrand(item) && !isMiniArea(item)) || item.groupId !== groupId) return item;
    if (samePattern(memberPattern(item), next)) return item;

    changed = true;
    return { ...item, colorPattern: [...next] };
  });

  return changed ? { ...scene, items } : scene;
}

export function updateSelectedColorPatterns(
  scene: Scene,
  selectedIds: ReadonlySet<string>,
  update: (pattern: string[]) => string[],
): Scene {
  const groupsById = new Map(
    scene.items
      .filter(isMiniGroup)
      .map((group) => [group.id, group] as const),
  );
  const selectedGroupIds = new Set<string>();
  for (const item of scene.items) {
    if (!selectedIds.has(item.id) || (!isStrand(item) && !isMiniArea(item)) || !item.groupId) continue;
    const group = groupsById.get(item.groupId);
    if (group?.memberIds.includes(item.id)) selectedGroupIds.add(group.id);
  }

  let updated = scene;
  for (const groupId of selectedGroupIds) {
    updated = updateMiniGroupMemberColorPatterns(updated, groupId, update);
  }

  let changed = updated !== scene;
  const items = updated.items.map((item) => {
    if (!selectedIds.has(item.id) || (!isStrand(item) && !isMiniArea(item)) || item.groupId) return item;
    const current = memberPattern(item);
    const requested = update([...current]);
    const next = requested.length > 0 ? [...requested] : [current[0] ?? 'warm-white'];
    if (samePattern(current, next)) return item;
    changed = true;
    return { ...item, colorPattern: next };
  });

  return changed ? { ...updated, items } : scene;
}

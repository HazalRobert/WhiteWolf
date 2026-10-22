/**
 * All runtime helpers stay inside this function so it can be serialized into an X page.
 * person/viewer/userGraphql return Person; relationFromUser accepts a raw User result;
 * followingGraphql returns { users, nextCursor, relations, unavailableCount? }. No browser access is used.
 */
export function parseXPayload(
  kind: 'person' | 'followingGraphql' | 'viewer' | 'userGraphql' | 'relationFromUser',
  payload: unknown,
  context: { actorId?: string; expectedId?: string; targetId?: string; cursor?: string } = {},
): unknown {
  type ObjectValue = Record<string, unknown>;
  type PersonValue = { id: string; handle: string; name: string; avatar?: string; bio?: string };
  type RelationValue = { id: string; following: boolean | null; followedBy: boolean | null };
  const fail = (message: string): never => { throw new Error(`SCHEMA: ${message}`); };
  const object = (value: unknown, path: string): ObjectValue => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${path} must be an object.`);
    return value as ObjectValue;
  };
  const optionalObject = (value: unknown, path: string): ObjectValue => value === undefined || value === null ? {} : object(value, path);
  const string = (value: unknown, path: string): string => {
    if (typeof value !== 'string') return fail(`${path} must be a string.`);
    return value;
  };
  const id = (value: unknown, path: string): string => {
    const result = string(value, path);
    if (!/^[1-9][0-9]{0,19}$/.test(result)) return fail(`${path} must be a lossless decimal user ID.`);
    return result;
  };
  // Diagnostic paths are fixed call-site labels, never response keys, entry IDs or account data.
  const resultType = (value: unknown): string => value === undefined ? 'missing'
    : typeof value === 'string' && /^User[A-Za-z0-9]{0,60}$/.test(value) ? value : 'unrecognized';
  const unwrapUserResult = (raw: unknown, path: string): { value: ObjectValue; path: string } => {
    let value = object(raw, path);
    if (value.__typename === 'UserWithVisibilityResults') {
      path += '.user';
      value = object(value.user, path);
    }
    return { value, path };
  };
  const userResult = (raw: unknown, path = 'User result'): ObjectValue => {
    const result = unwrapUserResult(raw, path);
    if (result.value.__typename !== undefined && result.value.__typename !== 'User') {
      return fail(`Unsupported or unavailable User result; path=${result.path}; typename=${resultType(result.value.__typename)}.`);
    }
    return result.value;
  };
  const userId = (value: ObjectValue): string => {
    const legacy = optionalObject(value.legacy, 'User.legacy');
    const candidates = [value.rest_id, value.id_str, legacy.id_str].filter(item => item !== undefined);
    if (!candidates.length) return fail('User result has no string ID.');
    const ids = candidates.map(item => id(item, 'User ID'));
    if (ids.some(item => item !== ids[0])) return fail('User result contains contradictory IDs.');
    return ids[0];
  };
  const expectId = (actual: string, expected: string | undefined): void => {
    if (expected !== undefined && actual !== id(expected, 'Expected user ID')) return fail('User result does not match the expected ID.');
  };
  const firstString = (values: unknown[], path: string, required = false): string | undefined => {
    const present = values.filter(value => value !== undefined && value !== null);
    for (const value of present) string(value, path);
    if (!present.length) {
      if (required) return fail(`${path} is missing.`);
      return undefined;
    }
    return present[0] as string;
  };
  const person = (raw: unknown, path = 'User result'): PersonValue => {
    const value = userResult(raw, path);
    const legacy = optionalObject(value.legacy, 'User.legacy');
    const core = optionalObject(value.core, 'User.core');
    const avatar = optionalObject(value.avatar, 'User.avatar');
    const bio = optionalObject(value.profile_bio, 'User.profile_bio');
    const handles = [core.screen_name, legacy.screen_name, value.screen_name].filter(item => item !== undefined && item !== null);
    const username = firstString(handles, 'User.screen_name', true)!;
    if (handles.some(item => !/^[A-Za-z0-9_]{1,15}$/.test(item as string))) return fail('User.screen_name is invalid.');
    if (handles.some(item => (item as string).toLowerCase() !== username.toLowerCase())) return fail('User result contains contradictory handles.');
    const result: PersonValue = { id: userId(value), handle: username, name: firstString([core.name, legacy.name, value.name], 'User.name', true)! };
    const image = firstString([avatar.image_url, legacy.profile_image_url_https, value.profile_image_url_https], 'User avatar');
    const description = firstString([bio.description, legacy.description, value.description], 'User description');
    if (image && /^https:\/\//i.test(image)) result.avatar = image;
    if (description !== undefined) result.bio = description;
    return result;
  };
  const relation = (raw: unknown, path = 'User result'): RelationValue => {
    const value = userResult(raw, path);
    const perspectives = optionalObject(value.relationship_perspectives, 'User.relationship_perspectives');
    const legacy = optionalObject(value.legacy, 'User.legacy');
    const boolean = (field: 'following' | 'followed_by'): boolean | null => {
      const values = [perspectives[field], legacy[field], value[field]].filter(item => item !== undefined && item !== null);
      if (values.some(item => typeof item !== 'boolean')) return fail(`User.${field} must be a boolean when present.`);
      if (values.some(item => item !== values[0])) return fail(`User.${field} contains contradictory relationship values.`);
      return values.length ? values[0] as boolean : null;
    };
    return { id: userId(value), following: boolean('following'), followedBy: boolean('followed_by') };
  };
  const envelopeData = (): ObjectValue => {
    const root = object(payload, 'GraphQL response');
    if ((root.errors !== undefined && (!Array.isArray(root.errors) || root.errors.length > 0)) || root.error !== undefined) return fail('GraphQL returned an error envelope; partial data is not trusted.');
    return object(root.data, 'GraphQL response.data');
  };

  if (kind === 'person') {
    const result = person(payload, 'person');
    expectId(result.id, context.expectedId ?? context.targetId);
    return result;
  }
  if (kind === 'relationFromUser') {
    const result = relation(payload, 'relationFromUser');
    expectId(result.id, context.expectedId ?? context.targetId);
    return result;
  }
  if (kind === 'viewer') {
    const viewer = object(envelopeData().viewer, 'data.viewer');
    const result = person(object(viewer.user_results, 'data.viewer.user_results').result, 'data.viewer.user_results.result');
    expectId(result.id, context.expectedId ?? context.actorId);
    return result;
  }
  if (kind === 'userGraphql') {
    const result = person(object(envelopeData().user, 'data.user').result, 'data.user.result');
    expectId(result.id, context.expectedId ?? context.targetId);
    return result;
  }
  if (kind !== 'followingGraphql') return fail('Unknown parser kind.');

  const rootUser = userResult(object(envelopeData().user, 'data.user').result, 'data.user.result');
  if (rootUser.rest_id !== undefined || rootUser.id_str !== undefined) expectId(userId(rootUser), context.actorId ?? context.expectedId);
  if (rootUser.timeline !== undefined && rootUser.timeline_v2 !== undefined) return fail('Following response has ambiguous timeline containers.');
  const timelineRoot = object(rootUser.timeline ?? rootUser.timeline_v2, 'Following timeline container');
  const timeline = object(timelineRoot.timeline, 'Following timeline');
  if (!Array.isArray(timeline.instructions)) return fail('Following timeline has no explicit instructions.');
  // The current X timeline reducer clears the requested cursor for an empty instructions
  // array. An empty AddEntries array is a different response and is not a terminal signal.
  if (timeline.instructions.length === 0) return {users:[],nextCursor:'0',relations:[]};

  const entries = new Map<string, ObjectValue>();
  let terminatedBottom = false;
  const putEntry = (raw: unknown, replacement?: string): void => {
    const entry = object(raw, 'Timeline entry');
    const entryId = string(entry.entryId, 'Timeline entry.entryId');
    if (!entryId) return fail('Timeline entry ID is empty.');
    if (replacement !== undefined) {
      if (!entries.has(replacement)) {
        const content = object(entry.content, 'Replacement entry.content');
        if (content.entryType !== 'TimelineTimelineCursor' && content.__typename !== 'TimelineTimelineCursor') return fail('Following user replacement has no page-local target.');
      }
      entries.delete(replacement);
    }
    if (entries.has(entryId)) return fail('Following timeline contains duplicate entry IDs.');
    entries.set(entryId, entry);
  };
  for (const [instructionIndex, raw] of timeline.instructions.entries()) {
    const instruction = object(raw, 'Timeline instruction');
    if (instruction.type === 'TimelineClearCache') {
      // The native reducer resets the timeline at this exact instruction position.
      // A reset on a continuation page invalidates already accumulated pages; do not
      // silently merge the replacement timeline with those earlier scan results.
      if (context.cursor !== undefined && context.cursor !== '-1') return fail(`Following timeline reset during pagination; type=TimelineClearCache; index=${instructionIndex}. Restart the scan.`);
      entries.clear();
      terminatedBottom = false;
    } else if (instruction.type === 'TimelineAddEntries') {
      if (!Array.isArray(instruction.entries)) return fail('TimelineAddEntries.entries must be an array.');
      for (const entry of instruction.entries) putEntry(entry);
    } else if (instruction.type === 'TimelineReplaceEntry') {
      const replacement = string(instruction.entry_id_to_replace, 'TimelineReplaceEntry.entry_id_to_replace');
      if (!replacement) return fail('Timeline replacement ID is empty.');
      putEntry(instruction.entry, replacement);
    } else if (instruction.type === 'TimelineTerminateTimeline') {
      if (!['Top', 'Bottom', 'TopAndBottom'].includes(instruction.direction as string)) return fail('Timeline termination direction is unknown.');
      if (instruction.direction === 'Bottom' || instruction.direction === 'TopAndBottom') terminatedBottom = true;
    } else {
      const type = typeof instruction.type === 'string' && /^Timeline[A-Za-z0-9]{1,64}$/.test(instruction.type)
        ? instruction.type : instruction.type === undefined ? 'missing' : 'unrecognized';
      return fail(`Unsupported Following timeline instruction; type=${type}; index=${instructionIndex}.`);
    }
  }

  const users: PersonValue[] = [];
  const relations: RelationValue[] = [];
  const userIds = new Set<string>();
  let unavailableCount = 0;
  let bottomCursor: string | undefined;
  const entryType = (value: ObjectValue, field: 'entryType' | 'itemType', path: string): string => {
    const declared = [value[field], value.__typename].filter(item => item !== undefined);
    if (!declared.length || declared.some(item => typeof item !== 'string') || declared.some(item => item !== declared[0])) return fail(`${path} has no unambiguous known type.`);
    return declared[0] as string;
  };
  for (const entry of entries.values()) {
    const content = object(entry.content, 'Timeline entry.content');
    const type = entryType(content, 'entryType', 'Timeline entry.content');
    if (type === 'TimelineTimelineCursor') {
      if (content.cursorType !== 'Top' && content.cursorType !== 'Bottom') return fail('Following cursor type is unknown.');
      const value = string(content.value, 'Following cursor.value');
      if (!value || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return fail('Following cursor value is invalid.');
      if (content.cursorType === 'Bottom') {
        if (bottomCursor !== undefined) return fail('Following response contains multiple Bottom cursors.');
        bottomCursor = value;
      }
    } else if (type === 'TimelineTimelineItem') {
      const item = object(content.itemContent, 'Timeline itemContent');
      if (entryType(item, 'itemType', 'Timeline itemContent') !== 'TimelineUser') return fail('Following entry is not an explicit TimelineUser.');
      if (item.promotedMetadata !== undefined || content.promotedMetadata !== undefined) return fail('Promoted entries cannot establish a following relationship.');
      const rawUser = object(item.user_results, 'TimelineUser.user_results').result;
      const userPath = 'Following.TimelineUser.user_results.result';
      const unwrapped = unwrapUserResult(rawUser, userPath);
      // A known unavailable placeholder is not an actionable user or a negative
      // follow-back relationship. Count it only after ClearCache/ReplaceEntry folding.
      // Keep the same cursor rules, including pages containing only placeholders.
      if (unwrapped.value.__typename === 'UserUnavailable') { unavailableCount++; continue; }
      const user = person(rawUser, userPath);
      if (userIds.has(user.id)) return fail('Following page contains duplicate user IDs.');
      userIds.add(user.id);
      users.push(user);
      relations.push(relation(rawUser, userPath));
    } else return fail('Unsupported Following entry wrapper.');
  }
  if (bottomCursor === undefined && !terminatedBottom) return fail('Following response has no explicit Bottom cursor or terminal page.');
  // X retains cursor entries when terminating a direction. fetchBottom checks the
  // termination flag before the cursor, so a stale/nonzero cursor is not a conflict.
  const nextCursor = terminatedBottom ? '0' : bottomCursor!;
  if (nextCursor !== '0' && context.cursor !== undefined && nextCursor === context.cursor) return fail('Following cursor did not advance.');
  return { users, nextCursor, relations, ...(unavailableCount > 0 ? { unavailableCount } : {}) };
}

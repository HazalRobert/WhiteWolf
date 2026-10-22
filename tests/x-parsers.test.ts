import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { parseXPayload } from '../src/x-parsers';

// Synthetic public-schema examples only: these are not captured accounts or live API responses.
const modernUser = (id = '101') => ({
  __typename: 'User', rest_id: id,
  core: { name: 'Example Account', screen_name: `example_${id}` },
  avatar: { image_url: 'https://example.test/avatar.png' },
  profile_bio: { description: 'Synthetic fixture account.' },
  relationship_perspectives: { following: true, followed_by: false },
});
const legacyUser = (id = '102') => ({
  __typename: 'User', rest_id: id,
  legacy: { name: 'Legacy Example', screen_name: `example_${id}`, description: 'Legacy fixture.',
    profile_image_url_https: 'https://example.test/legacy.png', following: true, followed_by: true },
});
const userEntry = (user: unknown, entryId = 'user-101') => ({ entryId, content: {
  entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem',
  itemContent: { itemType: 'TimelineUser', __typename: 'TimelineUser', user_results: { result: user } },
} });
const cursorEntry = (value = 'opaque-next-token', entryId = 'cursor-bottom-1', cursorType = 'Bottom') => ({ entryId, content: {
  entryType: 'TimelineTimelineCursor', __typename: 'TimelineTimelineCursor', cursorType, value,
} });
const page = (instructions: unknown[], field = 'timeline') => ({ data: { user: { result: {
  __typename: 'User', rest_id: '900', [field]: { timeline: { instructions } },
} } } });
const add = (entries: unknown[]) => ({ type: 'TimelineAddEntries', entries });
const following = (payload: unknown, context = {}) => parseXPayload('followingGraphql', payload, context) as {
  users: { id: string; handle: string; name: string }[]; nextCursor: string; unavailableCount?: number;
  relations: { id: string; following: boolean | null; followedBy: boolean | null }[];
};

test('modern core/avatar/profile_bio and legacy users produce normalized persons', () => {
  assert.deepEqual(parseXPayload('person', modernUser()), { id: '101', handle: 'example_101', name: 'Example Account', avatar: 'https://example.test/avatar.png', bio: 'Synthetic fixture account.' });
  assert.deepEqual(parseXPayload('person', legacyUser()), { id: '102', handle: 'example_102', name: 'Legacy Example', avatar: 'https://example.test/legacy.png', bio: 'Legacy fixture.' });
  assert.deepEqual(parseXPayload('person', { id_str: '103', screen_name: 'rest_example', name: 'REST Example' }), { id: '103', handle: 'rest_example', name: 'REST Example' });
});
test('IDs stay lossless and contradictory identity fields are rejected', () => {
  const large = { ...modernUser(), rest_id: '1922333444555666777' };
  assert.equal((parseXPayload('person', large) as { id: string }).id, '1922333444555666777');
  for (const user of [{ ...modernUser(), rest_id: 101 }, { ...modernUser(), id_str: '102' }, { ...modernUser(), legacy: { screen_name: 'other_user' } }]) assert.throws(() => parseXPayload('person', user), /SCHEMA:/);
});
test('explicit visibility wrappers work while unavailable or unknown users fail', () => {
  assert.deepEqual(parseXPayload('person', { __typename: 'UserWithVisibilityResults', user: modernUser() }), parseXPayload('person', modernUser()));
  for (const user of [{ __typename: 'UserUnavailable', reason: 'Unavailable' }, { __typename: 'Unexpected', user: modernUser() }, { user: modernUser() }]) assert.throws(() => parseXPayload('person', user), /SCHEMA:/);
});
test('Viewer and User envelopes use their exact paths and validate expected identities', () => {
  const viewer = { data: { viewer: { user_results: { result: modernUser() } } } };
  const user = { data: { user: { result: modernUser() } } };
  assert.deepEqual(parseXPayload('viewer', viewer, { actorId: '101' }), parseXPayload('person', modernUser()));
  assert.deepEqual(parseXPayload('userGraphql', user, { targetId: '101' }), parseXPayload('person', modernUser()));
  assert.throws(() => parseXPayload('viewer', viewer, { actorId: '102' }), /expected ID/);
  assert.throws(() => parseXPayload('userGraphql', user, { targetId: '102' }), /expected ID/);
  assert.throws(() => parseXPayload('viewer', user), /SCHEMA:/);
  assert.throws(() => parseXPayload('userGraphql', viewer), /SCHEMA:/);
});
test('GraphQL error envelopes never turn partial data into accepted users', () => {
  const payload = { data: { user: { result: modernUser() } }, errors: [{ message: 'Synthetic error' }] };
  assert.throws(() => parseXPayload('userGraphql', payload), /partial data/);
  assert.equal(following({ ...page([]), errors: [] }).nextCursor, '0');
});
test('relationship perspectives and legacy booleans preserve unknown versus false', () => {
  assert.deepEqual(parseXPayload('relationFromUser', modernUser()), { id: '101', following: true, followedBy: false });
  assert.deepEqual(parseXPayload('relationFromUser', legacyUser()), { id: '102', following: true, followedBy: true });
  assert.deepEqual(parseXPayload('relationFromUser', { __typename: 'User', rest_id: '103' }), { id: '103', following: null, followedBy: null });
  assert.deepEqual(parseXPayload('relationFromUser', { ...modernUser(), relationship_perspectives: { following: true } }), { id: '101', following: true, followedBy: null });
  assert.deepEqual(parseXPayload('relationFromUser', { ...modernUser(), relationship_perspectives: { following: null }, legacy: { following: false } }), { id: '101', following: false, followedBy: null });
});
test('contradictory or nonboolean relationship fields fail rather than guessing non-mutual', () => {
  for (const user of [
    { ...modernUser(), legacy: { followed_by: true } },
    { ...modernUser(), legacy: { following: false } },
    { ...modernUser(), relationship_perspectives: { following: 'true', followed_by: false } },
    { ...modernUser(), legacy: { followed_by: 0 } },
  ]) assert.throws(() => parseXPayload('relationFromUser', user), /SCHEMA:/);
});
test('both known Following timeline containers return users, relations and opaque Bottom cursors', () => {
  for (const field of ['timeline', 'timeline_v2']) {
    const result = following(page([add([userEntry(modernUser()), cursorEntry('opaque-token==')])], field), { actorId: '900', cursor: 'previous-token' });
    assert.equal(result.users[0].id, '101');
    assert.equal(result.nextCursor, 'opaque-token==');
    assert.deepEqual(result.relations, [{ id: '101', following: true, followedBy: false }]);
  }
});
// Shape evidence: X's public main.50f2837e51ebc2a7a.js (modules 281336 and 127707)
// omits non-User TimelineUser results. Its user-query handler explicitly recognizes
// UserUnavailable and reason Suspended. Values below are synthetic, not a live capture.
const unavailableUser = () => ({ __typename: 'UserUnavailable', reason: 'Suspended', message: 'Synthetic unavailable account.' });

test('Following counts explicit unavailable entries without inventing users, identities or relationships', () => {
  const unavailable = { ...unavailableUser(), rest_id: '999', core: { screen_name: 'must_not_display', name: 'Hidden' }, relationship_perspectives: { following: true, followed_by: false } };
  const result = following(page([add([userEntry(modernUser()), userEntry(unavailable, 'user-999'), cursorEntry('next-page')])]), { cursor: 'previous-page' });
  assert.deepEqual(result.users, [parseXPayload('person', modernUser())]);
  assert.deepEqual(result.relations, [{ id: '101', following: true, followedBy: false }]);
  assert.equal(result.nextCursor, 'next-page');
  assert.equal(result.unavailableCount, 1);
  assert.equal(JSON.stringify(result).includes('must_not_display'), false);
  assert.equal(JSON.stringify(result).includes('999'), false);
  assert.equal(Object.hasOwn(following(page([add([userEntry(modernUser()), cursorEntry()])])), 'unavailableCount'), false);
});

test('a Following page containing only unavailable entries retains its verified continuation or terminal state', () => {
  const entries = [userEntry(unavailableUser(), 'user-201'), userEntry({ __typename: 'UserUnavailable' }, 'user-202')];
  assert.deepEqual(following(page([add([...entries, cursorEntry('opaque-next')])]), { cursor: 'opaque-previous' }),
    { users: [], nextCursor: 'opaque-next', relations: [], unavailableCount: 2 });
  assert.deepEqual(following(page([add(entries), { type: 'TimelineTerminateTimeline', direction: 'Bottom' }])),
    { users: [], nextCursor: '0', relations: [], unavailableCount: 2 });
  assert.throws(() => following(page([add(entries)])), /no explicit Bottom/);
  assert.throws(() => following(page([add([...entries, cursorEntry('same')])]), { cursor: 'same' }), /did not advance/);
  assert.throws(() => following(page([add([...entries, cursorEntry('bad cursor')])])), /cursor value/);
});

test('only the existing explicit visibility wrapper may contain an unavailable Following result', () => {
  const wrapped = { __typename: 'UserWithVisibilityResults', user: unavailableUser() };
  assert.deepEqual(following(page([add([userEntry(wrapped), cursorEntry('0')])])),
    { users: [], nextCursor: '0', relations: [], unavailableCount: 1 });
  for (const invalid of [
    { __typename: 'UnknownWrapper', user: unavailableUser() },
    { __typename: 'UserWithVisibilityResults', user: { __typename: 'UserWithVisibilityResults', user: unavailableUser() } },
    { user: unavailableUser() },
  ]) assert.throws(() => following(page([add([userEntry(invalid), cursorEntry('0')])])), /SCHEMA:/);
});

test('unavailable roots, Viewer, user lookup, persons and relationship lookup remain strict', () => {
  for (const raw of [unavailableUser(), { __typename: 'UserWithVisibilityResults', user: unavailableUser() }]) {
    assert.throws(() => parseXPayload('person', raw), /path=person(?:\.user)?; typename=UserUnavailable/);
    assert.throws(() => parseXPayload('relationFromUser', raw), /path=relationFromUser(?:\.user)?; typename=UserUnavailable/);
    assert.throws(() => parseXPayload('viewer', { data: { viewer: { user_results: { result: raw } } } }), /path=data\.viewer\.user_results\.result(?:\.user)?; typename=UserUnavailable/);
    assert.throws(() => parseXPayload('userGraphql', { data: { user: { result: raw } } }), /path=data\.user\.result(?:\.user)?; typename=UserUnavailable/);
    assert.throws(() => following({ data: { user: { result: { ...raw, timeline: { timeline: { instructions: [] } } } } } }), /path=data\.user\.result(?:\.user)?; typename=UserUnavailable/);
  }
});

test('Following never skips unknown result types, malformed users or absent results', () => {
  for (const raw of [null, undefined, [], {}, { __typename: 'User' },
    { __typename: 'UserUnknownFutureType' }, { __typename: 'TweetTombstone' },
    { __typename: 'UserWithVisibilityResults', user: null },
    { __typename: 'UserWithVisibilityResults', user: { __typename: 'UserUnknownFutureType' } },
    { ...modernUser(), rest_id: 101 },
  ]) assert.throws(() => following(page([add([userEntry(raw), cursorEntry('0')])])), /SCHEMA:/);
});

test('unknown User diagnostics expose only fixed paths and bounded type names', () => {
  assert.throws(() => following(page([add([userEntry({ __typename: 'UserUnknownFutureType' }), cursorEntry('0')])])),
    /path=Following\.TimelineUser\.user_results\.result; typename=UserUnknownFutureType/);
  for (const typename of [null, 42, {}, 'User' + 'A'.repeat(61), 'UserBad\nprivate-secret', 'private-secret', 'UserBad;token=secret']) {
    let message = '';
    try { following(page([add([userEntry({ __typename: typename, reason: 'private-reason', message: 'private-message', rest_id: '1922333444555666777' }, 'private-entry-id'), cursorEntry('0')])])); }
    catch (error) { message = (error as Error).message; }
    assert.match(message, /path=Following\.TimelineUser\.user_results\.result; typename=unrecognized/);
    assert.ok(message.length < 256);
    assert.equal(/private-|1922333444555666777|token=secret|[\r\n]/.test(message), false);
  }
});

test('ClearCache discards unavailable entries that precede its position', () => {
  assert.deepEqual(following(page([
    add([userEntry(unavailableUser()), cursorEntry('before-reset')]),
    { type: 'TimelineClearCache' }, add([userEntry(modernUser()), cursorEntry('0')]),
  ]), { cursor: '-1' }), following(page([add([userEntry(modernUser()), cursorEntry('0')])])));
  assert.deepEqual(following(page([
    add([userEntry(modernUser()), cursorEntry('before-reset')]), { type: 'TimelineClearCache' },
    add([userEntry(unavailableUser()), cursorEntry('0')]),
  ]), { cursor: '-1' }), { users: [], nextCursor: '0', relations: [], unavailableCount: 1 });
});

test('ReplaceEntry counts only the final User or unavailable replacement', () => {
  const replacement = (user: unknown) => ({ type: 'TimelineReplaceEntry', entry_id_to_replace: 'user-101', entry: userEntry(user, 'user-202') });
  const restored = following(page([add([userEntry(unavailableUser()), cursorEntry('next')]), replacement(modernUser('202'))]));
  assert.deepEqual(restored.users.map(user => user.id), ['202']);
  assert.deepEqual(restored.relations, [{ id: '202', following: true, followedBy: false }]);
  assert.equal(Object.hasOwn(restored, 'unavailableCount'), false);
  assert.deepEqual(following(page([add([userEntry(modernUser()), cursorEntry('next')]), replacement(unavailableUser())])),
    { users: [], nextCursor: 'next', relations: [], unavailableCount: 1 });
  assert.throws(() => following(page([replacement(unavailableUser()), add([cursorEntry('0')])])), /no page-local target/);
});

test('unavailable entries do not bypass promotion, wrapper or duplicate-entry checks', () => {
  const promoted = userEntry(unavailableUser());
  Object.assign(promoted.content.itemContent, { promotedMetadata: {} });
  assert.throws(() => following(page([add([promoted, cursorEntry('0')])])), /Promoted/);
  assert.throws(() => following(page([add([userEntry(unavailableUser()), userEntry(unavailableUser()), cursorEntry('0')])])), /duplicate entry/);
  const unknown = userEntry(unavailableUser());
  Object.assign(unknown.content, { entryType: 'UnknownWrapper', __typename: 'UnknownWrapper' });
  assert.throws(() => following(page([add([unknown, cursorEntry('0')])])), /Unsupported Following entry wrapper/);
});

test('known entry typename can stand alone but inconsistent declarations fail', () => {
  const entry = userEntry(modernUser()) as unknown as { entryId: string; content: Record<string, unknown> };
  delete entry.content.entryType;
  assert.equal(following(page([add([entry, cursorEntry()])])).users.length, 1);
  entry.content.entryType = 'Unexpected';
  assert.throws(() => following(page([add([entry, cursorEntry()])])), /unambiguous/);
});
test('Top cursors are ignored for pagination and missing Bottom is never guessed', () => {
  const top = cursorEntry('top-token', 'cursor-top-1', 'Top');
  assert.equal(following(page([add([top, userEntry(modernUser()), cursorEntry('bottom-token')])])).nextCursor, 'bottom-token');
  assert.throws(() => following(page([add([top, userEntry(modernUser())])])), /no explicit Bottom/);
  assert.throws(() => following(page([add([userEntry(modernUser())])])), /no explicit Bottom/);
  assert.throws(() => following(page([add([top])])), /no explicit Bottom/);
});
test('empty native instructions and Bottom termination can finish pagination', () => {
  assert.deepEqual(following(page([])), { users: [], nextCursor: '0', relations: [] });
  assert.throws(() => following(page([add([])])), /no explicit Bottom/);
  assert.equal(following(page([add([userEntry(modernUser())]), { type: 'TimelineTerminateTimeline', direction: 'Bottom' }])).nextCursor, '0');
  assert.equal(following(page([{ type: 'TimelineTerminateTimeline', direction: 'TopAndBottom' }])).nextCursor, '0');
  assert.throws(() => following(page([{ type: 'TimelineTerminateTimeline', direction: 'Both' }])), /direction/);
  assert.throws(() => following(page([{ type: 'TimelineTerminateTimeline', direction: 'Top' }])), /no explicit Bottom/);
});

test('an initial ClearCache followed by entries preserves only the new Following page', () => {
  const result=following(page([{type:'TimelineClearCache'},add([userEntry(modernUser()),cursorEntry('next-after-reset')])]),{actorId:'900',cursor:'-1'});
  assert.deepEqual(result.users.map(user=>user.id),['101']);
  assert.deepEqual(result.relations,[{id:'101',following:true,followedBy:false}]);
  assert.equal(result.nextCursor,'next-after-reset');
});

test('ClearCache applies at its position and removes users and cursors added before the reset', () => {
  const result=following(page([
    add([userEntry(modernUser()),cursorEntry('old-next')]),
    {type:'TimelineClearCache'},
    add([userEntry(legacyUser(),'user-102'),cursorEntry('new-next')]),
  ]),{cursor:'-1'});
  assert.deepEqual(result.users.map(user=>user.id),['102']);
  assert.deepEqual(result.relations,[{id:'102',following:true,followedBy:true}]);
  assert.equal(result.nextCursor,'new-next');
});

test('a late ClearCache cannot retain earlier users or an earlier terminal signal', () => {
  const clear={type:'TimelineClearCache'},terminate={type:'TimelineTerminateTimeline',direction:'Bottom'};
  const result=following(page([add([userEntry(modernUser()),cursorEntry()]),clear,terminate]),{cursor:'-1'});
  assert.deepEqual(result,{users:[],nextCursor:'0',relations:[]});
  assert.throws(()=>following(page([add([userEntry(modernUser()),cursorEntry()]),terminate,clear]),{cursor:'-1'}),/no explicit Bottom/);
  assert.throws(()=>following(page([clear]),{cursor:'-1'}),/no explicit Bottom/);
});

test('ClearCache resets Bottom termination before a new nonterminal cursor is added', () => {
  const result=following(page([
    add([userEntry(modernUser()),cursorEntry('old-next')]),
    {type:'TimelineTerminateTimeline',direction:'TopAndBottom'},
    {type:'TimelineClearCache'},
    add([userEntry(legacyUser(),'user-102'),cursorEntry('new-next')]),
  ]),{cursor:'-1'});
  assert.deepEqual(result.users.map(user=>user.id),['102']);
  assert.equal(result.nextCursor,'new-next');
});

test('a continuation-page ClearCache rejects the entire page instead of merging a restarted timeline', () => {
  for(const instructions of [
    [{type:'TimelineClearCache'},add([userEntry(modernUser()),cursorEntry('0')])],
    [add([userEntry(modernUser()),cursorEntry('0')]),{type:'TimelineClearCache'},{type:'TimelineTerminateTimeline',direction:'Bottom'}],
  ])assert.throws(()=>following(page(instructions),{actorId:'900',cursor:'previous-page-token'}),/SCHEMA:.*reset during pagination/);
});

test('Bottom termination wins over a retained nonzero cursor in either instruction order without losing users', () => {
  for(const direction of ['Bottom','TopAndBottom'])for(const terminateFirst of [false,true]){
    const added=add([userEntry(modernUser()),cursorEntry('retained-nonzero-cursor')]);
    const terminate={type:'TimelineTerminateTimeline',direction};
    const result=following(page(terminateFirst?[terminate,added]:[added,terminate]),{cursor:'previous-page-token'});
    assert.deepEqual(result.users.map(user=>user.id),['101']);
    assert.deepEqual(result.relations,[{id:'101',following:true,followedBy:false}]);
    assert.equal(result.nextCursor,'0');
  }
  assert.equal(following(page([add([cursorEntry('next')]),{type:'TimelineTerminateTimeline',direction:'Top'}])).nextCursor,'next');
});
test('empty or unknown structures cannot masquerade as completed scans', () => {
  for (const payload of [page([{}]), page([{ type: 'TimelineAddEntries' }]), page([{ type: 'TimelineClearCache' }]), { data: { user: { result: { __typename: 'User' } } } }]) assert.throws(() => following(payload), /SCHEMA:/);
  assert.throws(() => following(page([add([]), { type: 'UnknownInstruction' }])), /SCHEMA:/);
});
test('ReplaceEntry replaces only its explicit target and accepts response-only cursor replacements', () => {
  const replace = { type: 'TimelineReplaceEntry', entry_id_to_replace: 'cursor-bottom-1', entry: cursorEntry('replacement-token', 'cursor-bottom-2') };
  assert.equal(following(page([add([userEntry(modernUser()), cursorEntry()]), replace])).nextCursor, 'replacement-token');
  assert.deepEqual(following(page([replace])), { users: [], nextCursor: 'replacement-token', relations: [] });
  assert.throws(() => following(page([{ ...replace, entry_id_to_replace: '' }])), /replacement ID/);
});

test('a User replacement needs an existing target and never becomes a new following entry on its own', () => {
  const replace={type:'TimelineReplaceEntry',entry_id_to_replace:'user-101',entry:userEntry(legacyUser(),'user-102')};
  const result=following(page([add([userEntry(modernUser()),cursorEntry('next')]),replace]));
  assert.deepEqual(result.users.map(user=>user.id),['102']);
  assert.deepEqual(result.relations,[{id:'102',following:true,followedBy:true}]);
  for(const instructions of [[replace,add([cursorEntry('0')])],[add([cursorEntry('0')]),replace]]){
    assert.throws(()=>following(page(instructions)),/SCHEMA:/);
  }
  assert.throws(()=>following(page([{type:'TimelineClearCache'},replace,add([cursorEntry('0')])]),{cursor:'-1'}),/SCHEMA:/);
});
test('duplicate users, duplicate entry IDs and multiple Bottom cursors fail closed', () => {
  for (const entries of [
    [userEntry(modernUser(), 'user-a'), userEntry(modernUser(), 'user-b'), cursorEntry()],
    [userEntry(modernUser()), userEntry(legacyUser()), cursorEntry()],
    [cursorEntry('one', 'bottom-a'), cursorEntry('two', 'bottom-b')],
  ]) assert.throws(() => following(page([add(entries)])), /duplicate|multiple/);
});
test('unknown wrappers and nested recommendation users are not recursively collected', () => {
  const recommendation = { entryId: 'recommendation', content: { entryType: 'TimelineTimelineModule', items: [{ item: { itemContent: { itemType: 'TimelineUser', user_results: { result: modernUser() } } } }] } };
  const hiddenUser = { entryId: 'hidden', content: { entryType: 'UnknownWrapper', user_results: { result: modernUser() } } };
  const promoted = userEntry(modernUser());
  Object.assign(promoted.content.itemContent, { promotedMetadata: {} });
  for (const entry of [recommendation, hiddenUser, promoted]) assert.throws(() => following(page([add([entry, cursorEntry()])])), /SCHEMA:/);
});
test('malformed, repeated and unknown cursor states fail closed', () => {
  for (const cursor of ['', 'contains space', '\u0000bad']) assert.throws(() => following(page([add([cursorEntry(cursor)])])), /cursor value/);
  assert.throws(() => following(page([add([cursorEntry('same-token')])]), { cursor: 'same-token' }), /did not advance/);
  assert.equal(following(page([add([cursorEntry()]), { type: 'TimelineTerminateTimeline', direction: 'Bottom' }])).nextCursor,'0');
  assert.throws(() => following(page([add([cursorEntry('value', 'cursor-side', 'Side')])])), /cursor type/);
  assert.throws(() => following(page([{ type: 'TimelineTerminateTimeline', direction: 'Side' }])), /direction/);
});

test('unknown instruction diagnostics include a bounded type and zero-based index without exporting payloads', () => {
  assert.throws(()=>following(page([add([cursorEntry('0')]),{type:'TimelineWhatever',privateData:'not-for-diagnostics'}])),
    /type=TimelineWhatever; index=1/);
  assert.throws(()=>following(page([{}])),/type=missing; index=0/);
  for(const type of [null,42,{},'Timeline'+ 'A'.repeat(65),'TimelineBad\nprivate-secret', 'private-secret']){
    let message='';
    try{following(page([{type,privateData:'not-for-diagnostics'}]));}catch(error){message=(error as Error).message;}
    assert.match(message,/type=unrecognized; index=0/);
    assert.ok(message.length<256);
    assert.equal(message.includes('private-secret'),false);
    assert.equal(message.includes('not-for-diagnostics'),false);
    assert.equal(/[\r\n]/.test(message),false);
  }
});
test('Following validates a provided root actor and rejects ambiguous timeline containers', () => {
  assert.throws(() => following(page([add([])]), { actorId: '901' }), /expected ID/);
  const payload = page([add([])]);
  Object.assign(payload.data.user.result, { timeline_v2: { timeline: { instructions: [add([])] } } });
  assert.throws(() => following(payload), /ambiguous/);
});
test('serialized production parser runs without module scope or browser dependencies', () => {
  const source = readFileSync(new URL('../src/x-parsers.ts', import.meta.url), 'utf8');
  const compiled = buildSync({ stdin: { contents: source, loader: 'ts' }, format: 'cjs', target: 'chrome120', write: false, keepNames: false });
  const moduleValue = { exports: {} as { parseXPayload?: typeof parseXPayload } };
  new Function('module', 'exports', compiled.outputFiles[0].text)(moduleValue, moduleValue.exports);
  const isolated = runInNewContext(`(${moduleValue.exports.parseXPayload!.toString()})`) as typeof parseXPayload;
  const payload = page([add([userEntry(modernUser()), userEntry(unavailableUser(), 'user-202'), cursorEntry()])]);
  const result = isolated('followingGraphql', payload, { actorId: '900' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), following(payload, { actorId: '900' }));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {isValidCursor} from '../src/cursor';
import {parseXPayload} from '../src/x-parsers';

const response=(value:unknown)=>({data:{user:{result:{__typename:'User',timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[{entryId:'cursor-bottom-1',content:{entryType:'TimelineTimelineCursor',cursorType:'Bottom',value}}]}]}}}}}});
test('opaque cursor contract is identical in the shared validator and serialized Following parser',()=>{
  for(const cursor of ['0','-1','1771337970390780275|2085474368099450818','opaque:next%2Ftoken+=/=?&','x'.repeat(4096)]){
    assert.equal(isValidCursor(cursor),true);
    assert.equal((parseXPayload('followingGraphql',response(cursor)) as {nextCursor:string}).nextCursor,cursor);
  }
  for(const cursor of [undefined,null,0,{},[],'','x'.repeat(4097),'a b','a\nb','\u0000bad','bad\u007f','a\u00a0b']){
    assert.equal(isValidCursor(cursor),false);
    assert.throws(()=>parseXPayload('followingGraphql',response(cursor)),/SCHEMA:/);
  }
});

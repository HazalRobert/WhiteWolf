// Offline comparison against a separately downloaded, pinned public response fixture.
// The fixture is not the user's account, and this script sends no network requests.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const [beforePath,afterPath,fixturePath,reportPath] = process.argv.slice(2);
if(!reportPath)throw new Error('Usage: parser-regression.mjs before.ts after.ts public-following.json report.json');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixtureBytes=await readFile(fixturePath),payload=JSON.parse(fixtureBytes);
const instructions=payload.data.user.result.timeline.timeline.instructions;
const cases=[];
for(const [label,file] of [['before',beforePath],['after',afterPath]]){
  const source=await readFile(file,'utf8');
  const compiled=await build({stdin:{contents:source,loader:'ts'},platform:'node',format:'cjs',write:false});
  const module={exports:{}};
  new Function('module','exports',compiled.outputFiles[0].text)(module,module.exports);
  try{
    const result=module.exports.parseXPayload('followingGraphql',payload,{cursor:'-1'});
    cases.push({label,sourceSha256:hash(source),accepted:true,users:result.users.length,relations:result.relations.length,nextCursor:result.nextCursor,explicitFollowingTrue:result.relations.filter(item=>item.following===true).length});
  }catch(error){cases.push({label,sourceSha256:hash(source),accepted:false,error:error.message});}
}
const report={
  at:new Date().toISOString(),
  scope:'Offline parser replay only. Historical public fixture; capture date unknown. Not a current response from the user. No network requests or relationship writes.',
  source:'https://github.com/vladkens/twscrape/blob/568844df82af956df5970bcf7ff84dd5ba729eb0/tests/mocked-data/raw_following.json',
  fixtureSha256:hash(fixtureBytes),instructions:instructions.map(item=>({type:item.type,...(item.direction?{direction:item.direction}:{}),...(item.entries?{entries:item.entries.length}:{})})),
  cases,
};
report.passed=cases[0].accepted===false&&cases[0].error==='SCHEMA: Unsupported Following timeline instruction.'&&cases[1].accepted===true&&cases[1].users===60&&cases[1].relations===60&&cases[1].nextCursor==='0';
await writeFile(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(!report.passed)process.exitCode=1;

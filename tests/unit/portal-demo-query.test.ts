import {readFile} from 'node:fs/promises';
import {expect,test} from 'vitest';
import {createPortalDemoQuery} from '../../apps/portal/src/demo-query.js';
import type {ContractSnapshot} from '../../packages/ir/src/index.js';
test('demo honours text, tenant and environment filters rather than returning UAT for every query',async()=>{
 const snapshot=JSON.parse(await readFile(new URL('../fixtures/ir/express-snapshot.json',import.meta.url),'utf8')) as ContractSnapshot;
 const principal={tenantId:'demo',principalId:'reader'},query=createPortalDemoQuery(snapshot,principal);
 expect((await query.searchServices(principal,{tenantId:'demo',query:'ord',environment:'uat',limit:20})).services).toHaveLength(1);
 expect((await query.searchServices(principal,{tenantId:'demo',query:'missing',environment:'uat',limit:20})).services).toHaveLength(0);
 expect((await query.searchServices(principal,{tenantId:'demo',query:'',environment:'staging',limit:20})).services).toHaveLength(0);
 expect((await query.searchServices(principal,{tenantId:'other',query:'',limit:20})).services).toHaveLength(0);
 const all=await query.searchServices(principal,{tenantId:'demo',query:'commerce',limit:20});expect(all.services).toHaveLength(1);expect(all.services[0]).not.toHaveProperty('environment');
});

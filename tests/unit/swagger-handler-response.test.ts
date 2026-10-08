import {expect, test} from "vitest";
import {inspectBoundResponseStatus} from "../../analyzers/nodejs/src/handler-candidates.js";
const inspect = (text: string) => inspectBoundResponseStatus("controllers/orders.js", text, "getOrder");

test.each([
  'exports.getOrder = function(req, res) { return res.status(201).json({ok:true}); };',
  'module.exports = {getOrder}; function getOrder(req, res) { return res.sendStatus(201); }',
  'const getOrder = (req, reply) => reply.status(201).send("ok"); module.exports = {getOrder};',
  'module.exports = {getOrder(req, res) { return res.status(201).end(); }};'
])("extracts an exact response status declaration from the bound export: %s", text => {
  expect(inspect(text)).toMatchObject({kind: "declared", code: 201, line: 1, span: expect.stringMatching(/^span:/)});
});

test.each([
  'exports.getOrder = function(req, res) { if (req.ok) return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.sendStatus(req.status); };',
  'exports.getOrder = function(req, res) { res = fake; return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return other.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.status(201).json(res.status(500)); };',
  'exports.getOrder = function(req, res) { return res.status(201).json({...req.body}); };',
  'exports.getOrder = function(req, res) { return res.status(201); };',
  'exports.getOrder = function(req, res) { return res.sendStatus(700); };',
  'exports.getOrder = function(req, res) { return res.status(201).json({[req.key]:true}); };',
  'exports.getOrder = function(req, res = other) { return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.sendStatus(201); }; exports.getOrder = other;',
  'exports.other = function(req, res) { return res.sendStatus(201); };',
  'exports.getOrder = function(req, res) { return res.status(201).json(req.body); };'
])("keeps unsupported response flows unresolved: %s", text => {
  expect(inspect(text)).toEqual({kind: "unresolved"});
});


test("JSON literal bodies yield types without leaking values or inventing field constraints", () => {
  const result = inspect('exports.getOrder = function(req, res) { return res.status(201).json({name:"private-value-marker", count:1, fraction:1.5, active:true, detail:{value:null}, list:[1,2], empty:[]}); };');
  expect(result).toMatchObject({kind: "declared", body: {schema: {type:"object", properties: {
    name:{type:"string"}, count:{type:"integer"}, fraction:{type:"number"}, active:{type:"boolean"},
    detail:{type:"object", properties:{value:{type:"null"}}}, list:{type:"array",items:{type:"integer"}}, empty:{type:"array"}
  }}}});
  expect(JSON.stringify(result)).not.toContain("private-value-marker");
  expect(JSON.stringify(result)).not.toContain('"required"');
  expect(JSON.stringify(result)).not.toContain('"const"');
});

test("send and sendStatus do not invent a JSON body schema", () => {
  for (const expression of ['res.status(201).send({ok:true})', 'res.sendStatus(201)']) {
    const result = inspect(`exports.getOrder = function(req, res) { return ${expression}; };`);
    expect(result).toMatchObject({kind:"declared", code:201});
    expect(result).not.toHaveProperty("body");
  }
});

test.each(['{key:1,key:2}', '{__proto__:null}', '[,1]', '{value:Infinity}', '{value:1e400}', '{get value(){return 1;}}'])
("unsupported JSON literal bodies remain unresolved: %s", body => {
  expect(inspect(`exports.getOrder = function(req,res) { return res.status(201).json(${body}); };`)).toEqual({kind:"unresolved"});
});

test.each([
  'const body = {id:1}; return res.status(201).json(body);',
  'res.status(201); return res.json({id:1});',
  'const body = {id:1}; res.status(201); return res.json(body);',
  'res.status(201); const body = {id:1}; return res.json(body);'
])("extracts bounded linear status and local literal bodies: %s",statements=>{
  expect(inspect(`exports.getOrder = function(req,res) { ${statements} };`)).toMatchObject({kind:"declared",code:201,body:{schema:{type:"object",properties:{id:{type:"integer"}}}}});
});
test("local literal body evidence points to its initializer and omits values",()=>{
  const text='exports.getOrder = function(req,res) {\n const body = {id:"private-body-value"};\n return res.status(201).json(body);\n};';
  const result=inspect(text);
  expect(result).toMatchObject({kind:"declared",body:{line:2,span:`span:${text.indexOf('{id:')}:${text.indexOf('};\n return')+1}`}});
  expect(JSON.stringify(result)).not.toContain("private-body-value");
});
test.each([
  'let body = {id:1}; return res.status(201).json(body);',
  'const body = req.body; return res.status(201).json(body);',
  'const body = {id:1}; body.id = "changed"; return res.status(201).json(body);',
  'const body = {id:1}; mutate(body); return res.status(201).json(body);',
  'const body = {id:1}; const alias = body; return res.status(201).json(alias);',
  'const res = {id:1}; return res.status(201).json(res);',
  'const body = {id:1}; return res.status(201).json(other);',
  'res.status(201); res.status(202); return res.json({id:1});',
  'res.status(201); return res.status(202).json({id:1});',
  'other.status(201); return res.json({id:1});',
  'res.status(req.code); return res.json({id:1});',
  'const unused = sideEffect(); return res.status(201).json({id:1});',
  'const body = {id:1}, other = {id:2}; return res.status(201).json(body);',
  'if (req.ok) res.status(201); return res.json({id:1});'
])("unsupported linear flows remain unresolved: %s",statements=>{
  expect(inspect(`exports.getOrder = function(req,res) { ${statements} };`)).toEqual({kind:"unresolved"});
});
test("local declaration count is bounded",()=>{
  expect(inspect(`exports.getOrder = function(req,res) { ${Array.from({length:17},(_,i)=>`const v${i} = ${i};`).join(' ')} return res.status(201).json({id:1}); };`)).toEqual({kind:"unresolved"});
});

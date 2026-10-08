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

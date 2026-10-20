import { XMLParser } from 'fast-xml-parser';
import { HttpError } from '../db.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true, // standard XML entities only; external entities are never resolved
  isArray: (name) => ['testsuite', 'testcase', 'property'].includes(name),
});

const text = (node) => {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).filter(Boolean).join('\n');
  return node['#text'] ? String(node['#text']) : '';
};

function collectSuites(node, out) {
  for (const s of node.testsuite || []) {
    out.push(s);
    collectSuites(s, out); // nested suites (JUnit 5, Surefire)
  }
}

/**
 * Parses JUnit-style XML (Maven Surefire, Gradle, pytest --junitxml, Playwright, Cypress, Jest-junit, NUnit via
 * converters, TestNG junit reports) into [{ classname, name, status, duration_ms, message, output, suite }].
 */
export function parseJUnit(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new HttpError(400, `Not valid XML: ${e.message}`);
  }
  const roots = doc.testsuites ? [doc.testsuites] : [];
  const suites = [];
  if (doc.testsuites) collectSuites(doc.testsuites, suites);
  else if (doc.testsuite) for (const s of doc.testsuite) { suites.push(s); collectSuites(s, suites); }
  if (!suites.length && !roots.length) throw new HttpError(400, 'No <testsuite> found. Upload a JUnit XML report.');

  const results = [];
  const seen = new Set();
  for (const suite of suites) {
    for (const tc of suite.testcase || []) {
      if (seen.has(tc)) continue;
      seen.add(tc);
      const classname = tc['@_classname'] || suite['@_name'] || '';
      const name = tc['@_name'] || '';
      if (!name) continue;
      let status = 'Passed';
      let message = '';
      if (tc.failure !== undefined) {
        status = 'Failed';
        message = failureText(tc.failure);
      } else if (tc.error !== undefined) {
        status = 'Failed';
        message = `ERROR: ${failureText(tc.error)}`;
      } else if (tc.skipped !== undefined) {
        status = 'Skipped';
        message = failureText(tc.skipped);
      }
      const time = Number.parseFloat(tc['@_time']);
      results.push({
        classname,
        name,
        status,
        duration_ms: Number.isFinite(time) ? Math.round(time * 1000) : null,
        message: message.slice(0, 4000),
        output: [text(tc['system-out']), text(tc['system-err'])].filter(Boolean).join('\n').slice(0, 20000),
        properties: Object.fromEntries((tc.properties?.property || []).map((p) => [p['@_name'], p['@_value'] ?? text(p)])),
      });
    }
  }
  if (!results.length) throw new HttpError(400, 'The JUnit report contains no test cases.');
  return results;
}

function failureText(node) {
  const n = Array.isArray(node) ? node[0] : node;
  if (n === undefined || n === null) return '';
  if (typeof n === 'string') return n;
  const head = n['@_message'] || n['@_type'] || '';
  const body = text(n);
  return [head, body && body !== head ? body : ''].filter(Boolean).join('\n');
}

/** "com.bank.LoginTest" + "valid" -> "com.bank.LoginTest#valid" (matches how most teams name a test). */
export const refFor = (classname, name) => (classname ? `${classname}#${name}` : name);

/** "com.bank.LoginTest" -> "com / bank / LoginTest", used as the suite path for auto-created cases. */
export const suitePathFor = (classname) => String(classname || '').split(/[./\\:]+/).filter(Boolean).join(' / ');

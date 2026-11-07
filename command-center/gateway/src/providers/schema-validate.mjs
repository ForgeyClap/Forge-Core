// Minimal JSON Schema (draft-07 subset) validator for registry.schema.json. Zero dependencies.
//
// Supported keywords: type (string or array), enum, const, required, properties,
// additionalProperties (boolean or schema), items, pattern, minLength, maxLength, minimum, maximum,
// minItems and local $ref ("#/definitions/<name>"). An unknown keyword is an error, so the schema
// cannot silently ask for a check this validator does not perform.
//
// validate(schema, value) -> string[] of human-readable problems (empty = valid). Never throws on bad
// data; throws only on a schema that uses an unsupported keyword (a programming error).

const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', 'definitions', '$ref', 'type', 'enum', 'const', 'required',
  'properties', 'additionalProperties', 'items', 'pattern', 'minLength', 'maxLength', 'minimum',
  'maximum', 'minItems',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // string | number | boolean | object | undefined
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

function resolveRef(root, ref) {
  const m = /^#\/definitions\/([A-Za-z0-9_-]+)$/.exec(ref);
  if (!m || !root.definitions || !root.definitions[m[1]]) throw new Error('schema-validate: unresolvable $ref ' + ref);
  return root.definitions[m[1]];
}

function show(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 'undefined' : (text.length > 60 ? text.slice(0, 57) + '...' : text);
}

function check(root, schema, value, at, out) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error('schema-validate: unsupported keyword "' + key + '" at ' + at);
  }
  if (schema.$ref) return check(root, resolveRef(root, schema.$ref), value, at, out);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      out.push(at + ': expected ' + types.join('|') + ', got ' + typeOf(value));
      return; // further keywords would only add noise
    }
  }
  if (schema.const !== undefined && value !== schema.const) out.push(at + ': must equal ' + show(schema.const));
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    out.push(at + ': ' + show(value) + ' is not one of ' + schema.enum.map(show).join(', '));
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(at + ': shorter than ' + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(at + ': longer than ' + schema.maxLength);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      out.push(at + ': ' + show(value) + ' does not match ' + schema.pattern);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(at + ': below minimum ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(at + ': above maximum ' + schema.maximum);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(at + ': fewer than ' + schema.minItems + ' items');
    if (schema.items) value.forEach((item, i) => check(root, schema.items, item, at + '[' + i + ']', out));
  }
  if (typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) out.push(at + ': missing required field "' + req + '"');
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        check(root, props[k], v, at + '.' + k, out);
      } else if (schema.additionalProperties === false) {
        out.push(at + ': unknown field "' + k + '"');
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(root, schema.additionalProperties, v, at + '.' + k, out);
      }
    }
  }
}

export function validate(schema, value, at = '$') {
  const out = [];
  check(schema, schema, value, at, out);
  return out;
}

// Validates one value against a named definition of the same schema document.
export function validateDefinition(schema, name, value, at = '$') {
  const out = [];
  check(schema, resolveRef(schema, '#/definitions/' + name), value, at, out);
  return out;
}

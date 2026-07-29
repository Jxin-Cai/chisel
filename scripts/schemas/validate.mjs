import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function validateType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}

function validateSchema(data, schema, path = '') {
  const errors = [];

  if (schema.type && !validateType(data, schema.type)) {
    errors.push(`${path || '/'}: expected type "${schema.type}", got "${Array.isArray(data) ? 'array' : typeof data}"`);
    return errors;
  }

  if (schema.required && schema.type === 'object') {
    for (const key of schema.required) {
      if (!(key in data)) errors.push(`${path}/${key}: required property missing`);
    }
  }

  if (schema.properties && typeof data === 'object' && data !== null) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in data) {
        errors.push(...validateSchema(data[key], propSchema, `${path}/${key}`));
      }
    }
  }

  if (schema.items && Array.isArray(data)) {
    for (let i = 0; i < Math.min(data.length, 50); i++) {
      errors.push(...validateSchema(data[i], schema.items, `${path}[${i}]`));
    }
  }

  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: value "${data}" not in enum [${schema.enum.join(', ')}]`);
  }

  if (schema.minimum !== undefined && typeof data === 'number' && data < schema.minimum) {
    errors.push(`${path}: value ${data} below minimum ${schema.minimum}`);
  }

  return errors;
}

export function validateJsonFile(filePath, schemaName) {
  if (!existsSync(filePath)) return { valid: false, errors: [`file not found: ${filePath}`] };

  const schemaPath = join(__dirname, `${schemaName}.schema.json`);
  if (!existsSync(schemaPath)) return { valid: true, errors: [], note: 'schema not found, skipped' };

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const errors = validateSchema(data, schema);
    return { valid: errors.length === 0, errors };
  } catch (e) {
    return { valid: false, errors: [`parse error: ${e.message}`] };
  }
}

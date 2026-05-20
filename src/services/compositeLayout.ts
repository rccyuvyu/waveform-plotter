import { DataType } from '../core/types';

export interface CompositeLeafInfo {
  path: string;
  typeText: string;
  byteSize: number;
}

export interface CompositeFieldInfo {
  path: string;
  typeText: string;
  byteSize: number;
  arrayDims: number[];
}

interface LogicalStatement {
  text: string;
  byteSize: number;
  endLine: number;
}

export function parseCompositeLeafInfos(ptypeOutput: string): CompositeLeafInfo[] {
  const lines = ptypeOutput.split(/\r?\n/);
  const headerIndex = findCompositeHeaderIndex(lines);
  if (headerIndex < 0) {
    return [];
  }

  const parsed = parseCompositeBlock(lines, headerIndex + 1);
  const seen = new Set<string>();
  const unique: CompositeLeafInfo[] = [];
  for (const leaf of parsed.leafInfos) {
    if (!leaf.path || seen.has(leaf.path)) {
      continue;
    }
    seen.add(leaf.path);
    unique.push(leaf);
  }
  return unique;
}

export function parseCompositeFieldInfos(ptypeOutput: string): CompositeFieldInfo[] {
  const lines = ptypeOutput.split(/\r?\n/);
  const headerIndex = findCompositeHeaderIndex(lines);
  if (headerIndex < 0) {
    return [];
  }

  const parsed = parseCompositeFieldsBlock(lines, headerIndex + 1);
  const seen = new Set<string>();
  const unique: CompositeFieldInfo[] = [];
  for (const field of parsed.fields) {
    if (!field.path || seen.has(field.path)) {
      continue;
    }
    seen.add(field.path);
    unique.push(field);
  }
  return unique;
}

export function inferDataTypeFromTypeText(typeText: string, byteSize: number): DataType | undefined {
  const lower = typeText.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(struct|class|union)\b/.test(lower)) {
    return undefined;
  }

  const isFloat = /\bfloat\b/.test(lower);
  const isDouble = /\bdouble\b/.test(lower);
  const isUnsigned = /\bunsigned\b|\buint\d*_t\b|\bbool\b/.test(lower);
  const isExplicitSigned = /\bsigned\b|\bint\d*_t\b/.test(lower);
  const isCharLike = /\bchar\b|\bint8_t\b|\buint8_t\b/.test(lower);

  if (isDouble) {
    return 'DOUBLE';
  }
  if (isFloat) {
    return 'FLOAT';
  }
  if (byteSize === 1) {
    if (isCharLike && !isUnsigned && !isExplicitSigned) {
      return 'INT8';
    }
    return isUnsigned ? 'UINT8' : 'INT8';
  }
  if (byteSize === 2) {
    return isUnsigned ? 'UINT16' : 'INT16';
  }
  if (byteSize === 4) {
    return isUnsigned ? 'UINT32' : 'INT32';
  }
  if (byteSize === 8) {
    if (isDouble) {
      return 'DOUBLE';
    }
    return isUnsigned ? 'UINT64' : 'INT64';
  }
  return undefined;
}

function findCompositeHeaderIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = stripPtypeLayoutComment(lines[i]).replace(/^type\s*=\s*/i, '').trim();
    if (!stripped) {
      continue;
    }
    if (/^(struct|class|union)\b/i.test(stripped) || stripped === '{') {
      return i;
    }
  }
  return -1;
}

function parseCompositeBlock(
  lines: string[],
  startLine: number
): { leafInfos: CompositeLeafInfo[]; endLine: number; fieldName?: string; arrayDims: number[] } {
  const leafInfos: CompositeLeafInfo[] = [];
  let i = startLine;

  while (i < lines.length) {
    const statement = readLogicalStatement(lines, i);
    if (!statement) {
      break;
    }

    const text = statement.text;
    if (isCompositeStartText(text)) {
      const nested = parseCompositeBlock(lines, statement.endLine + 1);
      if (nested.fieldName && !isBaseClassSubobject(text, nested.fieldName)) {
        const prefixes = expandArrayPrefixes(nested.fieldName, nested.arrayDims);
        for (const prefix of prefixes) {
          for (const childLeaf of nested.leafInfos) {
            leafInfos.push({
              path: joinCompositePath(prefix, childLeaf.path),
              typeText: childLeaf.typeText,
              byteSize: childLeaf.byteSize
            });
          }
        }
      } else {
        leafInfos.push(...nested.leafInfos);
      }
      i = nested.endLine + 1;
      continue;
    }

    const closing = parseCompositeClosing(text);
    if (closing) {
      return {
        leafInfos,
        endLine: statement.endLine,
        fieldName: closing.fieldName,
        arrayDims: closing.arrayDims
      };
    }

    leafInfos.push(...parseLeafInfos(text, statement.byteSize));
    i = statement.endLine + 1;
  }

  return { leafInfos, endLine: i, arrayDims: [] };
}

function parseCompositeFieldsBlock(
  lines: string[],
  startLine: number
): { fields: CompositeFieldInfo[]; endLine: number; fieldName?: string; arrayDims: number[] } {
  const fields: CompositeFieldInfo[] = [];
  let i = startLine;

  while (i < lines.length) {
    const statement = readLogicalStatement(lines, i);
    if (!statement) {
      break;
    }

    const text = statement.text;
    if (isCompositeStartText(text)) {
      const nested = parseCompositeFieldsBlock(lines, statement.endLine + 1);
      if (nested.fieldName && !isBaseClassSubobject(text, nested.fieldName)) {
        const nestedField = parseInlineCompositeField(text, statement.byteSize, nested.fieldName, nested.arrayDims);
        if (nestedField) {
          fields.push(nestedField);
        }
      } else {
        fields.push(...nested.fields);
      }
      i = nested.endLine + 1;
      continue;
    }

    const closing = parseCompositeClosing(text);
    if (closing) {
      return {
        fields,
        endLine: statement.endLine,
        fieldName: closing.fieldName,
        arrayDims: closing.arrayDims
      };
    }

    fields.push(...parseDirectFields(text, statement.byteSize));
    i = statement.endLine + 1;
  }

  return { fields, endLine: i, arrayDims: [] };
}

function readLogicalStatement(lines: string[], startLine: number): LogicalStatement | undefined {
  const parts: string[] = [];
  let byteSize = Number.NaN;

  for (let i = startLine; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const stripped = stripPtypeLayoutComment(rawLine).trim();
    if (!stripped || isIgnorablePtypeLine(stripped)) {
      continue;
    }

    if (!Number.isFinite(byteSize)) {
      byteSize = extractLayoutByteSize(rawLine);
    }

    parts.push(stripped);
    const text = normalizeStatementText(parts);
    if (isCompositeStartText(text)) {
      return { text, byteSize, endLine: i };
    }
    if (text.endsWith(';')) {
      return { text, byteSize, endLine: i };
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return {
    text: normalizeStatementText(parts),
    byteSize,
    endLine: lines.length - 1
  };
}

function isIgnorablePtypeLine(stripped: string): boolean {
  return /^(public|private|protected)\s*:\s*$/i.test(stripped) || /total size \(bytes\)/i.test(stripped);
}

function normalizeStatementText(parts: string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function isCompositeStartText(text: string): boolean {
  return /^(struct|class|union)\b[\s\S]*\{\s*$/i.test(text) || text === '{';
}

function parseCompositeClosing(text: string): { fieldName?: string; arrayDims: number[] } | undefined {
  const match = text.match(/^\}\s*([a-zA-Z_]\w*)?\s*((?:\[[^\]]+\]\s*)*)\s*;?\s*$/);
  if (!match) {
    return undefined;
  }
  return {
    fieldName: match[1],
    arrayDims: parseArrayDims(match[2]?.trim() ?? '')
  };
}

function parseLeafInfos(text: string, statementByteSize: number): CompositeLeafInfo[] {
  if (!text.endsWith(';')) {
    return [];
  }
  if (
    /^(public|private|protected)\s*:\s*$/i.test(text)
    || /^static\b/i.test(text)
    || /^typedef\b/i.test(text)
    || text.startsWith('}')
    || text.includes('{')
    || text.includes('(')
  ) {
    return [];
  }

  const decl = text.replace(/;\s*$/, '');
  const fieldMatch = decl.match(/^(.+?)\s+([a-zA-Z_]\w*)((?:\s*\[[^\]]+\]\s*)*)\s*(?::\s*\d+)?\s*$/);
  if (!fieldMatch) {
    return [];
  }

  const typeText = normalizeTypeText(fieldMatch[1]);
  const fieldName = fieldMatch[2];
  const dims = parseArrayDims(fieldMatch[3]?.trim() ?? '');
  const prefixes = expandArrayPrefixes(fieldName, dims);
  const elementSize = dims.length > 0 && Number.isFinite(statementByteSize) && statementByteSize > 0
    ? Math.max(1, Math.floor(statementByteSize / prefixes.length))
    : (Number.isFinite(statementByteSize) && statementByteSize > 0 ? statementByteSize : guessByteSize(typeText));

  return prefixes.map((path) => ({
    path,
    typeText,
    byteSize: elementSize
  }));
}

function parseDirectFields(text: string, statementByteSize: number): CompositeFieldInfo[] {
  if (!text.endsWith(';')) {
    return [];
  }
  if (
    /^(public|private|protected)\s*:\s*$/i.test(text)
    || /^static\b/i.test(text)
    || /^typedef\b/i.test(text)
    || text.startsWith('}')
    || text.includes('{')
    || text.includes('(')
  ) {
    return [];
  }

  const decl = text.replace(/;\s*$/, '');
  const fieldMatch = decl.match(/^(.+?)\s+([a-zA-Z_]\w*)((?:\s*\[[^\]]+\]\s*)*)\s*(?::\s*\d+)?\s*$/);
  if (!fieldMatch) {
    return [];
  }

  const typeText = normalizeTypeText(fieldMatch[1]);
  const fieldName = fieldMatch[2];
  const arrayDims = parseArrayDims(fieldMatch[3]?.trim() ?? '');
  const byteSize = Number.isFinite(statementByteSize) && statementByteSize > 0
    ? statementByteSize
    : guessByteSize(typeText) * Math.max(1, arrayDims.reduce((acc, dim) => acc * dim, 1));

  return [{
    path: fieldName,
    typeText,
    byteSize,
    arrayDims
  }];
}

function parseInlineCompositeField(
  startText: string,
  statementByteSize: number,
  fieldName: string,
  arrayDims: number[]
): CompositeFieldInfo | undefined {
  const match = startText.match(/^(struct|class|union)(?:\s+(.+?))?(?:\s*:\s*.+?)?\s*\{\s*$/i);
  if (!match) {
    return undefined;
  }

  const kind = match[1];
  const rawTypeName = (match[2] ?? '').trim();
  const typeText = normalizeTypeText(rawTypeName ? `${kind} ${rawTypeName}` : kind);

  return {
    path: fieldName,
    typeText,
    byteSize: Number.isFinite(statementByteSize) && statementByteSize > 0 ? statementByteSize : guessByteSize(typeText),
    arrayDims
  };
}

function normalizeTypeText(typeText: string): string {
  return typeText
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*(?:public|private|protected)\s+.*$/, '')
    .trim();
}

function parseArrayDims(arraySuffix: string): number[] {
  if (!arraySuffix) {
    return [];
  }
  return [...arraySuffix.matchAll(/\[([^\]]+)\]/g)]
    .map((match) => match[1].trim())
    .map((value) => (/^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function expandArrayPrefixes(fieldName: string, dims: number[]): string[] {
  if (dims.length === 0) {
    return [fieldName];
  }

  const MAX_EXPANDED_ARRAY_ELEMENTS = 128;
  let suffixes = [''];
  for (const dim of dims) {
    if (suffixes.length * dim > MAX_EXPANDED_ARRAY_ELEMENTS) {
      return [fieldName];
    }
    const next: string[] = [];
    for (const suffix of suffixes) {
      for (let index = 0; index < dim; index += 1) {
        next.push(`${suffix}[${index}]`);
      }
    }
    suffixes = next;
  }
  return suffixes.map((suffix) => `${fieldName}${suffix}`);
}

function extractLayoutByteSize(line: string): number {
  const sizeMatch = line.match(/\/\*\s*\d+\s*\|\s*(\d+)\s*\*\//);
  return sizeMatch ? Number.parseInt(sizeMatch[1], 10) : Number.NaN;
}

function stripPtypeLayoutComment(line: string): string {
  return line.replace(/^\s*\/\*.*?\*\/\s*/, '').trimStart();
}

function joinCompositePath(basePath: string, childPath: string): string {
  if (!childPath) {
    return basePath;
  }
  return childPath.startsWith('[') ? `${basePath}${childPath}` : `${basePath}.${childPath}`;
}

function guessByteSize(typeText: string): number {
  const lower = typeText.toLowerCase();
  if (/\bdouble\b/.test(lower)) {
    return 8;
  }
  if (/\bfloat\b/.test(lower)) {
    return 4;
  }
  if (/\b(?:u?int8_t|char|bool)\b/.test(lower)) {
    return 1;
  }
  if (/\b(?:u?int16_t|short)\b/.test(lower)) {
    return 2;
  }
  if (/\*/.test(lower)) {
    return 4;
  }
  return 4;
}

/**
 * 检测 ptype /o 输出中的嵌套闭合是否为继承基类子对象。
 * 基类子对象中，} 后的名称是类型名（如 Class_Matrix_f32）而非字段名。
 */
function isBaseClassSubobject(startText: string, closingFieldName: string): boolean {
  const inlineTypeName = extractInlineTypeName(startText);
  if (!inlineTypeName) {
    return false;
  }
  // 去除模板参数后比较，如 "Class_Matrix_f32<4, 1>" → "Class_Matrix_f32" → 匹配 closingFieldName
  const stripped = inlineTypeName.replace(/<[^>]*>/g, '').trim();
  return stripped === closingFieldName;
}

function extractInlineTypeName(startText: string): string | undefined {
  const match = startText.match(/^(struct|class|union)\s+(.+?)\s*\{\s*$/i);
  return match?.[2]?.trim();
}

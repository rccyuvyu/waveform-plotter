"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePtypeWatchTree = parsePtypeWatchTree;
exports.flattenParsedWatchLeaves = flattenParsedWatchLeaves;
exports.flattenParsedWatchNodes = flattenParsedWatchNodes;
function parsePtypeWatchTree(ptypeOutput, rootExpression) {
    const lines = ptypeOutput.split(/\r?\n/);
    const headerLine = lines.find((line) => /type\s*=\s*(class|struct|union)\b/.test(line));
    if (!headerLine) {
        return undefined;
    }
    const typeMatch = headerLine.match(/type\s*=\s*(class|struct|union)\s+(.+?)\s*\{/);
    const rootTypeName = normalizeTypeText(typeMatch?.[2] ?? rootExpression);
    const totalSizeMatches = [...ptypeOutput.matchAll(/total size \(bytes\):\s+(\d+)/g)];
    const totalSize = totalSizeMatches.length > 0
        ? Number.parseInt(totalSizeMatches[totalSizeMatches.length - 1][1], 10)
        : 0;
    const rootNode = {
        name: rootExpression,
        relativePath: '',
        expression: rootExpression,
        declaredTypeText: rootTypeName,
        byteSize: totalSize,
        children: []
    };
    parseFields(lines, 1, rootNode, rootExpression, '', 0, rootTypeName);
    return rootNode;
}
function flattenParsedWatchLeaves(rootName, root) {
    const leaves = [];
    const walk = (node, currentPath) => {
        if (node !== root && node.children.length === 0 && currentPath) {
            leaves.push({
                fullName: joinCompositePath(rootName, currentPath),
                expression: node.expression,
                declaredTypeText: node.declaredTypeText,
                byteSize: node.byteSize,
                address: node.address
            });
            return;
        }
        for (const child of node.children) {
            const childPath = currentPath
                ? joinCompositePath(currentPath, child.name)
                : child.name;
            walk(child, childPath);
        }
    };
    walk(root, '');
    return leaves;
}
function flattenParsedWatchNodes(rootName, root) {
    const nodes = [];
    const walk = (node, currentPath) => {
        nodes.push({
            ...node,
            relativePath: currentPath
        });
        for (const child of node.children) {
            const childPath = currentPath
                ? joinCompositePath(currentPath, child.name)
                : child.name;
            walk(child, childPath);
        }
    };
    walk(root, '');
    return nodes.map((node) => ({
        ...node,
        relativePath: node === root || !node.relativePath ? '' : joinCompositePath(rootName, node.relativePath)
    }));
}
function parseFields(lines, startLine, parent, parentExpr, parentPath, parentOffset, scopeTypeName) {
    let i = startLine;
    while (i < lines.length) {
        const line = lines[i];
        if (/^\s*(private|public|protected)\s*:\s*$/.test(line)) {
            i += 1;
            continue;
        }
        if (line.trim() === '' || line.trim() === '}' || line.trim() === '};') {
            i += 1;
            continue;
        }
        if (/total size \(bytes\)/.test(line)) {
            i += 1;
            continue;
        }
        const staticMatch = line.match(/^\s*static\s+(.+?)\s+(\w+)(\[(\d+)\])?\s*;/);
        if (staticMatch) {
            const staticType = normalizeTypeText(staticMatch[1]);
            const fieldName = staticMatch[2];
            const arraySize = staticMatch[4] ? Number.parseInt(staticMatch[4], 10) : 0;
            const relativePath = joinCompositePath(parentPath, fieldName);
            const staticExpr = `${scopeTypeName}::${fieldName}`;
            if (arraySize > 0) {
                const arrNode = createNode(fieldName, relativePath, staticExpr, `${staticType}[${arraySize}]`, 0);
                for (let ai = 0; ai < arraySize; ai += 1) {
                    const elementPath = `${relativePath}[${ai}]`;
                    arrNode.children.push(createNode(`[${ai}]`, elementPath, `${staticExpr}[${ai}]`, staticType, 0));
                }
                parent.children.push(arrNode);
            }
            else {
                parent.children.push(createNode(fieldName, relativePath, staticExpr, staticType, 0));
            }
            i += 1;
            continue;
        }
        const nestedMatch = line.match(/\/\*\s+(\d+)\s+\|\s+(\d+)\s+\*\/\s+(struct|class|union)(?:\s+(.+?))?\s*\{/);
        if (nestedMatch) {
            const absOffset = Number.parseInt(nestedMatch[1], 10);
            const size = Number.parseInt(nestedMatch[2], 10);
            const nestedTypeName = normalizeTypeText(nestedMatch[4] || nestedMatch[3]);
            i += 1;
            const result = findNestedEnd(lines, i);
            const fieldName = result.name;
            const arraySize = result.arraySize;
            const endIdx = result.endLine;
            // 检测是否为继承基类子对象：结束 } 后的名称是类型名而非字段名
            // ptype /o 输出中基类显示为匿名嵌套结构体，} 后跟的是基类类型名
            const isBaseClassSubobject = fieldName && nestedTypeName && (fieldName === nestedTypeName
                || nestedTypeName.replace(/<[^>]*>/g, '').trim() === fieldName
                || `${nestedTypeName}>`.replace(/<[^>]*>/g, '').startsWith(fieldName));
            if (isBaseClassSubobject) {
                // 基类子对象：不创建中间节点，直接将子成员合并到父节点中
                void parseFields(lines, i, parent, parentExpr, parentPath, absOffset, nestedTypeName);
            }
            else if (arraySize > 0) {
                const elemSize = arraySize > 0 ? Math.floor(size / arraySize) : size;
                const fieldExpr = composeMemberExpr(parentExpr, fieldName);
                const fieldPath = joinCompositePath(parentPath, fieldName);
                const arrNode = createNode(fieldName, fieldPath, fieldExpr, `${nestedTypeName}[${arraySize}]`, size);
                for (let ai = 0; ai < arraySize; ai += 1) {
                    const elemExpr = composeIndexExpr(fieldExpr, ai);
                    const elemPath = `${fieldPath}[${ai}]`;
                    const elemNode = createNode(`[${ai}]`, elemPath, elemExpr, nestedTypeName, elemSize);
                    parseFields(lines, i, elemNode, elemExpr, elemPath, absOffset, nestedTypeName);
                    arrNode.children.push(elemNode);
                }
                parent.children.push(arrNode);
            }
            else {
                const fieldExpr = composeMemberExpr(parentExpr, fieldName);
                const fieldPath = joinCompositePath(parentPath, fieldName);
                const nestedNode = createNode(fieldName, fieldPath, fieldExpr, nestedTypeName, size);
                parseFields(lines, i, nestedNode, fieldExpr, fieldPath, absOffset, nestedTypeName);
                parent.children.push(nestedNode);
            }
            i = endIdx + 1;
            continue;
        }
        const fieldMatch = line.match(/\/\*\s+(\d+)\s+\|\s+(\d+)\s+\*\/\s+(.+?)\s*([*&]+)?\s*(\w+)(\[(\d+)\])?\s*;/);
        if (fieldMatch) {
            const absOffset = Number.parseInt(fieldMatch[1], 10);
            const relOffset = Math.max(0, absOffset - parentOffset);
            const size = Number.parseInt(fieldMatch[2], 10);
            let typeName = fieldMatch[3].trim();
            const ptrOrRef = fieldMatch[4] ? fieldMatch[4].trim() : '';
            const fieldName = fieldMatch[5];
            const arraySize = fieldMatch[7] ? Number.parseInt(fieldMatch[7], 10) : 0;
            if (ptrOrRef) {
                typeName = `${typeName} ${ptrOrRef}`.trim();
            }
            const fieldExpr = composeMemberExpr(parentExpr, fieldName);
            const fieldPath = joinCompositePath(parentPath, fieldName);
            const normalizedType = normalizeTypeText(typeName);
            if (arraySize > 0) {
                const elemSize = arraySize > 0 ? Math.floor(size / arraySize) : size;
                const arrNode = createNode(fieldName, fieldPath, fieldExpr, `${normalizedType}[${arraySize}]`, size);
                for (let ai = 0; ai < arraySize; ai += 1) {
                    const elemExpr = composeIndexExpr(fieldExpr, ai);
                    const elemPath = `${fieldPath}[${ai}]`;
                    arrNode.children.push(createNode(`[${ai}]`, elemPath, elemExpr, normalizedType, elemSize));
                }
                parent.children.push(arrNode);
            }
            else {
                parent.children.push(createNode(fieldName, fieldPath, fieldExpr, normalizedType, size));
            }
            void relOffset;
            i += 1;
            continue;
        }
        const closingMatch = line.match(/\}\s+(\w+)(\[(\d+)\])?\s*;/);
        if (closingMatch) {
            return i;
        }
        i += 1;
    }
    return i;
}
function findNestedEnd(lines, startIdx) {
    let depth = 1;
    let i = startIdx;
    while (i < lines.length) {
        const line = lines[i];
        if (/\{[\s]*$/.test(line)) {
            depth += 1;
        }
        const closeMatch = line.match(/\}\s+(\w+)(\[(\d+)\])?\s*;/);
        if (closeMatch) {
            depth -= 1;
            if (depth === 0) {
                return {
                    name: closeMatch[1],
                    arraySize: closeMatch[3] ? Number.parseInt(closeMatch[3], 10) : 0,
                    endLine: i
                };
            }
        }
        if (line.trim() === '}' || line.trim() === '};') {
            depth -= 1;
            if (depth <= 0) {
                return { name: '', arraySize: 0, endLine: i };
            }
        }
        i += 1;
    }
    return { name: '', arraySize: 0, endLine: i };
}
function createNode(name, relativePath, expression, declaredTypeText, byteSize, address) {
    return {
        name,
        relativePath,
        expression,
        declaredTypeText,
        byteSize,
        address,
        children: []
    };
}
function composeMemberExpr(parentExpr, fieldName) {
    return `(${parentExpr}).${fieldName}`;
}
function composeIndexExpr(parentExpr, index) {
    return `(${parentExpr})[${index}]`;
}
function joinCompositePath(basePath, childPath) {
    if (!basePath) {
        return childPath;
    }
    if (!childPath) {
        return basePath;
    }
    return childPath.startsWith('[') ? `${basePath}${childPath}` : `${basePath}.${childPath}`;
}
function normalizeTypeText(typeText) {
    return typeText.replace(/\s+/g, ' ').trim();
}
//# sourceMappingURL=watchTreeParser.js.map
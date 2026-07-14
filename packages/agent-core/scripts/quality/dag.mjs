export function validateGraph(graph) {
    if (
        graph.edition !== "1.0.0" ||
        graph.nodes === null ||
        typeof graph.nodes !== "object" ||
        graph.stages === null ||
        typeof graph.stages !== "object"
    ) {
        throw new TypeError("Quality DAG is malformed");
    }
    for (const [node, dependencies] of Object.entries(graph.nodes)) {
        if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length) {
            throw new TypeError(`Quality node ${node} has invalid dependencies`);
        }
        for (const dependency of dependencies) {
            if (!Object.hasOwn(graph.nodes, dependency))
                throw new TypeError(`Quality node ${node} has unknown dependency ${dependency}`);
            if (dependency === node) throw new TypeError(`Quality node ${node} depends on itself`);
        }
    }
    topologicalOrder(new Set(Object.keys(graph.nodes)), graph.nodes);
    const expectedStages = { building: ["building-attestation"], final: ["attestation"] };
    if (JSON.stringify(graph.stages) !== JSON.stringify(expectedStages)) {
        throw new TypeError("Quality DAG stage roots are immutable");
    }
    const finalClosure = dependencyClosure(graph.stages.final, graph.nodes);
    const omitted = Object.keys(graph.nodes).filter(
        (node) => node !== "building-attestation" && !finalClosure.has(node)
    );
    if (omitted.length > 0) {
        throw new TypeError(`Final quality stage omits nodes: ${omitted.join(", ")}`);
    }
}

export function dependencyClosure(targets, nodes) {
    const selected = new Set();
    const add = (node) => {
        if (!Object.hasOwn(nodes, node)) throw new TypeError(`Unknown quality target ${node}`);
        if (selected.has(node)) return;
        selected.add(node);
        for (const dependency of nodes[node]) add(dependency);
    };
    for (const target of targets) add(target);
    return selected;
}

export function topologicalOrder(selected, nodes) {
    const order = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (node) => {
        if (!selected.has(node) || visited.has(node)) return;
        if (visiting.has(node)) throw new TypeError(`Quality DAG contains a cycle at ${node}`);
        visiting.add(node);
        for (const dependency of nodes[node]) visit(dependency);
        visiting.delete(node);
        visited.add(node);
        order.push(node);
    };
    for (const node of [...selected].sort()) visit(node);
    return order;
}

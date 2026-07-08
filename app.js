"use strict";

const META_URL = "site/graph_meta.json";
const DATA_DIR = "site/";
const CRITERIA = ["tiempo", "co2", "precio", "escalas"];
const CRITERION_LABELS = {
  tiempo: "tiempo",
  co2: "CO2",
  precio: "precio",
  escalas: "escalas",
};
const MENU_OPTIONS = {
  "1": "Mejores rutas (tiempo / CO2 / precio / escalas)",
  "2": "K rutas más cortas",
  "3": "Centralidad",
  "4": "Listar aeropuertos disponibles",
  "5": "Métricas de topología",
  "0": "Salir",
};

const graph = {
  meta: null,
  vertices: [],
  countries: [],
  indexByCode: new Map(),
  from: null,
  to: null,
  tiempo: null,
  co2: null,
  precio: null,
  escalas: null,
  pairCounts: [],
  uniqueAdj: [],
  inNeighbors: [],
  bestMaps: {},
  bestAdj: {},
};

const state = {
  ready: false,
  flow: null,
  history: [],
  historyIndex: 0,
  centrality: null,
  topology: null,
};

const el = {
  log: document.getElementById("terminalLog"),
  form: document.getElementById("terminalForm"),
  promptText: document.getElementById("promptText"),
  input: document.getElementById("terminalInput"),
};

const FLYBY_SIZE_CLASSES = ["flyby-small", "flyby-base", "flyby-large"];

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 1) return this.items.pop();
    const root = this.items[0];
    this.items[0] = this.items.pop();
    this.bubbleDown(0);
    return root;
  }

  less(a, b) {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }

  bubbleUp(index) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.less(this.items[index], this.items[parent])) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  bubbleDown(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.less(this.items[left], this.items[smallest])) smallest = left;
      if (right < this.items.length && this.less(this.items[right], this.items[smallest])) smallest = right;
      if (smallest === index) break;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}

function writeLine(text, className = "terminal-output") {
  const node = document.createElement("div");
  node.className = `terminal-entry ${className}`;
  node.textContent = Array.isArray(text) ? text.join("\n") : text;
  el.log.append(node);
  el.log.scrollTop = el.log.scrollHeight;
}

function writeCommand(command) {
  writeLine(`${el.promptText.textContent} ${command}`, "terminal-command");
}

function enableInput(enabled) {
  el.input.disabled = !enabled;
  el.input.placeholder = enabled ? "" : "loading graph...";
  if (enabled) el.input.focus();
}

function setupFlybyPlane() {
  const plane = document.querySelector(".flyby-plane");
  if (!plane) return;

  plane.addEventListener("animationiteration", () => {
    plane.classList.remove("flyby-first", ...FLYBY_SIZE_CLASSES);
    const nextClass = FLYBY_SIZE_CLASSES[Math.floor(Math.random() * FLYBY_SIZE_CLASSES.length)];
    plane.classList.add(nextClass);
  });
}

function setPrompt(text) {
  el.promptText.textContent = text;
}

function ask(text) {
  writeLine(text, "terminal-muted");
  setPrompt(">>>");
}

function menuLines() {
  return [
    "==================================================",
    " ECOSKY - Menú principal",
    "==================================================",
    ...Object.keys(MENU_OPTIONS)
      .sort()
      .map((key) => `  ${key}. ${MENU_OPTIONS[key]}`),
  ];
}

function showMenu() {
  state.flow = null;
  setPrompt(">>>");
  writeLine(menuLines());
}

async function loadGraph() {
  try {
    enableInput(false);
    writeLine("Booting EcoSky terminal...", "terminal-muted");

    const metaResponse = await fetch(new URL(META_URL, window.location.href), { cache: "no-store" });
    if (!metaResponse.ok) throw new Error(`Cannot load ${META_URL}`);
    const meta = await metaResponse.json();

    writeLine(`Loading ${formatInteger(meta.rows_used)} directed itineraries from full multigraph...`, "terminal-muted");

    const edgeUrl = new URL(`${DATA_DIR}${meta.edge_file}`, window.location.href);
    const edgeResponse = await fetch(edgeUrl, { cache: "no-store" });
    if (!edgeResponse.ok) throw new Error(`Cannot load ${edgeUrl.pathname}`);
    const edgeText = await edgeResponse.text();

    await new Promise((resolve) => requestAnimationFrame(resolve));
    buildGraph(meta, edgeText);

    state.ready = true;
    enableInput(true);

    el.log.textContent = "";
    showMenu();
  } catch (error) {
    writeLine([
      "Load failed.",
      error.message,
      "Run a local server from tp4: python3 -m http.server 8000",
      "Then open: http://127.0.0.1:8000/site-mari/",
    ], "terminal-error");
  }
}

function buildGraph(meta, edgeText) {
  graph.meta = meta;
  graph.vertices = meta.vertices;
  graph.countries = meta.countries || graph.vertices.map(() => "");
  graph.indexByCode = new Map(graph.vertices.map((code, index) => [code, index]));

  const lines = edgeText.trimEnd().split(/\r?\n/);
  const edgeCount = Math.max(0, lines.length - 1);
  graph.from = new Uint16Array(edgeCount);
  graph.to = new Uint16Array(edgeCount);
  graph.tiempo = new Float32Array(edgeCount);
  graph.co2 = new Float32Array(edgeCount);
  graph.precio = new Float32Array(edgeCount);
  graph.escalas = new Uint8Array(edgeCount);

  const n = graph.vertices.length;
  graph.pairCounts = Array.from({ length: n }, () => new Map());
  graph.inNeighbors = Array.from({ length: n }, () => new Set());
  graph.bestMaps = Object.fromEntries(CRITERIA.map((criterion) => [
    criterion,
    Array.from({ length: n }, () => new Map()),
  ]));

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const edgeId = lineIndex - 1;
    const parts = lines[lineIndex].split(",");
    const from = Number(parts[0]);
    const to = Number(parts[1]);

    graph.from[edgeId] = from;
    graph.to[edgeId] = to;
    graph.tiempo[edgeId] = Number(parts[2]);
    graph.co2[edgeId] = Number(parts[3]);
    graph.precio[edgeId] = Number(parts[4]);
    graph.escalas[edgeId] = Number(parts[5]);

    graph.pairCounts[from].set(to, (graph.pairCounts[from].get(to) || 0) + 1);
    graph.inNeighbors[to].add(from);

    for (const criterion of CRITERIA) {
      const cost = edgeWeight(edgeId, criterion);
      const current = graph.bestMaps[criterion][from].get(to);
      if (!current || cost < current.cost || (cost === current.cost && edgeId < current.edgeId)) {
        graph.bestMaps[criterion][from].set(to, { to, edgeId, cost });
      }
    }
  }

  graph.uniqueAdj = graph.pairCounts.map((destinations) =>
    [...destinations.keys()].sort((a, b) => idToCode(a).localeCompare(idToCode(b)))
  );

  graph.bestAdj = Object.fromEntries(CRITERIA.map((criterion) => [
    criterion,
    graph.bestMaps[criterion].map((destinations) =>
      [...destinations.values()].sort((a, b) => idToCode(a.to).localeCompare(idToCode(b.to)))
    ),
  ]));
}

function idToCode(id) {
  return graph.vertices[id];
}

function codeToId(code) {
  return graph.indexByCode.get(String(code).toUpperCase());
}

function edgeWeight(edgeId, criterion) {
  if (criterion === "tiempo") return graph.tiempo[edgeId];
  if (criterion === "co2") return graph.co2[edgeId];
  if (criterion === "precio") return graph.precio[edgeId];
  return graph.escalas[edgeId] + 1;
}

function bestEdge(from, to, criterion) {
  return graph.bestMaps[criterion][from].get(to) || null;
}

function pairKey(from, to) {
  return `${from}>${to}`;
}

function pathKey(path) {
  return path.join(">");
}

function dijkstra(origin, destination, criterion, blockedNodes = new Set(), blockedPairs = new Set()) {
  if (origin === undefined || destination === undefined || blockedNodes.has(origin) || blockedNodes.has(destination)) {
    return null;
  }

  const n = graph.vertices.length;
  const dist = new Float64Array(n);
  const prev = new Int16Array(n);
  dist.fill(Infinity);
  prev.fill(-1);
  dist[origin] = 0;

  const heap = new MinHeap();
  heap.push([0, origin]);

  while (heap.size) {
    const [cost, node] = heap.pop();
    if (cost !== dist[node]) continue;
    if (node === destination) break;

    for (const edge of graph.bestAdj[criterion][node]) {
      const next = edge.to;
      if (blockedNodes.has(next) || blockedPairs.has(pairKey(node, next))) continue;
      const nextCost = cost + edge.cost;
      if (nextCost < dist[next]) {
        dist[next] = nextCost;
        prev[next] = node;
        heap.push([nextCost, next]);
      }
    }
  }

  if (!Number.isFinite(dist[destination])) return null;

  const path = [];
  let current = destination;
  while (current !== origin) {
    path.push(current);
    current = prev[current];
    if (current < 0) return null;
  }
  path.push(origin);
  path.reverse();
  return { path, cost: dist[destination] };
}

function pathCost(path, criterion) {
  let total = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const edge = bestEdge(path[index], path[index + 1], criterion);
    if (!edge) return null;
    total += edge.cost;
  }
  return total;
}

function totalStops(path) {
  if (path.length <= 1) return 0;
  let total = 0;
  for (let index = 0; index < path.length - 1; index += 1) {
    const edge = bestEdge(path[index], path[index + 1], "escalas");
    if (!edge) return null;
    total += graph.escalas[edge.edgeId];
  }
  return total + path.length - 2;
}

function pathMetrics(path) {
  return {
    escalas: totalStops(path),
    tiempo: pathCost(path, "tiempo"),
    co2: pathCost(path, "co2"),
    precio: pathCost(path, "precio"),
  };
}

function kShortest(origin, destination, k, criterion) {
  const first = dijkstra(origin, destination, criterion);
  if (!first) return [];

  const accepted = [first];
  const acceptedKeys = new Set([pathKey(first.path)]);
  const candidates = [];

  while (accepted.length < k) {
    const lastPath = accepted[accepted.length - 1].path;

    for (let index = 0; index < lastPath.length - 1; index += 1) {
      const root = lastPath.slice(0, index + 1);
      const spur = root[root.length - 1];
      const blockedNodes = new Set(root.slice(0, -1));
      const blockedPairs = new Set();

      for (const acceptedRoute of accepted) {
        const path = acceptedRoute.path;
        if (path.length > index + 1 && root.every((node, nodeIndex) => node === path[nodeIndex])) {
          blockedPairs.add(pairKey(path[index], path[index + 1]));
        }
      }

      const spurRoute = dijkstra(spur, destination, criterion, blockedNodes, blockedPairs);
      if (!spurRoute) continue;

      const totalPath = root.slice(0, -1).concat(spurRoute.path);
      const key = pathKey(totalPath);
      if (acceptedKeys.has(key) || candidates.some((item) => pathKey(item.path) === key)) continue;

      const cost = pathCost(totalPath, criterion);
      if (cost !== null) candidates.push({ path: totalPath, cost });
    }

    if (!candidates.length) break;
    candidates.sort((a, b) => a.cost - b.cost || pathKey(a.path).localeCompare(pathKey(b.path)));
    const next = candidates.shift();
    accepted.push(next);
    acceptedKeys.add(pathKey(next.path));
  }

  return accepted;
}

function handleCommand(rawCommand) {
  if (!state.ready) {
    writeLine("Graph is still loading.", "terminal-muted");
    return;
  }

  const command = rawCommand.trim();
  if (!command) {
    if (state.flow && ["criterion", "k"].includes(state.flow.step)) {
      handleFlowInput(command);
    }
    return;
  }

  if (state.flow) {
    handleFlowInput(command);
    return;
  }

  handleMenuOption(command);
}

function handleMenuOption(option) {
  if (option === "0") {
    writeLine("¡Buen viaje!");
    enableInput(false);
    return;
  }

  if (option === "1") {
    state.flow = { option: "1", step: "origin" };
    ask("  Origen (código IATA):");
    return;
  }

  if (option === "2") {
    state.flow = { option: "2", step: "origin" };
    ask("  Origen (código IATA):");
    return;
  }

  if (option === "3") {
    writeCentrality();
    showMenu();
    return;
  }

  if (option === "4") {
    writeAirports("");
    showMenu();
    return;
  }

  if (option === "5") {
    writeTopology();
    showMenu();
    return;
  }

  writeLine("  Opción inválida.");
  showMenu();
}

function handleFlowInput(command) {
  const flow = state.flow;

  if (flow.step === "origin") {
    const origin = normalizeAirportCode(command);
    if (!validateAirport(origin)) return;
    flow.origin = origin;
    flow.step = "destination";
    ask("  Destino (código IATA):");
    return;
  }

  if (flow.step === "destination") {
    const destination = normalizeAirportCode(command);
    if (!validateAirport(destination)) return;
    flow.destination = destination;

    if (flow.option === "1") {
      writeBestRoutes(flow.origin, flow.destination);
      showMenu();
      return;
    }

    flow.step = "criterion";
    ask("  Criterio (1=tiempo 2=CO2 3=precio 4=escalas) [1]:");
    return;
  }

  if (flow.step === "criterion") {
    flow.criterion = {
      "1": "tiempo",
      "2": "co2",
      "3": "precio",
      "4": "escalas",
    }[command.trim()] || "tiempo";
    flow.step = "k";
    ask("  ¿Cuántas rutas (K)? [3]:");
    return;
  }

  if (flow.step === "k") {
    const raw = command.trim();
    const k = /^\d+$/.test(raw) ? Number(raw) : 3;
    writeKRoutes(flow.origin, flow.destination, flow.criterion, k);
    showMenu();
  }
}

function normalizeAirportCode(value) {
  return String(value).trim().toUpperCase();
}

function validateAirport(code) {
  if (graph.indexByCode.has(code)) return true;
  const ejemplos = graph.vertices.slice().sort((a, b) => a.localeCompare(b)).slice(0, 20).join(", ");
  writeLine(`  '${code}' no está en la red. Algunos disponibles: ${ejemplos} ...`);
  return false;
}

function findAirportCodes(tokens) {
  const found = [];
  for (const token of tokens) {
    const cleaned = token.toUpperCase().replace(/[^A-Z]/g, "");
    if (cleaned.length === 3 && graph.indexByCode.has(cleaned) && !found.includes(cleaned)) {
      found.push(cleaned);
    }
  }
  return found;
}

function findCriterion(lower) {
  if (lower.includes("co2") || lower.includes("eco")) return "co2";
  if (lower.includes("precio") || lower.includes("barat") || lower.includes("price")) return "precio";
  if (lower.includes("escala") || lower.includes("stop")) return "escalas";
  return "tiempo";
}

function writeHelp() {
  writeLine([
    "Commands:",
    "  mejores AEP GRU",
    "  ruta AEP GRU tiempo",
    "  ruta AEP GRU co2",
    "  k AEP GRU precio 3",
    "  info AEP",
    "  aeropuertos",
    "  centralidad",
    "  topologia",
    "  datos",
    "  clear",
  ]);
}

function writeDataset() {
  writeLine([
    "EcoSky dataset",
    `  source: ${graph.meta.source}`,
    `  airports: ${graph.vertices.length}`,
    `  directed itineraries: ${formatInteger(graph.from.length)}`,
    `  discarded rows: ${formatInteger(graph.meta.rows_discarded || 0)}`,
    `  currency: ${graph.meta.currency || "-"}`,
    "  model: directed weighted multigraph with parallel edges",
  ]);
}

function writeAirports(filterText) {
  const needle = filterText.trim().toLowerCase();
  const rows = graph.vertices
    .map((code, id) => ({
      code,
      country: graph.countries[id] || "país desconocido",
      out: graph.uniqueAdj[id].length,
      incoming: graph.inNeighbors[id].size,
    }))
    .filter((row) => !needle || row.code.toLowerCase().includes(needle) || row.country.toLowerCase().includes(needle))
    .sort((a, b) => a.code.localeCompare(b.code));

  if (!rows.length) {
    writeLine("No airports match that filter.", "terminal-muted");
    return;
  }

  writeLine([
    `  ${rows.length} aeropuertos`,
    ...rows.map((row) => `    ${row.code.padEnd(4)} -> ${row.country}`),
  ]);
}

function writeAirportInfo(code) {
  const id = codeToId(code);
  if (id === undefined) {
    writeLine(`Unknown airport: ${code}`, "terminal-error");
    return;
  }

  const destinations = [...graph.pairCounts[id].entries()]
    .map(([to, count]) => ({ code: idToCode(to), count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 8);

  writeLine([
    `${code}`,
    `  country: ${graph.countries[id] || "-"}`,
    `  direct destinations: ${graph.uniqueAdj[id].length}`,
    `  direct origins: ${graph.inNeighbors[id].size}`,
    "  strongest outgoing pairs:",
    ...(destinations.length
      ? destinations.map((item) => `    ${code} -> ${item.code}: ${formatInteger(item.count)} parallel itineraries`)
      : ["    none"]),
  ]);
}

function writeRoute(originCode, destinationCode, criterion) {
  const origin = codeToId(originCode);
  const destination = codeToId(destinationCode);
  const route = dijkstra(origin, destination, criterion);

  if (!route) {
    writeLine(`No route from ${originCode} to ${destinationCode}.`, "terminal-muted");
    return;
  }

  writeLine(formatRouteBlock(`Ruta por ${CRITERION_LABELS[criterion]}`, route.path, criterion));
}

function writeBestRoutes(originCode, destinationCode) {
  const origin = codeToId(originCode);
  const destination = codeToId(destinationCode);
  const labels = [
    ["Menos escalas", "escalas"],
    ["Más rápida", "tiempo"],
    ["Ecológica", "co2"],
    ["Más barata", "precio"],
  ];

  const lines = [`[Mejores rutas] ${originCode} -> ${destinationCode}`];
  let any = false;
  for (const [label, criterion] of labels) {
    const route = dijkstra(origin, destination, criterion);
    if (!route) continue;
    any = true;
    lines.push("");
    lines.push(...formatRouteBlock(label, route.path, criterion));
  }

  writeLine(any ? lines : `No route from ${originCode} to ${destinationCode}.`, any ? "terminal-output" : "terminal-muted");
}

function writeKRoutes(originCode, destinationCode, criterion, k) {
  const origin = codeToId(originCode);
  const destination = codeToId(destinationCode);
  const limitedK = Math.max(1, Math.min(8, k || 3));
  const routes = kShortest(origin, destination, limitedK, criterion);

  if (!routes.length) {
    writeLine(`No route from ${originCode} to ${destinationCode}.`, "terminal-muted");
    return;
  }

  const lines = [`[K rutas] mejores por ${CRITERION_LABELS[criterion]}: ${originCode} -> ${destinationCode}`];
  routes.forEach((route, index) => {
    lines.push("");
    lines.push(...formatRouteBlock(`Route ${index + 1}`, route.path, criterion));
  });
  writeLine(lines);
}

function formatRouteBlock(title, path, criterion) {
  const metrics = pathMetrics(path);
  const codes = path.map(idToCode);
  return [
    `  >> ${title}`,
    `     ${codes.join(" -> ")}`,
    `      Costo (${criterion}): ${formatCost(pathCost(path, criterion), criterion)}`,
    `      Escalas: ${metrics.escalas} | Tiempo: ${formatMinutes(metrics.tiempo)} | CO2: ${formatInteger(Math.round(metrics.co2))} kg | Precio: ${formatInteger(Math.round(metrics.precio))} ${graph.meta.currency || ""}`.trim(),
    `      Aristas paralelas: ${formatParallelCounts(path)}`,
  ];
}

function formatParallelCounts(path) {
  if (path.length < 2) return "-";
  return path
    .slice(0, -1)
    .map((from, index) => {
      const to = path[index + 1];
      return `${idToCode(from)}>${idToCode(to)}:${formatInteger(graph.pairCounts[from].get(to) || 0)}`;
    })
    .join(" | ");
}

function writeCentrality() {
  if (!state.centrality) state.centrality = centrality();
  const values = state.centrality;
  writeLine([
    "[Centralidad]",
    "",
    "  Top GRADO DE SALIDA (mayores distribuidores):",
    ...values.out.slice(0, 5).map(([code, value]) => `    ${code} -> ${value} destinos directos`),
    "",
    "  Top GRADO DE ENTRADA (destinos más populares):",
    ...values.incoming.slice(0, 5).map(([code, value]) => `    ${code} <- ${value} orígenes directos`),
    "",
    "  Closeness (cercanía; distancia = escalas + aristas):",
    ...values.close.slice(0, 5).map(([code, value]) => `    ${code} -> ${value.toFixed(4)}`),
    "",
    `  Hubs críticos (Betweenness aprox., ${values.samples} pares):`,
    ...(values.betweenness.length
      ? values.betweenness.slice(0, 5).map(([code, value]) => `    ${code} -> aparece como escala en ${value} rutas mínimas`)
      : ["    (no se registraron nodos intermedios)"]),
  ]);
}

function centrality() {
  const ids = graph.vertices.map((_, index) => index);
  const out = ids
    .map((id) => [idToCode(id), graph.uniqueAdj[id].length])
    .sort(rankSort);
  const incoming = ids
    .map((id) => [idToCode(id), graph.inNeighbors[id].size])
    .sort(rankSort);

  const close = ids
    .map((id) => {
      let reachable = 0;
      let totalDistance = 0;
      for (const other of ids) {
        if (other === id) continue;
        const route = dijkstra(id, other, "escalas");
        if (!route) continue;
        reachable += 1;
        totalDistance += route.cost;
      }
      const score = reachable && totalDistance
        ? (reachable / (ids.length - 1)) * (reachable / totalDistance)
        : 0;
      return [idToCode(id), score];
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const between = Object.fromEntries(graph.vertices.map((code) => [code, 0]));
  const rng = seededRandom(42);
  const samples = 300;
  for (let sample = 0; sample < samples; sample += 1) {
    const from = Math.floor(rng() * ids.length);
    let to = Math.floor(rng() * ids.length);
    if (to === from) to = (to + 1) % ids.length;
    const route = dijkstra(from, to, "tiempo");
    if (!route || route.path.length < 3) continue;
    for (const middle of route.path.slice(1, -1)) between[idToCode(middle)] += 1;
  }

  const betweenness = Object.entries(between)
    .filter(([, value]) => value > 0)
    .sort(rankSort);

  return { out, incoming, close, betweenness, samples };
}

function writeTopology() {
  if (!state.topology) state.topology = topology();
  const values = state.topology;
  writeLine([
    "[Métricas de topología]",
    `  Componentes fuertemente conexas: ${values.components.length} (${values.components.filter((component) => component.length === 1).length} de un solo aeropuerto).`,
    `  Mayor componente: ${values.largest.length} aeropuertos.`,
    "",
    "  Distancia usada: ESCALAS + ARISTAS (stops de la ruta + nº de tramos).",
    `    Diámetro : ${values.diameter}`,
    `    Radio    : ${values.radius}`,
    `    Centro    : ${values.center.join(", ") || "-"}`,
    `    Periferia : ${values.periphery.join(", ") || "-"}`,
    "",
    "  Coeficiente de agrupamiento (clustering, no dirigido):",
    `    Promedio de la red: ${values.clustering.average.toFixed(4)}`,
  ]);
}

function topology() {
  const components = stronglyConnectedComponents();
  const largest = [...components].sort((a, b) =>
    b.length - a.length || idToCode(a[0]).localeCompare(idToCode(b[0]))
  )[0] || [];
  const eccentricities = {};

  for (const node of largest) {
    let maxDistance = 0;
    for (const other of largest) {
      const route = dijkstra(node, other, "escalas");
      if (!route) {
        maxDistance = Infinity;
        break;
      }
      if (route.cost > maxDistance) maxDistance = route.cost;
    }
    eccentricities[idToCode(node)] = maxDistance;
  }

  const finite = Object.values(eccentricities).filter(Number.isFinite);
  const diameter = finite.length ? Math.max(...finite) : null;
  const radius = finite.length ? Math.min(...finite) : null;
  const center = Object.entries(eccentricities).filter(([, value]) => value === radius).map(([node]) => node);
  const periphery = Object.entries(eccentricities).filter(([, value]) => value === diameter).map(([node]) => node);
  const clustering = clusteringCoefficient(largest);

  return { components, largest, eccentricities, diameter, radius, center, periphery, clustering };
}

function stronglyConnectedComponents() {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const components = [];

  function visit(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.uniqueAdj[node]) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }

    if (low.get(node) === indices.get(node)) {
      const component = [];
      let item;
      do {
        item = stack.pop();
        onStack.delete(item);
        component.push(item);
      } while (item !== node);
      components.push(component.sort((a, b) => idToCode(a).localeCompare(idToCode(b))));
    }
  }

  graph.vertices.forEach((_, node) => {
    if (!indices.has(node)) visit(node);
  });
  return components;
}

function clusteringCoefficient(nodes) {
  const local = {};
  for (const node of nodes) {
    const neighbors = new Set(graph.uniqueAdj[node]);
    graph.inNeighbors[node].forEach((incoming) => neighbors.add(incoming));
    neighbors.delete(node);
    const values = [...neighbors].sort((a, b) => idToCode(a).localeCompare(idToCode(b)));
    const k = values.length;
    if (k < 2) {
      local[idToCode(node)] = 0;
      continue;
    }

    let links = 0;
    for (let i = 0; i < values.length; i += 1) {
      for (let j = i + 1; j < values.length; j += 1) {
        if (hasEdge(values[i], values[j]) || hasEdge(values[j], values[i])) links += 1;
      }
    }
    local[idToCode(node)] = (2 * links) / (k * (k - 1));
  }
  const values = Object.values(local);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return { local, average };
}

function hasEdge(from, to) {
  return graph.pairCounts[from].has(to);
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return function next() {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function rankSort(a, b) {
  return b[1] - a[1] || a[0].localeCompare(b[0]);
}

function formatCost(value, criterion) {
  if (criterion === "tiempo") return formatMinutes(value);
  if (criterion === "co2") return `${formatInteger(Math.round(value))} kg`;
  if (criterion === "precio") return `${formatInteger(Math.round(value))} ${graph.meta.currency || ""}`.trim();
  return String(value);
}

function formatMinutes(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value % 60);
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function formatInteger(value) {
  return Number(value).toLocaleString("en-US");
}

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = el.input.value.trim();
  const acceptsDefault = state.flow && ["criterion", "k"].includes(state.flow.step);
  if (!command && !acceptsDefault) return;
  writeCommand(command);
  if (command) {
    state.history.push(command);
    state.historyIndex = state.history.length;
  }
  el.input.value = "";
  handleCommand(command);
});

el.input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!state.history.length) return;
    state.historyIndex = Math.max(0, state.historyIndex - 1);
    el.input.value = state.history[state.historyIndex] || "";
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!state.history.length) return;
    state.historyIndex = Math.min(state.history.length, state.historyIndex + 1);
    el.input.value = state.history[state.historyIndex] || "";
  }
});

document.addEventListener("click", () => {
  if (state.ready) el.input.focus();
});

setupFlybyPlane();
loadGraph();

import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {Impact, MemoryEntry, Session, Task} from '../../shared/types.ts';
import {isOpen, useAlign, useNow} from './state.ts';
import {AgentMark} from './ui.tsx';

const NODE_H = 52;
const PILL_H = 24;
const ROW_GAP = 14;
const PILL_GAP = 10;
const NODE_W_MIN = 124;
const NODE_W_MAX = 200;
const COLUMN_GAP_MIN = 36;
const COLUMN_GAP_MAX = 112;
const NODE_W_COMFORT = 156;
const COLUMN_GAP_COMFORT = 44;
const HERO_W_MIN = 520;
const MAX_TASK_ROWS = 8;
const MAX_PILL_ROWS = 10;
const PILL_KEY_MAX = 150;
const RECENT_MS = 5 * 60_000;

const TITLE_FONT = '500 12px "Inter Variable", system-ui, sans-serif';
const PILL_FONT = '500 11px "Inter Variable", system-ui, sans-serif';

const canvas = document.createElement('canvas').getContext('2d')!;

function textWidth(text: string, font: string): number {
  canvas.font = font;
  return canvas.measureText(text).width;
}

function fit(text: string, font: string, max: number): string {
  if (textWidth(text, font) <= max) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textWidth(text.slice(0, mid) + '…', font) <= max) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low).trimEnd() + '…';
}

type TaskNode = {kind: 'task'; id: string; task: Task; w: number; h: number; x: number; y: number};
type PillNode = {kind: 'decision'; id: string; key: string; label: string; version: number; w: number; h: number; x: number; y: number};
type GraphNode = TaskNode | PillNode;
type EdgeState = 'open' | 'adapted' | 'idle';
type Edge = {id: string; state: EdgeState; path: string};

function taskDepths(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depths = new Map<string, number>();
  const visit = (task: Task, path: Set<string>): number => {
    const known = depths.get(task.id);
    if (known !== undefined) return known;
    if (path.has(task.id)) return 0;
    path.add(task.id);
    let depth = 0;
    for (const dep of task.dependsOn) {
      const other = byId.get(dep);
      if (other) depth = Math.max(depth, visit(other, path) + 1);
    }
    path.delete(task.id);
    depths.set(task.id, depth);
    return depth;
  };
  for (const task of tasks) visit(task, new Set());
  return depths;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Barycenter sweeps: orders each column by the average position of its neighbors. */
function reduceCrossings(columns: GraphNode[][], links: {from: string; to: string}[]): void {
  const neighbors = new Map<string, string[]>();
  const connect = (a: string, b: string) => neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
  for (const {from, to} of links) {
    connect(from, to);
    connect(to, from);
  }
  const position = new Map<string, number>();
  const place = (column: GraphNode[]) => column.forEach((n, i) => position.set(n.id, (i + 0.5) / column.length));
  columns.forEach(place);

  const sweep = (ordered: GraphNode[][]) => {
    for (const column of ordered) {
      const score = new Map(
        column.map((n) => {
          const near = neighbors.get(n.id) ?? [];
          return [n.id, near.length ? near.reduce((sum, id) => sum + position.get(id)!, 0) / near.length : position.get(n.id)!];
        }),
      );
      column.sort((a, b) => score.get(a.id)! - score.get(b.id)!);
      place(column);
    }
  };
  for (let round = 0; round < 3; round++) {
    sweep(columns);
    sweep([...columns].reverse());
  }
}

function edgeStates(impacts: Impact[], now: number): Map<string, EdgeState> {
  const states = new Map<string, EdgeState>();
  for (const impact of impacts) {
    const id = `${impact.source === 'decision' ? 'd' : 't'}:${impact.sourceKey}>t:${impact.taskId}`;
    if (isOpen(impact.state)) states.set(id, 'open');
    else if (impact.state === 'adapted' && impact.resolvedAt && now - impact.resolvedAt < RECENT_MS && !states.has(id)) states.set(id, 'adapted');
  }
  return states;
}

function layout(tasks: Task[], memory: MemoryEntry[], impacts: Impact[], width: number, now: number) {
  const versions = new Map(memory.map((m) => [m.key, m.version]));
  const keys = [...new Set([...memory.filter((m) => m.kind === 'decision').map((m) => m.key), ...tasks.flatMap((t) => t.decisions.map((d) => d.key))])].sort();
  if (tasks.length === 0 && keys.length === 0) return null;

  const pills: GraphNode[] = keys.map((key) => {
    const version = versions.get(key) ?? 0;
    const label = fit(key, PILL_FONT, PILL_KEY_MAX);
    const w = Math.ceil(textWidth(label, PILL_FONT) + (version ? textWidth(`v${version}`, PILL_FONT) + 7 : 0) + 20);
    return {kind: 'decision', id: `d:${key}`, key, label, version, w, h: PILL_H, x: 0, y: 0};
  });

  const sorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt);
  const known = new Set(sorted.map((t) => t.id));
  const depths = taskDepths(sorted);
  const deepest = Math.max(-1, ...depths.values());
  const taskNodes = new Map<number, GraphNode[]>();
  for (let depth = 0; depth <= deepest; depth++) taskNodes.set(depth, []);
  for (const task of sorted) taskNodes.get(depths.get(task.id)!)!.push({kind: 'task', id: `t:${task.id}`, task, w: 0, h: NODE_H, x: 0, y: 0});

  const links: {from: string; to: string}[] = [];
  for (const task of sorted) {
    for (const dep of task.dependsOn) if (known.has(dep)) links.push({from: `t:${dep}`, to: `t:${task.id}`});
    for (const link of task.decisions) links.push({from: `d:${link.key}`, to: `t:${task.id}`});
  }

  const columns = [...chunk(pills, MAX_PILL_ROWS), ...[...taskNodes.values()].flatMap((nodes) => chunk(nodes, MAX_TASK_ROWS))];
  reduceCrossings(columns, links);

  const isPills = (column: GraphNode[]) => column[0].kind === 'decision';
  const pillColumnWidth = (column: GraphNode[]) => Math.max(...column.map((n) => n.w));
  const pillColumns = columns.filter(isPills);
  const taskColumns = columns.length - pillColumns.length;
  const pillsWidth = pillColumns.reduce((sum, c) => sum + pillColumnWidth(c), 0);
  const gaps = columns.length - 1;

  const nodeW = Math.floor(Math.min(NODE_W_MAX, Math.max(NODE_W_MIN, (width - pillsWidth - gaps * COLUMN_GAP_MIN) / Math.max(1, taskColumns))));
  const free = width - pillsWidth - nodeW * taskColumns;
  const gap = gaps > 0 ? Math.floor(Math.min(COLUMN_GAP_MAX, Math.max(COLUMN_GAP_MIN, free / gaps))) : 0;
  const totalWidth = pillsWidth + nodeW * taskColumns + gap * gaps;

  const columnHeight = (column: GraphNode[]) => {
    const spacing = isPills(column) ? PILL_GAP : ROW_GAP;
    return column.reduce((sum, n) => sum + n.h, 0) + spacing * (column.length - 1);
  };
  const height = Math.max(...columns.map(columnHeight)) + 2;

  let x = Math.max(0, Math.floor((width - totalWidth) / 2));
  for (const column of columns) {
    const pill = isPills(column);
    const columnW = pill ? pillColumnWidth(column) : nodeW;
    let y = Math.floor((height - columnHeight(column)) / 2);
    for (const node of column) {
      if (!pill) node.w = nodeW;
      node.x = x + columnW - node.w;
      node.y = y;
      y += node.h + (pill ? PILL_GAP : ROW_GAP);
    }
    x += columnW + gap;
  }

  const nodes = columns.flat();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const states = edgeStates(impacts, now);
  const edges: Edge[] = links.flatMap(({from, to}) => {
    const a = nodeById.get(from);
    const b = nodeById.get(to);
    if (!a || !b) return [];
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const bend = Math.max(24, (x2 - x1) / 2);
    const id = `${from}>${to}`;
    return [{id, state: states.get(id) ?? 'idle', path: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`}];
  });
  // Highlighted edges paint last so idle hairlines never cross over them.
  const rank: Record<EdgeState, number> = {idle: 0, adapted: 1, open: 2};
  edges.sort((a, b) => rank[a.state] - rank[b.state]);

  const basis = Math.max(HERO_W_MIN, pillsWidth + NODE_W_COMFORT * taskColumns + COLUMN_GAP_COMFORT * gaps);
  return {nodes, edges, width: Math.max(width, totalWidth), height, basis};
}

type Tone = Session['status'] | 'done' | 'blocked' | 'planned';

function taskTone(task: Task, session: Session | undefined): Tone {
  if (task.status !== 'in_progress') return task.status;
  return session?.taskId === task.id ? session.status : 'idle';
}

function ToneGlyph({tone, x, y}: {tone: Tone; x: number; y: number}) {
  if (tone === 'done') return <path className="g-check" d={`M${x - 4} ${y}l2.8 2.8 4.8-5.3`} aria-label="done" />;
  if (tone === 'planned' || tone === 'blocked') return <circle className={`g-ring ${tone}`} cx={x} cy={y} r={3.5} aria-label={tone} />;
  return <circle className={`g-dot s-${tone}`} cx={x} cy={y} r={3.5} aria-label={tone} />;
}

function TaskBox({node}: {node: TaskNode}) {
  const {lookup} = useAlign();
  const {task, x, y, w} = node;
  return (
    <a className={`g-task${task.status === 'done' ? ' done' : ''}`} href={`#/s/${task.sessionId}`} aria-label={task.title}>
      <title>{task.title}</title>
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={NODE_H - 1} rx={9} />
      <AgentMark agent={task.agent} x={x + 11} y={y + 12} />
      <text className="g-title" x={x + 29} y={y + 22}>
        {fit(task.title, TITLE_FONT, w - 54)}
      </text>
      <text className="g-sub" x={x + 29} y={y + 39}>
        {lookup.developers.get(task.developerId)?.name}
      </text>
      <ToneGlyph tone={taskTone(task, lookup.sessions.get(task.sessionId))} x={x + w - 15} y={y + 18} />
    </a>
  );
}

function DecisionPill({node, title, hot}: {node: PillNode; title: string; hot: boolean}) {
  const {x, y, w, h} = node;
  return (
    <g className={`g-pill${hot ? ' hot' : ''}`}>
      <title>{title}</title>
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={(h - 1) / 2} />
      <text className="g-key" x={x + 10} y={y + 16}>
        {node.label}
      </text>
      {node.version > 0 && (
        <text className="g-version" x={x + w - 10} y={y + 16} textAnchor="end">
          v{node.version}
        </text>
      )}
    </g>
  );
}

export function Graph() {
  const {snapshot} = useAlign();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [, refit] = useState(0);
  const now = useNow(30_000);

  useLayoutEffect(() => {
    const el = box.current!;
    setWidth(Math.floor(el.clientWidth));
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Node sizes come from canvas text metrics, which change once Inter has loaded.
  useEffect(() => {
    let alive = true;
    void document.fonts.ready.then(() => {
      if (alive) refit((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  const graph = layout(snapshot.tasks, snapshot.memory, snapshot.impacts, width, now);
  const titles = new Map(snapshot.memory.map((m) => [m.key, m.title]));
  const hotKeys = new Set(snapshot.impacts.filter((i) => i.source === 'decision' && isOpen(i.state)).map((i) => i.sourceKey));

  return (
    <div className="graph" ref={box} style={graph ? {flexBasis: graph.basis} : undefined}>
      {graph && (
        <svg width={graph.width} height={graph.height} role="img" aria-label="Graph">
          {graph.edges.map((edge) => (
            <path key={edge.id} className={`edge ${edge.state}`} d={edge.path} />
          ))}
          {graph.nodes.map((node) =>
            node.kind === 'task' ? (
              <TaskBox key={node.id} node={node} />
            ) : (
              <DecisionPill key={node.id} node={node} title={titles.get(node.key) ?? node.key} hot={hotKeys.has(node.key)} />
            ),
          )}
        </svg>
      )}
    </div>
  );
}
